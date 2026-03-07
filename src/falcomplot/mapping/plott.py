"""
falcomplot.mapping.plott
=================
Builds interactive Leaflet maps from GeoDataFrames of any facility type.

Public API
----------
Two separate functions cover the two steps of building a map:

:func:`build_basemap`
    Create a Leaflet basemap with an optional boundary polygon layer.
    Returns a ``folium.Map`` with nothing else on it.

:func:`add_markers`
    Add ``CircleMarker`` layers to an existing map from a facilities
    GeoDataFrame, together with an interactive filter legend and a
    source/sub-type toggle panel.

Typical usage
-------------
::

    import plott

    # 1. Basemap only
    m = plott.build_basemap(boundary)

    # 2. Basemap + markers in one go
    m = plott.build_basemap(boundary)
    plott.add_markers(m, facilities, categories=MY_CATEGORIES)

    m.save("interactive_map.html")

Defining categories
-------------------
Pass any ``dict[str, dict]`` as ``categories`` to :func:`add_markers`.
Each key is the string that appears in the ``"category"`` column of your
facilities GeoDataFrame.  Each value must have:

===========  =================================================
Key          Type / meaning
===========  =================================================
``color``    Hex color string used for the circle marker.
``radius``   Integer pixel radius of the circle marker.
``order``    Integer used to sort legend entries (ascending).
===========  =================================================

Example::

    MY_CATEGORIES = {
        "Library":        {"color": "#2196F3", "radius": 6, "order": 0},
        "Community Center": {"color": "#4CAF50", "radius": 5, "order": 1},
        "Police Station": {"color": "#F44336", "radius": 7, "order": 2},
    }

A default set of health-facility categories is provided as
:data:`HEALTH_CATEGORIES` and used when no ``categories`` argument is given.

GeoDataFrame contract for ``add_markers``
-----------------------------------------
``facilities`` must have at minimum:

============  ===================================================================
Column        Description
============  ===================================================================
``geometry``  Shapely ``Point`` in EPSG:4326 (lon/lat).
``category``  Must match a key in the ``categories`` dict passed to the function.
``source``    Data-source label shown in the filter legend (e.g. ``"HRSA"``).
============  ===================================================================

The following optional columns are consumed by the tooltip / popup builders.
All *other* columns are displayed as a sorted key/value table in the popup.

=================================  ============================================
Column                             Used for
=================================  ============================================
``name`` / ``Site Name``           Facility display name.
``mua_name``                       Fallback name for HRSA MUA records.
``business_status``                Operational status (Google Places).
``Site Status Description``        Operational status (HRSA).
``icon``                           URL of a small icon shown in the tooltip.
``photos``                         Raw Google Places photos list (stringified).
``raw_types_str``                  Comma-separated Google place-type string.
``amenity`` / ``healthcare``       OSM tags used for sub-type resolution.
``services``                       Chicago Data Portal services field.
``hrsa_subtype``                   ``"FQHC"`` or ``"FQHC Look-Alike"``.
``desig_type``                     HRSA MUA designation type string.
=================================  ============================================

Constants
---------
:data:`HEALTH_CATEGORIES` – default category → style mapping for health facilities.
"""

import json
import pickle
import re
from pathlib import Path
import folium
import geopandas as gpd
import numpy as np


# ──────────────────────────────────────────────────────────────────────────────
# DEFAULT CATEGORY DEFINITIONS  (health facilities)
# ──────────────────────────────────────────────────────────────────────────────

HEALTH_CATEGORIES: dict[str, dict] = {
    "Hospital – Public": {
        "color":  "#E63946",
        "radius": 7,
        "order":  0,
    },
    "Hospital – Private / Non-profit": {
        "color":  "#FF6B35",
        "radius": 7,
        "order":  1,
    },
    "Primary Care Center – Public (FQHC / CHC)": {
        "color":  "#2A9D8F",
        "radius": 5,
        "order":  2,
    },
    "Primary Care Center – Private / Non-profit": {
        "color":  "#457B9D",
        "radius": 4,
        "order":  3,
    },
    "Urgent Care / Walk-in Clinic": {
        "color":  "#F4A261",
        "radius": 4,
        "order":  4,
    },
    "HRSA – FQHC / Health Center": {
        "color":  "#6A0572",
        "radius": 6,
        "order":  5,
    },
    "HRSA – Medically Underserved Area": {
        "color":  "#B5179E",
        "radius": 5,
        "order":  6,
    },
}

# Keep the old name as an alias so existing code doesn't break.
CATEGORIES = HEALTH_CATEGORIES


# ──────────────────────────────────────────────────────────────────────────────
# VALUE HELPER
# ──────────────────────────────────────────────────────────────────────────────

def _val(row: dict, key: str) -> str | None:
    """Safely retrieve a non-empty, non-NaN string value from a row dict."""
    try:
        v = row.get(key, None)
        if v is None:
            return None
        if isinstance(v, float) and np.isnan(v):
            return None
        s = str(v).strip()
        return s if s and s.lower() not in ("nan", "none", "") else None
    except Exception:
        return None


# ──────────────────────────────────────────────────────────────────────────────
# POPUP / TOOLTIP BUILDERS
# ──────────────────────────────────────────────────────────────────────────────

def _build_header_html(name: str, icon: str | None, color: str = "#e63946") -> str:
    """Colored header bar with optional icon."""
    icon_html = (f'<img src="{icon}" style="width:20px;height:20px;'
                 f'margin-right:10px;vertical-align:middle;">') if icon else ""
    return (
        f'<div style="font-weight:bold;color:#fff;background:{color};'
        f'padding:10px;border-radius:8px 8px 0 0;margin:-10px -10px 10px -10px;'
        f'font-size:14px;display:flex;align-items:center;">'
        f'{icon_html}<span>{name}</span></div>'
    )


def _build_photo_html(row: dict, google_api_key: str) -> str:
    """Return an <img> block if a Google Places photo reference is present."""
    photos_raw = row.get("photos", None)
    if not (photos_raw and isinstance(photos_raw, str) and "photo_reference" in photos_raw):
        return ""
    match = re.search(r"'photo_reference':\s*'([^']+)'", photos_raw) or \
            re.search(r'"photo_reference":\s*"([^"]+)"', photos_raw)
    if not match or not google_api_key:
        return ""
    ref = match.group(1)
    url = (f"https://maps.googleapis.com/maps/api/place/photo"
           f"?maxwidth=400&photoreference={ref}&key={google_api_key}")
    return (f'<div style="text-align:center;margin-bottom:15px;">'
            f'<img src="{url}" style="max-width:100%;border-radius:8px;'
            f'box-shadow:0 2px 8px rgba(0,0,0,0.1);"></div>')


def _build_table_html(row: dict, exclusions: set) -> str:
    """Build a two-column key/value table from row fields."""
    rows_html = ""
    for k in sorted(row.keys()):
        if k in exclusions:
            continue
        val_str = str(row[k]).strip()
        if not val_str or val_str.lower() in ("nan", "none", ""):
            continue
        display_val = val_str if len(val_str) < 150 else val_str[:147] + "…"
        rows_html += (
            f'<tr style="border-bottom:1px solid #f0f0f0;">'
            f'<td style="color:#777;padding:4px 8px 4px 0;white-space:nowrap;'
            f'font-weight:600;font-size:11px;">{k}</td>'
            f'<td style="color:#111;word-break:break-all;font-size:11px;'
            f'padding:4px 0;">{display_val}</td></tr>'
        )
    return f'<table style="width:100%;border-collapse:collapse;">{rows_html}</table>'


def format_hover_summary(row: dict) -> str:
    """Return compact HTML for the mouse-over tooltip.

    Renders a small card with the facility name, operational status, and
    category label.  An icon ``<img>`` is prepended when the row contains an
    ``icon`` URL (Google Places records).

    Parameters
    ----------
    row:
        A single facility record as a plain ``dict`` (i.e. one row of the
        facilities GeoDataFrame converted with ``dict(row)``).

    Returns
    -------
    str
        Self-contained HTML fragment suitable for ``folium.Tooltip``.
    """
    name   = _val(row, "name") or _val(row, "Site Name") or _val(row, "mua_name") or "Unknown"
    status = _val(row, "business_status") or _val(row, "Site Status Description") or "Active"
    icon   = _val(row, "icon")
    cat    = _val(row, "category") or "Facility"

    icon_html = (f'<img src="{icon}" style="width:16px;height:16px;'
                 f'margin-right:8px;vertical-align:middle;">') if icon else ""
    return f"""
    <div style="font-family:'Segoe UI',Tahoma,sans-serif;font-size:12px;
                padding:8px;background:#fff;border-radius:4px;">
      <div style="font-weight:bold;margin-bottom:4px;">{icon_html}{name}</div>
      <div style="color:#666;font-size:10px;"><b>Status:</b> {status}</div>
      <div style="color:#e63946;font-size:10px;font-weight:bold;margin-top:2px;">{cat}</div>
    </div>"""


def format_full_raw_popup(row: dict, google_api_key: str = "") -> str:
    """Return full-detail HTML for the click popup.

    Renders a scrollable card with:

    1. A colored header bar showing the facility name and optional icon.
    2. A photo pulled from the Google Places Photos API (only when
       ``source == "Google Places"`` and ``google_api_key`` is provided).
    3. A two-column key/value table of every non-empty field not in the
       internal exclusion set for that source.

    Source-specific fields that are redundant or administrative are
    automatically hidden (e.g. FIPS codes, congressional district IDs,
    internal HRSA surrogate keys).

    Parameters
    ----------
    row:
        A single facility record as a plain ``dict``.
    google_api_key:
        Google Places API key used to construct the photo URL.
        Omit (or pass ``""``) to skip photo loading.

    Returns
    -------
    str
        Self-contained HTML fragment suitable for ``folium.Popup``.
    """
    src  = _val(row, "source")
    name = (_val(row, "name") or _val(row, "Site Name") or
            _val(row, "mua_name") or "Details")
    icon = _val(row, "icon")

    exclusions = {"geometry"}
    if src == "Google Places":
        exclusions |= {"scope", "icon", "icon_background_color",
                       "icon_mask_base_uri", "name", "reference"}
    if src == "HRSA":
        exclusions |= {
            "State FIPS Code", "State Name", "State Abbreviation",
            "State and County Federal Information Processing Standard Code",
            "County or County Equivalent Federal Information Processing Standard Code",
            "County Description", "County Subdivision Name", "County Subdivision FIPS Code",
            "HHS Region Code", "HHS Region Name",
            "Primary HHS Region Code", "Primary HHS Region Name",
            "Primary State FIPS Code", "Primary State Abbreviation", "Primary State Name",
            "Common Region Code", "Common Region Name",
            "Common State Name", "Common State Abbreviation", "Common State FIPS Code",
            "Common State County FIPS Code", "Common County Name",
            "U.S. - Mexico Border 100 Kilometer Indicator",
            "U.S. - Mexico Border County Indicator",
            "Rural Status Code",
            "MUA/P Status Code", "MUA/P Update Date", "MUA/P Update Date String",
            "MUA/P Designation Date String", "Break in Designation",
            "MUA/P Population Type Code",
            "Medically Underserved Area/Population (MUA/P) Metropolitan Indicator",
            "Medically Underserved Area/Population (MUA/P) Component Geographic Type Code",
            "Medically Underserved Area/Population (MUA/P) Withdrawal Date",
            "Medically Underserved Area/Population (MUA/P) Withdrawal Date in Text Format",
            "Data Warehouse Record Create Date",
            "Unnamed: 64", "Unnamed: 55",
            "Site State Abbreviation", "State FIPS and Congressional District Number Code",
            "Congressional District Number", "Congressional District Name",
            "Congressional District Code", "U.S. Congressional Representative Name",
            "Name of U.S. Senator Number One", "Name of U.S. Senator Number Two",
            "Health Center Operating Calendar Surrogate Key",
            "Health Center Operator Identification Number",
            "Health Center Operating Schedule Identification Number",
            "Health Center Location Identification Number",
            "Health Center Location Setting Identification Number",
            "Health Center Type Identification Number",
            "Health Center Status Identification Number",
            "BHCMIS Organization Identification Number",
        }

    header = _build_header_html(name, icon)
    photo  = _build_photo_html(row, google_api_key) if src == "Google Places" else ""
    table  = _build_table_html(row, exclusions)

    return f"""
    <div style="font-family:'Segoe UI',Tahoma,sans-serif;min-width:300px;
                max-width:400px;max-height:450px;overflow-y:auto;padding:10px;">
      {header}
      {photo}
      {table}
    </div>"""


# ──────────────────────────────────────────────────────────────────────────────
# SUB-TYPE RESOLVER
# ──────────────────────────────────────────────────────────────────────────────

def _resolve_subtype(row: dict) -> str:
    """Determine the legend sub-type label for a feature row."""
    src = row.get("source", "")
    cat = row.get("category", "")

    if src == "OpenStreetMap":
        return _val(row, "amenity") or _val(row, "healthcare") or "Facility"

    if src == "Chicago Data Portal":
        desc = _val(row, "services") or ""
        return desc.split(",")[0].split("(")[0].strip() or "Clinic"

    if src == "Google Places":
        ts = _val(row, "raw_types_str") or ""
        if ts:
            filtered = [t.replace("_", " ").title()
                        for t in ts.split(", ")
                        if t not in ("point of interest", "establishment", "health")]
            if filtered:
                return filtered[0]
        return "Provider"

    if src == "HRSA":
        if cat == "HRSA – Medically Underserved Area":
            return _val(row, "desig_type") or "Medically Underserved Area"
        return _val(row, "hrsa_subtype") or "FQHC"

    # Generic fallback: use the category label itself as the sub-type
    return cat or "Facility"


# ──────────────────────────────────────────────────────────────────────────────
# LEGEND & JAVASCRIPT
# ──────────────────────────────────────────────────────────────────────────────

def _build_legend_html(unique_sources: list[str], default_source: str) -> str:
    """Return the HTML for the filter panel (data-source selector + sub-type list)."""
    src_opts = "".join(
        f'<option value="{s}" {"selected" if s == default_source else ""}>{s}</option>'
        for s in unique_sources
    )
    return f"""
    <div id="fp-legend" style="position:fixed;bottom:40px;left:20px;z-index:900;
         background:white;padding:15px;border-radius:12px;
         box-shadow:0 10px 25px rgba(0,0,0,0.1);
         font-family:sans-serif;min-width:280px;">
      <div style="font-weight:bold;border-bottom:2px solid #e63946;margin-bottom:10px;">
        Filter
      </div>
      <div style="font-size:10px;color:#999;margin-bottom:5px;">SOURCE</div>
      <select id="fp-src-select" style="width:100%;margin-bottom:15px;"
              onchange="fpUpdateLegend()">{src_opts}</select>
      <div style="font-size:10px;color:#999;margin-bottom:5px;">TYPES</div>
      <div id="fp-cat-list" style="max-height:200px;overflow-y:auto;"></div>
      <div id="fp-summary" style="margin-top:10px;font-size:11px;color:#666;
           text-align:right;"></div>
    </div>"""


def _build_filter_js(marker_data: list[dict]) -> str:
    """Return the <script> block that drives source/type filtering."""
    return f"""
    <script>
    (function() {{
        var fpMarkers = {json.dumps(marker_data)};
        var fpDisabled = new Set();

        setTimeout(function() {{
            var mapObj = null;
            for (var k in window) {{
                if (k.startsWith('map_') && window[k] instanceof L.Map) {{
                    mapObj = window[k]; break;
                }}
            }}
            if (!mapObj) return;

            window.fpLayers = {{}};
            fpMarkers.forEach(m => {{ if (window[m.id]) window.fpLayers[m.id] = window[m.id]; }});

            window.fpToggleType = function(t) {{
                if (fpDisabled.has(t)) fpDisabled.delete(t); else fpDisabled.add(t);
                fpApplyFilters();
            }};

            window.fpUpdateLegend = function() {{
                var src = document.getElementById('fp-src-select').value;
                var tm = {{}}, pool = [];
                fpMarkers.forEach(m => {{
                    if (m.src === src) {{
                        if (!tm[m.type]) {{ tm[m.type] = {{ c: 0, col: m.color }}; pool.push(m.type); }}
                        tm[m.type].c++;
                    }}
                }});
                var html = "";
                pool.sort().forEach(t => {{
                    var off = fpDisabled.has(t);
                    html += `<div style="display:flex;align-items:center;margin:3px 0;
                              cursor:pointer;opacity:${{off ? 0.4 : 1}}"
                              onclick="fpToggleType('${{t}}')">
                      <span style="width:8px;height:8px;border-radius:50%;
                            background:${{tm[t].col}};margin-right:8px;"></span>
                      <span style="font-size:11px;flex:1">${{t}}</span>
                      <span style="font-size:10px;color:#999">${{tm[t].c}}</span>
                    </div>`;
                }});
                document.getElementById('fp-cat-list').innerHTML = html;
                fpApplyFilters();
            }};

            window.fpApplyFilters = function() {{
                var src = document.getElementById('fp-src-select').value;
                var count = 0;
                fpMarkers.forEach(m => {{
                    var l = window.fpLayers[m.id]; if (!l) return;
                    var visible = (m.src === src && !fpDisabled.has(m.type));
                    if (visible) {{ if (!mapObj.hasLayer(l)) l.addTo(mapObj); count++; }}
                    else         {{ if (mapObj.hasLayer(l))  l.remove(); }}
                }});
                document.getElementById('fp-summary').innerText = count + ' visible';

                var items = document.getElementById('fp-cat-list').children;
                for (var i = 0; i < items.length; i++) {{
                    var m2 = items[i].getAttribute('onclick').match(/'([^']+)'/);
                    if (m2) items[i].style.opacity = fpDisabled.has(m2[1]) ? 0.4 : 1;
                }}
            }};

            fpUpdateLegend();
        }}, 1000);
    }})();
    </script>"""


# ──────────────────────────────────────────────────────────────────────────────
# PUBLIC API
# ──────────────────────────────────────────────────────────────────────────────

def build_basemap(
    boundary: gpd.GeoDataFrame | str | Path | None = None,
    *,
    center: tuple[float, float] = (41.8375, -87.6866),
    zoom: int = 11,
    tiles: str = "CartoDB Positron",
) -> folium.Map:
    """Create a Leaflet basemap, optionally with a boundary polygon layer.

    Parameters
    ----------
    boundary:
        GeoDataFrame of region boundary polygons, or a path (``str`` /
        ``pathlib.Path``) to a boundary file (``.pkl``, ``.geojson``,
        ``.shp``, ``.gpkg``, etc.).  When provided, the geometry is dissolved
        into one shape and simplified (tolerance 0.002°).  Pass ``None`` to skip.
    center:
        ``(lat, lon)`` for the initial map viewport.
    zoom:
        Initial Leaflet zoom level (1–20).
    tiles:
        Folium tile layer name or URL template.  Default is CartoDB Positron.

    Returns
    -------
    folium.Map
        A bare map with the base tile layer and, if supplied, the boundary
        polygon.  Pass this to :func:`add_markers` to add facility markers.

    Examples
    --------
    ::

        m = build_basemap(boundary, center=(41.84, -87.69), zoom=12)
        m.save("basemap.html")
    """
    m = folium.Map(location=list(center), zoom_start=zoom, tiles=tiles)

    if isinstance(boundary, (str, Path)):
        p = Path(boundary)
        if p.suffix == ".pkl":
            with open(p, "rb") as fh:
                boundary = pickle.load(fh)
        else:
            boundary = gpd.read_file(p)
        if boundary.crs is None or boundary.crs.to_epsg() != 4326:
            boundary = boundary.to_crs("EPSG:4326")

    if boundary is not None and not boundary.empty:
        simplified = boundary.dissolve().simplify(0.002)
        folium.GeoJson(
            simplified,
            style_function=lambda _: {
                "fillColor": "#dde4ec", "color": "#9aaabb",
                "weight": 0.5, "fillOpacity": 0.25,
            },
        ).add_to(m)

    return m


def add_markers(
    m: folium.Map,
    facilities: gpd.GeoDataFrame,
    *,
    categories: dict[str, dict] | None = None,
    default_source: str | None = None,
    google_api_key: str = "",
) -> folium.Map:
    """Add facility markers and an interactive filter legend to a map.

    Iterates ``facilities`` and places a ``CircleMarker`` for every row whose
    ``"category"`` value is a key in ``categories``.  Rows with an empty or
    unrecognised geometry are skipped.

    A filter legend is injected into the map's HTML.  It lets users:

    - Switch between data sources via a ``<select>`` dropdown.
    - Toggle individual sub-types on/off by clicking color-coded rows.

    The legend and JavaScript use the ``"fp-"`` prefix for all DOM IDs and
    global function names to avoid collisions with other scripts.

    Parameters
    ----------
    m:
        A ``folium.Map`` instance, typically produced by :func:`build_basemap`.
    facilities:
        GeoDataFrame of facility points.  Required columns: ``geometry``,
        ``category``, ``source``.  See module docstring for optional columns.
    categories:
        ``dict[str, dict]`` mapping each category label to a style dict with
        keys ``color`` (hex string), ``radius`` (int), and ``order`` (int).
        Rows whose ``"category"`` is not in this dict are silently skipped.
        Defaults to :data:`HEALTH_CATEGORIES` when ``None``.
    default_source:
        The data-source label pre-selected in the filter legend on first load.
        Defaults to the first source in alphabetical order when ``None``.
    google_api_key:
        Google Places API key forwarded to :func:`format_full_raw_popup` for
        rendering place photos inside popups.  Leave empty to skip photos.

    Returns
    -------
    folium.Map
        The same ``m`` passed in, mutated in place with markers and the legend.

    Raises
    ------
    KeyError
        If ``facilities`` is missing the required ``"source"`` column.

    Examples
    --------
    ::

        CATEGORIES = {
            "Library":    {"color": "#2196F3", "radius": 6, "order": 0},
            "Park":       {"color": "#4CAF50", "radius": 5, "order": 1},
        }

        m = build_basemap(boundary)
        add_markers(m, facilities, categories=CATEGORIES, default_source="Library")
        m.save("interactive_map.html")
    """
    cats = categories if categories is not None else HEALTH_CATEGORIES

    marker_data: list[dict] = []
    for _, row in facilities.iterrows():
        cat = row.get("category", "")
        cfg = cats.get(cat)
        if not cfg or not row.geometry or row.geometry.is_empty:
            continue

        row_dict   = dict(row)
        sub_type   = _resolve_subtype(row_dict)
        hover_html = format_hover_summary(row_dict)
        click_html = format_full_raw_popup(row_dict, google_api_key)

        marker = folium.CircleMarker(
            location=[row.geometry.y, row.geometry.x],
            radius=cfg["radius"],
            color=cfg["color"],
            fill=True,
            fill_color=cfg["color"],
            fill_opacity=0.8,
            weight=1.0,
            tooltip=folium.Tooltip(hover_html, sticky=False),
            popup=folium.Popup(click_html, max_width=450),
        ).add_to(m)

        marker_data.append({
            "id":    marker.get_name(),
            "src":   row.get("source", ""),
            "type":  sub_type,
            "color": cfg["color"],
        })

    unique_sources = sorted(facilities["source"].dropna().unique())
    src = default_source if default_source in unique_sources else unique_sources[0]

    m.get_root().html.add_child(folium.Element(_build_legend_html(unique_sources, src)))
    m.get_root().html.add_child(folium.Element(_build_filter_js(marker_data)))

    return m
