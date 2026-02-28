"""
Chicago Health Facilities Interactive Map
=========================================
Modular visualization: hover summaries, click popups, filter legend.
Sources: OpenStreetMap · Chicago Data Portal · Google Places · HRSA
"""

import webbrowser
import json
import ast
import re
from pathlib import Path
import folium
import geopandas as gpd
import numpy as np

import call_data

# ──────────────────────────────────────────────────────────────────────────────
# CATEGORY DEFINITIONS
# ──────────────────────────────────────────────────────────────────────────────

CATEGORIES = {
    # ── Standard facility categories (all sources) ──
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
    # ── HRSA-specific categories ──
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

# ──────────────────────────────────────────────────────────────────────────────
# VALUE HELPER
# ──────────────────────────────────────────────────────────────────────────────

def _val(row, key):
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


def _build_photo_html(row) -> str:
    """Return an <img> block if a Google Places photo reference is present."""
    photos_raw = row.get("photos", None)
    if not (photos_raw and isinstance(photos_raw, str) and "photo_reference" in photos_raw):
        return ""
    match = re.search(r"'photo_reference':\s*'([^']+)'", photos_raw) or \
            re.search(r'"photo_reference":\s*"([^"]+)"', photos_raw)
    if not match:
        return ""
    ref = match.group(1)
    url = (f"https://maps.googleapis.com/maps/api/place/photo"
           f"?maxwidth=400&photoreference={ref}&key={call_data.GOOGLE_API_KEY}")
    return (f'<div style="text-align:center;margin-bottom:15px;">'
            f'<img src="{url}" style="max-width:100%;border-radius:8px;'
            f'box-shadow:0 2px 8px rgba(0,0,0,0.1);"></div>')


def _build_table_html(row, exclusions: set) -> str:
    """Build a two-column key/value table from row fields."""
    rows_html = ""
    for k in sorted(row.keys()):
        if k in exclusions:
            continue
        v = row[k]
        val_str = str(v).strip()
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


def format_hover_summary(row) -> str:
    """Concise HTML for the mouse-over tooltip."""
    name   = _val(row, "name") or _val(row, "Site Name") or _val(row, "mua_name") or "Unknown Facility"
    status = _val(row, "business_status") or _val(row, "Site Status Description") or "Active"
    icon   = _val(row, "icon")
    cat    = _val(row, "category") or "Health Facility"

    icon_html = (f'<img src="{icon}" style="width:16px;height:16px;'
                 f'margin-right:8px;vertical-align:middle;">') if icon else ""
    return f"""
    <div style="font-family:'Segoe UI',Tahoma,sans-serif;font-size:12px;
                padding:8px;background:#fff;border-radius:4px;">
      <div style="font-weight:bold;margin-bottom:4px;">{icon_html}{name}</div>
      <div style="color:#666;font-size:10px;"><b>Status:</b> {status}</div>
      <div style="color:#e63946;font-size:10px;font-weight:bold;margin-top:2px;">{cat}</div>
    </div>"""


def format_full_raw_popup(row) -> str:
    """Full-detail click popup with header, optional photo, and key/value table."""
    src  = _val(row, "source")
    name = (_val(row, "name") or _val(row, "Site Name") or
            _val(row, "mua_name") or "Facility Details")
    icon = _val(row, "icon")

    # Fields to hide from the table
    exclusions = {"geometry"}
    if src == "Google Places":
        exclusions |= {"scope", "icon", "icon_background_color",
                       "icon_mask_base_uri", "name", "reference"}
    if src == "HRSA":
        # Drop FIPS / region codes / date duplicates / border flags / unnamed cols
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
            "U.S. - Mexico Border 100 Kilometer Indicator",
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
            # Health Center duplicates
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

    header  = _build_header_html(name, icon)
    photo   = _build_photo_html(row) if src == "Google Places" else ""
    table   = _build_table_html(row, exclusions)

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

def _resolve_subtype(row) -> str:
    """Determine the legend sub-type label for a feature row."""
    src = row.get("source", "")
    cat = row.get("category", "")

    if src == "OpenStreetMap":
        return _val(row, "amenity") or _val(row, "healthcare") or "Health Facility"

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
        return "Medical Provider"

    if src == "HRSA":
        if cat == "HRSA – Medically Underserved Area":
            return _val(row, "desig_type") or "Medically Underserved Area"
        return _val(row, "hrsa_subtype") or "FQHC"

    return "Health Facility"


# ──────────────────────────────────────────────────────────────────────────────
# LEGEND & JAVASCRIPT
# ──────────────────────────────────────────────────────────────────────────────

def _build_legend_html(unique_sources: list[str]) -> str:
    """Return the HTML for the filter panel (data-source selector + sub-type list)."""
    src_opts = "".join(
        f'<option value="{s}" {"selected" if s == "Google Places" else ""}>{s}</option>'
        for s in unique_sources
    )
    return f"""
    <div id="health-legend" style="position:fixed;bottom:40px;left:20px;z-index:900;
         background:white;padding:15px;border-radius:12px;
         box-shadow:0 10px 25px rgba(0,0,0,0.1);
         font-family:sans-serif;min-width:280px;">
      <div style="font-weight:bold;border-bottom:2px solid #e63946;margin-bottom:10px;">
        Filter Facilities
      </div>
      <div style="font-size:10px;color:#999;margin-bottom:5px;">DATA SOURCE</div>
      <select id="src-select" style="width:100%;margin-bottom:15px;"
              onchange="updateLegend()">{src_opts}</select>
      <div style="font-size:10px;color:#999;margin-bottom:5px;">SUB-TYPES</div>
      <div id="dynamic-cat-list" style="max-height:200px;overflow-y:auto;"></div>
      <div id="total-summary" style="margin-top:10px;font-size:11px;color:#666;
           text-align:right;"></div>
    </div>"""


def _build_filter_js(marker_data: list[dict]) -> str:
    """Return the <script> block that drives source/type filtering."""
    return f"""
    <script>
    (function() {{
        var markers = {json.dumps(marker_data)};
        var disabled = new Set();

        setTimeout(function() {{
            // Find the Leaflet map instance
            var mapObj = null;
            for (var k in window) {{
                if (k.startsWith('map_') && window[k] instanceof L.Map) {{
                    mapObj = window[k]; break;
                }}
            }}
            if (!mapObj) return;

            // Index Leaflet layer objects by marker id
            window.layers = {{}};
            markers.forEach(m => {{ if (window[m.id]) window.layers[m.id] = window[m.id]; }});

            window.toggleType = function(t) {{
                if (disabled.has(t)) disabled.delete(t); else disabled.add(t);
                applyFilters();
            }};

            window.updateLegend = function() {{
                var src = document.getElementById('src-select').value;
                var tm = {{}}, pool = [];
                markers.forEach(m => {{
                    if (m.src === src) {{
                        if (!tm[m.type]) {{ tm[m.type] = {{ c: 0, col: m.color }}; pool.push(m.type); }}
                        tm[m.type].c++;
                    }}
                }});
                var html = "";
                pool.sort().forEach(t => {{
                    var off = disabled.has(t);
                    html += `<div style="display:flex;align-items:center;margin:3px 0;
                              cursor:pointer;opacity:${{off ? 0.4 : 1}}"
                              onclick="toggleType('${{t}}')">
                      <span style="width:8px;height:8px;border-radius:50%;
                            background:${{tm[t].col}};margin-right:8px;"></span>
                      <span style="font-size:11px;flex:1">${{t}}</span>
                      <span style="font-size:10px;color:#999">${{tm[t].c}}</span>
                    </div>`;
                }});
                document.getElementById('dynamic-cat-list').innerHTML = html;
                applyFilters();
            }};

            window.applyFilters = function() {{
                var src = document.getElementById('src-select').value;
                var count = 0;
                markers.forEach(m => {{
                    var l = window.layers[m.id]; if (!l) return;
                    var visible = (m.src === src && !disabled.has(m.type));
                    if (visible) {{ if (!mapObj.hasLayer(l)) l.addTo(mapObj); count++; }}
                    else         {{ if (mapObj.hasLayer(l))  l.remove(); }}
                }});
                document.getElementById('total-summary').innerText = count + " visible";

                // Sync opacity of legend items
                var items = document.getElementById('dynamic-cat-list').children;
                for (var i = 0; i < items.length; i++) {{
                    var m2 = items[i].getAttribute('onclick').match(/'([^']+)'/);
                    if (m2) items[i].style.opacity = disabled.has(m2[1]) ? 0.4 : 1;
                }}
            }};

            updateLegend();
        }}, 1000);
    }})();
    </script>"""


# ──────────────────────────────────────────────────────────────────────────────
# MAP BUILDER
# ──────────────────────────────────────────────────────────────────────────────

def _add_city_boundary(m: folium.Map, chicago: gpd.GeoDataFrame) -> None:
    """
    Add a dissolved + simplified Chicago boundary layer to the map.
    Dissolving 39k census blocks into one polygon first, then simplifying,
    reduces the embedded GeoJSON from ~11 MB to ~3 KB.
    """
    boundary = chicago.dissolve().simplify(0.002)
    folium.GeoJson(
        boundary,
        style_function=lambda _: {
            "fillColor": "#dde4ec", "color": "#9aaabb",
            "weight": 0.5, "fillOpacity": 0.25,
        },
    ).add_to(m)


def _add_markers(m: folium.Map, facilities: gpd.GeoDataFrame) -> list[dict]:
    """
    Add CircleMarkers for every valid facility row.
    Returns a list of dicts used for JavaScript-side filtering.
    """
    marker_data = []
    for _, row in facilities.iterrows():
        cat = row.get("category", "")
        cfg = CATEGORIES.get(cat)
        if not cfg or not row.geometry or row.geometry.is_empty:
            continue

        sub_type   = _resolve_subtype(row)
        hover_html = format_hover_summary(row)
        click_html = format_full_raw_popup(row)
        src        = row.get("source", "")

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
            "src":   src,
            "type":  sub_type,
            "color": cfg["color"],
        })
    return marker_data


def build_map(chicago: gpd.GeoDataFrame, facilities: gpd.GeoDataFrame) -> folium.Map:
    """Assemble the full interactive Leaflet map."""
    m = folium.Map(location=[41.8375, -87.6866], zoom_start=11, tiles="CartoDB Positron")

    _add_city_boundary(m, chicago)

    marker_data   = _add_markers(m, facilities)
    unique_sources = sorted(facilities["source"].unique())

    legend_html = _build_legend_html(unique_sources)
    m.get_root().html.add_child(folium.Element(legend_html))

    filter_js = _build_filter_js(marker_data)
    m.get_root().html.add_child(folium.Element(filter_js))

    return m


# ──────────────────────────────────────────────────────────────────────────────
# MAIN
# ──────────────────────────────────────────────────────────────────────────────

def main():
    print("  Loading Chicago boundary …")
    chicago = call_data.load_data()

    print("  Fetching facility data …")
    facilities = call_data.fetch_all()
    print(f"  Total markers: {len(facilities)}")

    # Category summary
    for cat, grp in facilities.groupby("category"):
        print(f"    {cat}: {len(grp)}")

    print("  Building map …")
    m = build_map(chicago, facilities)

    output = Path(__file__).parent / "chicago_health_map.html"
    m.save(str(output))
    print(f"  ✓ Map saved → {output}  ({output.stat().st_size / 1024 / 1024:.1f} MB)")


if __name__ == "__main__":
    main()
