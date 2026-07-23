"""
Pulls real-world geography from OpenStreetMap so the simulation runs on an
actual place instead of an invented town layout. Both services used here are
free and require no API key:

  - Nominatim (nominatim.openstreetmap.org) -- turns a place name into lat/lon
  - Overpass  (overpass-api.de)              -- fetches real POIs near a point

Both are shared public infrastructure with fair-use limits, not paid APIs.
Nominatim's usage policy requires a descriptive User-Agent, which we set below.
"""
import requests
import time

NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
OVERPASS_URL = "https://overpass-api.de/api/interpreter"
HEADERS = {"User-Agent": "NeoVille-College-Project/1.0 (student demo)"}

# Radii to try, in meters, smallest first. Kept short (3 attempts instead of
# 5) and each request has a tighter timeout, so a worst-case run stalls for
# well under a minute instead of several minutes with no visible progress.
SEARCH_RADII_M = (1500, 3000, 5500)
OVERPASS_TIMEOUT_S = 15

# category -> (display label, emoji). Order = priority when picking a
# diverse subset of nearby POIs.
CATEGORY_PRIORITY = [
    ("hospital", "Hospital", "\U0001F3E5"),
    ("clinic", "Clinic", "\U0001F3E5"),
    ("college", "College", "\U0001F393"),
    ("university", "University", "\U0001F393"),
    ("school", "School", "\U0001F3EB"),
    ("police", "Police Station", "\U0001F693"),
    ("bank", "Bank", "\U0001F3E6"),
    ("marketplace", "Market", "\U0001F6D2"),
    ("pharmacy", "Pharmacy", "\U0001F48A"),
    ("restaurant", "Restaurant", "\U0001F37D"),
    ("fast_food", "Restaurant", "\U0001F37D"),
    ("cafe", "Cafe", "\u2615"),
    ("fuel", "Fuel Station", "\u26FD"),
    ("place_of_worship", "Place of Worship", "\U0001F6D5"),
]
CATEGORY_MAP = {key: (label, emoji) for key, label, emoji in CATEGORY_PRIORITY}
PRIORITY_ORDER = [key for key, _, _ in CATEGORY_PRIORITY]


class OSMError(Exception):
    pass


def geocode(place: str):
    """Return (lat, lon) for a place name, or None if not found."""
    try:
        print(f"[osm] geocoding '{place}'...")
        resp = requests.get(
            NOMINATIM_URL,
            params={"q": place, "format": "json", "limit": 1},
            headers=HEADERS,
            timeout=15,
        )
        resp.raise_for_status()
        results = resp.json()
        if not results:
            print("[osm] geocode: no results found.")
            return None
        print("[osm] geocode: found coordinates.")
        return float(results[0]["lat"]), float(results[0]["lon"])
    except (requests.exceptions.RequestException, KeyError, ValueError, IndexError) as e:
        print(f"[osm] geocode failed: {e}")
        return None


def _classify(tags: dict):
    for key in PRIORITY_ORDER:
        if tags.get("amenity") == key or tags.get("shop") == key or tags.get("leisure") == key:
            return CATEGORY_MAP[key]
    if tags.get("leisure") == "park":
        return ("Park", "\U0001F333")
    if tags.get("shop"):
        return ("Shop", "\U0001F3EC")
    return None


def _overpass_query(lat, lon, radius_m):
    tag_filter = "|".join(PRIORITY_ORDER)
    return f"""
    [out:json][timeout:20];
    (
      node["amenity"~"{tag_filter}"](around:{radius_m},{lat},{lon});
      way["amenity"~"{tag_filter}"](around:{radius_m},{lat},{lon});
      node["shop"](around:{radius_m},{lat},{lon});
      node["leisure"="park"](around:{radius_m},{lat},{lon});
      way["leisure"="park"](around:{radius_m},{lat},{lon});
    );
    out center 60;
    """


def fetch_nearby_pois(lat, lon, min_results=6, max_results=13):
    """Try increasing radii until enough distinct, named POIs are found."""
    best_candidates = []
    for radius_m in SEARCH_RADII_M:
        try:
            print(f"[osm] querying Overpass at radius {radius_m}m...")
            resp = requests.post(
                OVERPASS_URL,
                data={"data": _overpass_query(lat, lon, radius_m)},
                headers=HEADERS,
                timeout=OVERPASS_TIMEOUT_S,
            )
            resp.raise_for_status()
            elements = resp.json().get("elements", [])
        except (requests.exceptions.RequestException, ValueError) as e:
            print(f"[osm] Overpass request failed at radius {radius_m}m: {e}")
            time.sleep(1)
            continue

        candidates = []
        seen_names = set()
        for el in elements:
            tags = el.get("tags", {})
            name = tags.get("name")
            if not name or name in seen_names:
                continue
            cat = _classify(tags)
            if not cat:
                continue
            point = el.get("center") or el  # ways use "center", nodes have lat/lon directly
            if "lat" not in point or "lon" not in point:
                continue
            seen_names.add(name)
            label, emoji = cat
            candidates.append({"name": name, "category": label, "emoji": emoji, "lat": point["lat"], "lon": point["lon"]})

        best_candidates = candidates
        print(f"[osm] radius {radius_m}m -> {len(candidates)} candidate POIs.")
        if len(candidates) >= min_results:
            break

    return _pick_diverse(best_candidates, max_results)


def _pick_diverse(candidates, max_results):
    """Prefer variety of categories first, then fill remaining slots."""
    by_category = {}
    for c in candidates:
        by_category.setdefault(c["category"], []).append(c)

    picked = []
    for _, label, _ in CATEGORY_PRIORITY:
        if label in by_category and len(picked) < max_results:
            picked.append(by_category[label][0])

    for c in candidates:
        if len(picked) >= max_results:
            break
        if c not in picked:
            picked.append(c)

    return picked[:max_results]