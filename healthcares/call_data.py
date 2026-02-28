"""
Data fetching and caching logic for Chicago health facilities.
Sources: OpenStreetMap, Chicago Data Portal, Google Places, HRSA (Health Centers + MUAs).
"""

import pickle
import json
from pathlib import Path
import time
import requests
import geopandas as gpd
import pandas as pd
import numpy as np
import osmnx as ox
from shapely.geometry import Point, box, MultiPolygon, Polygon

# ──────────────────────────────────────────────────────────────────────────────
# DATA DIRECTORY
# ──────────────────────────────────────────────────────────────────────────────

DATA_DIR = Path(__file__).parent / "data"
DATA_DIR.mkdir(parents=True, exist_ok=True)

# OSM operator-type strings that indicate public/government operation
PUBLIC_OPERATOR_KEYWORDS = {
    "cook county", "stroger", "provident", "ui health",
    "u of i hospital", "uic medical", "university of illinois",
    "veterans affairs", "va hospital", "jesse brown",
    "chicago department of public health", "cdph",
}

CHICAGO_BBOX = box(-87.9401, 41.6443, -87.5237, 42.0230)
PLACE = "Chicago, Illinois, USA"

# FIPS codes for filtering
COOK_COUNTY_FIPS = "17031"
STATE_FIPS = "17"
COUNTY_FIPS = "031"


# ──────────────────────────────────────────────────────────────────────────────
# HELPERS
# ──────────────────────────────────────────────────────────────────────────────

def _is_public(row) -> bool:
    """Return True if the row's operator / operator:type (or name) suggests public funding."""
    for field in ("operator:type", "operator", "healthcare:operator", "name"):
        val = str(row.get(field, "")).lower()
        if any(kw in val for kw in PUBLIC_OPERATOR_KEYWORDS):
            return True
    return False


def _empty_gdf() -> gpd.GeoDataFrame:
    """Return an empty GeoDataFrame with a geometry column so concat works."""
    return gpd.GeoDataFrame(geometry=gpd.GeoSeries([], crs="EPSG:4326"), crs="EPSG:4326")


def _sanitize_gdf(gdf: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    """Convert list/dict columns to strings for GeoJSON serialization."""
    for col in gdf.columns:
        if col == "geometry":
            continue
        if gdf[col].apply(lambda x: isinstance(x, (list, dict))).any():
            gdf[col] = gdf[col].apply(lambda x: str(x) if isinstance(x, (list, dict)) else x)
    return gdf


# ──────────────────────────────────────────────────────────────────────────────
# OSM
# ──────────────────────────────────────────────────────────────────────────────

def fetch_osm() -> gpd.GeoDataFrame:
    """Fetch OSM data and preserve ALL raw tags."""
    cache_file = DATA_DIR / "osm.geojson"
    if cache_file.exists():
        print(f"  [Cache] Loading OSM data from {cache_file.name} …", end=" ", flush=True)
        gdf = gpd.read_file(cache_file)
        print(len(gdf))
        return gdf

    print("  [OSM] Fetching hospitals + primary care centres …", end=" ", flush=True)
    tags = {
        "amenity":    ["hospital", "clinic", "doctors"],
        "healthcare": ["hospital", "centre", "clinic", "urgent_care"],
    }
    try:
        gdf = ox.features_from_place(PLACE, tags=tags)
    except Exception as exc:
        print(f"err: {exc}")
        return _empty_gdf()

    if gdf.empty:
        print("0")
        return _empty_gdf()

    # Reproject just for centroid accuracy, then back to 4326
    gdf = gdf.to_crs("EPSG:3857")
    gdf["geometry"] = gdf.geometry.centroid
    gdf = gdf.to_crs("EPSG:4326")
    gdf = gdf[gdf.geometry.notna() & ~gdf.geometry.is_empty].copy()

    records = []
    for _, row in gdf.iterrows():
        amenity    = str(row.get("amenity",    "")).lower()
        healthcare = str(row.get("healthcare", "")).lower()
        is_pub     = _is_public(row)

        if "hospital" in (amenity, healthcare):
            cat = "Hospital – Public" if is_pub else "Hospital – Private / Non-profit"
        elif "urgent_care" in healthcare:
            cat = "Urgent Care / Walk-in Clinic"
        else:
            cat = "Primary Care Center – Public (FQHC / CHC)" if is_pub \
                  else "Primary Care Center – Private / Non-profit"

        data = {**dict(row), "category": cat, "source": "OpenStreetMap"}
        records.append(data)

    result = gpd.GeoDataFrame(records, crs="EPSG:4326")
    if not result.empty:
        result = _sanitize_gdf(result)
        result.to_file(cache_file, driver="GeoJSON")
    print(len(result))
    return result


# ──────────────────────────────────────────────────────────────────────────────
# CHICAGO DATA PORTAL
# ──────────────────────────────────────────────────────────────────────────────

def fetch_chicago_official() -> gpd.GeoDataFrame:
    """Fetch Chicago Data Portal clinics and preserve EVERY original field."""
    cache_file = DATA_DIR / "chicago_official.geojson"
    if cache_file.exists():
        print(f"  [Cache] Loading Chicago Official data from {cache_file.name} …", end=" ", flush=True)
        gdf = gpd.read_file(cache_file)
        print(len(gdf))
        return gdf

    print("  [Chicago Data Portal] Neighborhood health clinics …", end=" ", flush=True)
    url = "https://data.cityofchicago.org/resource/mw69-m6xi.json?$limit=10000"
    try:
        resp = requests.get(url, timeout=20)
        resp.raise_for_status()
        rows = resp.json()
        records = []
        for r in rows:
            loc = r.get("location", {})
            lat = loc.get("latitude") or r.get("latitude")
            lon = loc.get("longitude") or r.get("longitude")
            if not lat or not lon:
                continue

            records.append({
                **r,
                "category": "Primary Care Center – Public (FQHC / CHC)",
                "source":   "Chicago Data Portal",
                "geometry": Point(float(lon), float(lat)),
            })
        gdf = gpd.GeoDataFrame(records, crs="EPSG:4326")
        if not gdf.empty:
            gdf = _sanitize_gdf(gdf)
            gdf.to_file(cache_file, driver="GeoJSON")
        print(len(gdf))
        return gdf
    except Exception as exc:
        print(f"err: {exc}")
        return _empty_gdf()


# ──────────────────────────────────────────────────────────────────────────────
# GOOGLE PLACES
# ──────────────────────────────────────────────────────────────────────────────

GOOGLE_API_KEY = "xxx"

# Google Place types that indicate a hospital-level facility
HOSPITAL_PLACE_TYPES = {"hospital"}
# Primary care: doctor type is reliable for primary care
PRIMARY_CARE_TYPES   = {"doctor"}


def _categorize_google_place(name: str, types: list[str]) -> str | None:
    """
    Classify a Google Places entry into one of our 5 categories, or None to exclude.

    Kept categories:
      - Hospital – Public / Private
      - Primary Care Center – Public / Private
      - Urgent Care / Walk-in Clinic

    Excluded: dentists, pharmacies, physiotherapists, parking, spas, finance, etc.
    """
    name_lower = name.lower()
    types_set  = set(types)

    # ── Exclusions ──────────────────────────────────────────
    # Types with no primary-care / hospital relevance
    EXCLUDE_TYPES = {"dentist", "pharmacy", "physiotherapist", "parking",
                     "spa", "finance", "store"}
    if types_set & EXCLUDE_TYPES and not (types_set & {"hospital", "doctor", "health"}):
        return None

    # ── Urgent Care (name-based, takes priority) ─────────────
    URGENT_KEYWORDS = {"urgent care", "immediate care", "walk-in", "walk in",
                       "expresscare", "minuteclinic", "quickcare"}
    if any(kw in name_lower for kw in URGENT_KEYWORDS):
        return "Urgent Care / Walk-in Clinic"

    # ── Hospital ─────────────────────────────────────────────
    if types_set & HOSPITAL_PLACE_TYPES:
        # Only classify as "hospital" if the name clearly contains hospital/medical center terms
        HOSPITAL_NAME_TERMS = {"hospital", "medical center", "medical ctr", "health system", "healthcare system"}
        is_named_hospital = any(t in name_lower for t in HOSPITAL_NAME_TERMS)
        if is_named_hospital:
            is_pub = _is_public({"name": name, "operator": ""})
            return "Hospital – Public" if is_pub else "Hospital – Private / Non-profit"
        # Has hospital type but name doesn't say hospital → treat as primary care
        is_pub = _is_public({"name": name, "operator": ""})
        return "Primary Care Center – Public (FQHC / CHC)" if is_pub \
               else "Primary Care Center – Private / Non-profit"

    # ── Primary Care (doctor type or explicit keywords) ──────
    if types_set & PRIMARY_CARE_TYPES:
        is_pub = _is_public({"name": name, "operator": ""})
        return "Primary Care Center – Public (FQHC / CHC)" if is_pub \
               else "Primary Care Center – Private / Non-profit"

    # ── Generic health / point-of-interest ───────────────────
    # Require health type and a primary-care keyword in the name
    PRIMARY_CARE_NAME_TERMS = {
        "clinic", "health center", "health centre", "family medicine",
        "internal medicine", "primary care", "community health",
        "family health", "medical group", "physicians", "physician",
        "medical office", "care center", "pediatric", "women's health",
    }
    if "health" in types_set and any(t in name_lower for t in PRIMARY_CARE_NAME_TERMS):
        is_pub = _is_public({"name": name, "operator": ""})
        return "Primary Care Center – Public (FQHC / CHC)" if is_pub \
               else "Primary Care Center – Private / Non-profit"

    # Fall through → exclude (too generic or irrelevant)
    return None


def fetch_google_places_all() -> gpd.GeoDataFrame:
    """Load Google Places from cache (already downloaded) and apply improved categorization."""
    cache_file = DATA_DIR / "google_places_cache.geojson"
    if not cache_file.exists():
        print("  [Google Places] No cache found – please run the API fetch manually.")
        return _empty_gdf()

    print(f"  [Cache] Loading Google Places data from {cache_file.name} …", end=" ", flush=True)
    try:
        gdf = gpd.read_file(cache_file)
    except Exception as e:
        print(f"err loading cache: {e}")
        return _empty_gdf()

    # Re-classify using improved logic (no API call)
    import ast
    records = []
    for _, row in gdf.iterrows():
        types_raw = row.get("types", [])
        if isinstance(types_raw, str):
            try:
                types_raw = ast.literal_eval(types_raw)
            except Exception:
                types_raw = []
        if not isinstance(types_raw, list):
            types_raw = []

        name = str(row.get("name", ""))
        cat  = _categorize_google_place(name, types_raw)
        if cat is None:
            continue  # exclude irrelevant entries

        r_dict = dict(row)
        r_dict["category"] = cat
        records.append(r_dict)

    result = gpd.GeoDataFrame(records, geometry="geometry", crs="EPSG:4326")
    print(f" {len(result)} records (after re-categorization)")
    return result


# ──────────────────────────────────────────────────────────────────────────────
# HRSA – HEALTH CENTERS (FQHCs)
# ──────────────────────────────────────────────────────────────────────────────

def fetch_hrsa_health_centers() -> gpd.GeoDataFrame:
    """
    Fetch HRSA Health Center Service Delivery Sites (FQHCs + Look-Alikes) for Chicago.
    Uses X/Y geocoding coordinates bundled in the CSV.
    """
    cache_file = DATA_DIR / "hrsa_health_centers.geojson"
    if cache_file.exists():
        print(f"  [Cache] Loading HRSA Health Centers from {cache_file.name} …", end=" ", flush=True)
        gdf = gpd.read_file(cache_file)
        print(len(gdf))
        return gdf

    print("  [HRSA] Fetching Health Center Service Delivery sites …", end=" ", flush=True)
    url = "https://data.hrsa.gov/DataDownload/DD_Files/Health_Center_Service_Delivery_and_LookAlike_Sites.csv"
    try:
        resp = requests.get(url, timeout=60)
        resp.raise_for_status()
        from io import StringIO
        df = pd.read_csv(StringIO(resp.text), on_bad_lines="skip", low_memory=False)
        df.columns = df.columns.str.strip()

        # Filter Illinois → Chicago
        df = df[df["Site State Abbreviation"] == "IL"]
        df = df[df["Site City"].str.upper() == "CHICAGO"]

        # Only active sites
        if "Site Status Description" in df.columns:
            df = df[df["Site Status Description"].str.strip() == "Active"]

        x_col = "Geocoding Artifact Address Primary X Coordinate"
        y_col = "Geocoding Artifact Address Primary Y Coordinate"

        records = []
        for _, row in df.iterrows():
            try:
                lon, lat = float(row[x_col]), float(row[y_col])
            except (ValueError, TypeError):
                continue

            hc_type = str(row.get("Health Center Type", "FQHC"))
            is_lookalike = "Look-Alike" in hc_type

            records.append({
                **row.to_dict(),
                "category": "HRSA – FQHC / Health Center",
                "hrsa_subtype": "FQHC Look-Alike" if is_lookalike else "FQHC",
                "source":   "HRSA",
                "geometry": Point(lon, lat),
            })

        gdf = gpd.GeoDataFrame(records, crs="EPSG:4326")
        if not gdf.empty:
            gdf = _sanitize_gdf(gdf)
            gdf.to_file(cache_file, driver="GeoJSON")
        print(len(gdf))
        return gdf
    except Exception as exc:
        print(f"err ({exc}) — skipping HRSA health centers")
        return _empty_gdf()


# ──────────────────────────────────────────────────────────────────────────────
# HRSA – MEDICALLY UNDERSERVED AREAS (MUAs)
# ──────────────────────────────────────────────────────────────────────────────

def _fetch_cook_tract_centroids() -> dict[str, tuple[float, float]]:
    """
    Fetch census tract internal-point centroids for Cook County (17031)
    from the Census TIGER web service. Returns {tract_id -> (lat, lon)}.
    """
    url = ("https://tigerweb.geo.census.gov/arcgis/rest/services"
           "/TIGERweb/Tracts_Blocks/MapServer/0/query")
    params = {
        "where":           "STATE='17' AND COUNTY='031'",
        "outFields":       "TRACT,INTPTLAT,INTPTLON",
        "f":               "json",
        "returnGeometry":  "false",
        "resultRecordCount": 2000,
    }
    centroids: dict[str, tuple[float, float]] = {}
    try:
        resp = requests.get(url, params=params, timeout=30)
        resp.raise_for_status()
        for feat in resp.json().get("features", []):
            attr = feat["attributes"]
            tract_code = str(attr["TRACT"]).zfill(6)  # e.g. "220400"
            lat = float(attr["INTPTLAT"])
            lon = float(attr["INTPTLON"])
            centroids[tract_code] = (lat, lon)
    except Exception as exc:
        print(f"\n  [TIGER] Warning: could not fetch centroids: {exc}")
    return centroids


def fetch_hrsa_mua() -> gpd.GeoDataFrame:
    """
    Fetch HRSA Medically Underserved Areas for Cook County (Chicago area).
    Since the CSV has census-tract IDs but no lat/lon, we geocode tracts
    using the Census TIGER centroid service.

    Each MUA tract becomes one point marker carrying MUA metadata.
    """
    cache_file = DATA_DIR / "hrsa_mua.geojson"
    if cache_file.exists():
        print(f"  [Cache] Loading HRSA MUA data from {cache_file.name} …", end=" ", flush=True)
        gdf = gpd.read_file(cache_file)
        print(len(gdf))
        return gdf

    print("  [HRSA] Fetching Medically Underserved Areas (MUAs) for Cook County …", end=" ", flush=True)
    url = "https://data.hrsa.gov/DataDownload/DD_Files/MUA_DET.csv"
    try:
        resp = requests.get(url, timeout=60)
        resp.raise_for_status()
        from io import StringIO
        df = pd.read_csv(StringIO(resp.text), on_bad_lines="skip", low_memory=False)
        df.columns = df.columns.str.strip()

        # Filter Cook County, Illinois, active designations
        il_mask    = df["State Abbreviation"] == "IL"
        cook_mask  = df["Complete County Name"].str.upper().str.contains("COOK", na=False)
        actv_mask  = df["MUA/P Status Description"] == "Designated"
        df = df[il_mask & cook_mask & actv_mask].copy()

        if df.empty:
            print("0 (no Cook County MUA rows)")
            return _empty_gdf()

        # Fetch census tract centroids
        print(f"\n  [Census TIGER] Fetching Cook County tract centroids …", end=" ", flush=True)
        centroids = _fetch_cook_tract_centroids()
        print(f"{len(centroids)} tracts")

        # Convert MUA tract IDs to 6-digit zero-padded TRACT code
        # MUA census tract column value like '2204.00' → '220400'
        def _tract_to_code(t) -> str:
            try:
                v = float(t)
                # 2204.00 → 220400
                major = int(v)
                minor = round((v - major) * 100)
                return f"{major:04d}{minor:02d}"
            except (ValueError, TypeError):
                return ""

        pop_col  = "Designation Population in a Medically Underserved Area/Population (MUA/P)"
        total_col = "Medically Underserved Area/Population (MUA/P) Total Resident Civilian Population"

        records = []
        for _, row in df.iterrows():
            tract_code = _tract_to_code(row.get("Census Tract", ""))
            if not tract_code or tract_code not in centroids:
                continue

            lat, lon = centroids[tract_code]
            # Only include if within Chicago bounding box
            if not (41.6443 < lat < 42.0230 and -87.9401 < lon < -87.5237):
                continue

            records.append({
                **row.to_dict(),
                "category":   "HRSA – Medically Underserved Area",
                "source":     "HRSA",
                "mua_name":   str(row.get("MUA/P Service Area Name", "")),
                "desig_type": str(row.get("Designation Type", "")),
                "population": row.get(pop_col) or row.get(total_col),
                "imu_score":  row.get("IMU Score"),
                "geometry":   Point(lon, lat),
            })

        gdf = gpd.GeoDataFrame(records, crs="EPSG:4326")
        if not gdf.empty:
            gdf = _sanitize_gdf(gdf)
            gdf.to_file(cache_file, driver="GeoJSON")
        print(f"  → {len(gdf)} MUA tract points plotted")
        return gdf
    except Exception as exc:
        print(f"err ({exc}) — skipping HRSA MUAs")
        return _empty_gdf()


# ──────────────────────────────────────────────────────────────────────────────
# LEGACY HRSA (kept for backward compatibility, now replaced by above two)
# ──────────────────────────────────────────────────────────────────────────────

def fetch_hrsa() -> gpd.GeoDataFrame:
    """Combine HRSA Health Centers + MUAs into one GeoDataFrame."""
    hc  = fetch_hrsa_health_centers()
    mua = fetch_hrsa_mua()
    frames = [f for f in [hc, mua] if not f.empty]
    if not frames:
        return _empty_gdf()
    return gpd.GeoDataFrame(pd.concat(frames, ignore_index=True), crs="EPSG:4326")


# ──────────────────────────────────────────────────────────────────────────────
# COMBINED LOADER
# ──────────────────────────────────────────────────────────────────────────────

def fetch_all() -> gpd.GeoDataFrame:
    """Combine all sources without de-duplication."""
    osm    = fetch_osm()
    city   = fetch_chicago_official()
    hrsa   = fetch_hrsa()
    google = fetch_google_places_all()

    frames = [f for f in [hrsa, city, google, osm] if not f.empty]
    if not frames:
        raise RuntimeError("No data fetched.")
    combined = gpd.GeoDataFrame(pd.concat(frames, ignore_index=True), crs="EPSG:4326")
    combined = combined[combined.geometry.within(CHICAGO_BBOX)].copy()
    return combined.reset_index(drop=True)


def load_data() -> gpd.GeoDataFrame:
    pkl_path = DATA_DIR / "chicago.pkl"
    with open(pkl_path, "rb") as fh:
        chicago = pickle.load(fh)
    if chicago.crs is None or chicago.crs.to_epsg() != 4326:
        chicago = chicago.to_crs("EPSG:4326")
    return chicago
