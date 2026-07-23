from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from pathlib import Path
import random
import sys

sys.path.insert(0, str(Path(__file__).parent))

from llm import call_llm, call_llm_json, LLMError
import osm

# Used only as an absolute last resort if geocoding itself fails (e.g. no
# internet at all). Normally generic_layout() below centers on whatever
# location the user actually typed.
LAST_RESORT_CENTER = (12.990833, 76.114950)  # Rajeev Institute of Technology, Hassan


def generic_layout(lat, lon):
    """Generic fallback buildings arranged around a real center point, used
    only if Overpass returns too few real POIs to work with."""
    offsets = [
        ("Town Hall", "\U0001F3DB", "Civic Building", 0.000, 0.006),
        ("School", "\U0001F3EB", "Education", -0.005, 0.002),
        ("Hospital", "\U0001F3E5", "Healthcare", 0.005, 0.002),
        ("Police Station", "\U0001F693", "Public Safety", -0.005, -0.002),
        ("Market", "\U0001F6D2", "Commerce", 0.000, 0.000),
        ("Bank", "\U0001F3E6", "Finance", 0.005, -0.002),
        ("Park", "\U0001F333", "Recreation", 0.000, -0.005),
        ("Shops", "\U0001F3EC", "Commerce", -0.005, -0.006),
        ("Homes", "\U0001F3E0", "Residential", 0.005, -0.006),
    ]
    return [{"name": n, "emoji": e, "category": cat, "lat": lat + dlat, "lon": lon + dlon} for n, e, cat, dlat, dlon in offsets]

app = FastAPI(title="NeoVille Simulation Engine")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---- In-memory state (fine for a demo project; swap for SQLite/Postgres
# if you want persistence across restarts) ----
STATE = {
    "world": None,
    "buildings": [],
    "center": None,
    "citizens": [],
    "day": 0,
    "log": [],
    "last_event": None,
}


class WorldRequest(BaseModel):
    name: str = "NeoVille"
    population: int = 8
    weather: str = "Dynamic"
    economy: str = "Medium"
    location: str = "Rajeev Institute of Technology, Hassan, Karnataka"


class AskRequest(BaseModel):
    question: str


class TriggerEventRequest(BaseModel):
    description: str = ""


def find_citizen(cid: int):
    for c in STATE["citizens"]:
        if c["id"] == cid:
            return c
    raise HTTPException(404, "Citizen not found")


def resolve_buildings(location: str, place_label: str):
    """Geocode the location and pull real nearby POIs from OpenStreetMap.
    Falls back to a generic layout centered on the same real point if
    Overpass returns too little, or on a last-resort constant if geocoding
    itself fails (e.g. no internet) -- so the app still works offline."""
    coords = osm.geocode(location)
    if not coords:
        lat, lon = LAST_RESORT_CENTER
        return generic_layout(lat, lon), False, (lat, lon)

    lat, lon = coords
    pois = osm.fetch_nearby_pois(lat, lon)

    # Always anchor the map with the origin place itself and a residential
    # point nearby, since real OSM data rarely tags "homes" usefully.
    anchors = [
        {"name": place_label, "category": "Campus", "emoji": "\U0001F3EB", "lat": lat, "lon": lon},
        {"name": "Residential Area", "category": "Homes", "emoji": "\U0001F3E0", "lat": lat + 0.004, "lon": lon + 0.002},
    ]
    all_points = anchors + pois
    if len(all_points) < 4:
        return generic_layout(lat, lon), False, (lat, lon)

    buildings = [{"name": p["name"], "emoji": p["emoji"], "category": p.get("category", "Landmark"), "lat": p["lat"], "lon": p["lon"]} for p in all_points]
    return buildings, True, (lat, lon)


@app.post("/api/generate-world")
def generate_world(req: WorldRequest):
    place_label = req.location.split(",")[0].strip() or req.name
    buildings, is_real, center = resolve_buildings(req.location, place_label)
    building_names = [b["name"] for b in buildings]

    system = (
        "You are the world-generation engine for a town simulation. "
        "Output ONLY raw JSON, no markdown fences, no preamble. "
        "Give every citizen a genuinely distinct personality and occupation -- "
        "include at least one teacher, one doctor, one police officer, one shopkeeper/businessperson."
    )
    user = f"""Generate {req.population} citizens for a town called "{req.name}".
Weather: {req.weather}. Economy: {req.economy}.
Each citizen's "home" and "workplace" MUST be chosen from exactly this list: {building_names}.

Return this exact JSON shape:
{{
 "citizens": [
   {{
     "id": number (1-indexed),
     "name": string,
     "age": number,
     "occupation": string,
     "personality": {{"kindness": number, "greed": number, "anger": number, "curiosity": number, "leadership": number}},
     "goal": string,
     "money": number,
     "mood": number (0-100),
     "energy": number (0-100),
     "home": string (must be one of the building names above),
     "workplace": string (must be one of the building names above),
     "relationships": [{{"id": number, "type": "friend"|"enemy"|"family"}}]
   }}
 ]
}}"""
    try:
        data = call_llm_json(system, user)
    except LLMError as e:
        raise HTTPException(502, f"World generation failed: {e}")

    citizens = data["citizens"]
    for c in citizens:
        c["memories"] = []
        c["schedule"] = []
        c["last_action"] = None
        c["chat_history"] = []

    STATE["world"] = req.dict()
    STATE["buildings"] = buildings
    STATE["center"] = {"lat": center[0], "lon": center[1]}
    STATE["citizens"] = citizens
    STATE["day"] = 0
    STATE["last_event"] = None
    grounding_note = f" (mapped to real locations near {req.location})" if is_real else " (OpenStreetMap unreachable -- using a generic layout)"
    STATE["log"] = [{"day": 0, "text": f'{req.name} is founded with {len(citizens)} citizens{grounding_note}.'}]

    return get_state()


@app.get("/api/state")
def get_state():
    return {
        "world": STATE["world"],
        "buildings": STATE["buildings"],
        "center": STATE["center"],
        "citizens": STATE["citizens"],
        "day": STATE["day"],
        "log": STATE["log"],
        "last_event": STATE["last_event"],
    }


@app.post("/api/advance-day")
def advance_day():
    if not STATE["citizens"]:
        raise HTTPException(400, "Generate a world first.")

    day = STATE["day"] + 1
    building_names = [b["name"] for b in STATE["buildings"]]
    roster = [
        {
            "id": c["id"], "name": c["name"], "occupation": c["occupation"],
            "personality": c["personality"], "goal": c["goal"], "mood": c["mood"],
            "energy": c["energy"], "home": c["home"], "workplace": c["workplace"],
            "recent_memory": (c["memories"][-1] if c["memories"] else None),
        }
        for c in STATE["citizens"]
    ]

    system = (
        "You are the daily-scheduling engine for a town simulation. Each citizen must get "
        "a schedule that reflects THEIR OWN personality, occupation and goal -- "
        "not a generic template every citizen shares. Be concise. Output ONLY raw JSON, no markdown fences."
    )
    user = f"""Day {day}. Buildings available: {building_names}.
Citizens: {roster}

For each citizen, produce 4 to 6 schedule BLOCKS covering hours 0 through 24 with no gaps and no
overlaps (block 1 starts at hour 0, each next block's start_hour equals the previous block's
end_hour, last block's end_hour is 24). location MUST be one of the building names above. Keep
"activity" to 4 words or fewer. Also give a one-sentence headline "action" summarizing their day,
a mood_delta (-15 to 15), a money_delta, and an optional short new_memory (only if something
notable happened -- a favor, a conflict, a milestone -- otherwise null).

Return this exact JSON shape, and nothing else:
{{
 "day_summary": string (one sentence, town-wide),
 "citizen_updates": [
   {{
     "id": number,
     "action": string,
     "mood_delta": number,
     "money_delta": number,
     "new_memory": string or null,
     "schedule": [{{"start_hour": number, "end_hour": number, "location": string, "activity": string}}]
   }}
 ]
}}"""
    try:
        data = call_llm_json(system, user, max_tokens=6000)
    except LLMError as e:
        raise HTTPException(502, f"Day planning failed: {e}")

    for u in data["citizen_updates"]:
        c = find_citizen(u["id"])
        c["last_action"] = u["action"]
        c["mood"] = max(0, min(100, c["mood"] + u.get("mood_delta", 0)))
        c["money"] = max(0, c["money"] + u.get("money_delta", 0))
        c["schedule"] = u["schedule"]
        if u.get("new_memory"):
            c["memories"].append(f"Day {day}: {u['new_memory']}")

    STATE["day"] = day
    STATE["log"].append({"day": day, "text": data["day_summary"]})
    return get_state()


@app.post("/api/trigger-event")
def trigger_event(req: TriggerEventRequest):
    if not STATE["citizens"]:
        raise HTTPException(400, "Generate a world first.")

    roster = [{"id": c["id"], "name": c["name"], "occupation": c["occupation"], "personality": c["personality"]} for c in STATE["citizens"]]
    building_names = [b["name"] for b in STATE["buildings"]]

    description = req.description.strip()
    event_instruction = (
        f'Simulate EXACTLY this event, as described by the user: "{description}". '
        f"Infer a plausible specific location for it from this building list: {building_names}."
        if description else
        f"Pick ONE plausible random event (fire, robbery, flood, festival, power failure, minor earthquake, etc) "
        f"at one of these buildings: {building_names}."
    )
    system = (
        "You are the event & multi-agent reasoning engine for a town simulation. "
        f"{event_instruction} Simulate an independent reasoning chain for each responding agency relevant "
        "to this specific event (only include agencies that would plausibly respond -- e.g. no police chain "
        "for a festival announcement, and at most 3 agencies). "
        "For EVERY citizen listed, you MUST decide whether they are aware the event has happened yet -- "
        "not everyone finds out immediately; base it on their occupation (police/press hear fast), proximity "
        "to the event location, and plausibility -- and state specifically what they do about it if aware, "
        "based on THEIR OWN personality, not a generic response. If not aware yet, still include them with "
        "aware=false and a short note like what they're doing instead, unaware. "
        "Keep every 'reaction' and 'chain' entry to 12 words or fewer -- brevity matters more than detail here. "
        "Output ONLY raw JSON, no markdown fences."
    )
    user = f"""Day {STATE['day']}. Citizens: {roster}
Return this exact JSON shape, with one entry in citizen_reactions for EVERY citizen listed above:
{{
 "event_name": string,
 "location": string (must be one of the building names),
 "narrative": string (2-3 sentences),
 "agent_reasoning": [{{"role": string, "chain": [string, string, string]}}],
 "citizen_reactions": [{{"id": number, "aware": boolean, "reaction": string, "redirect_to": string or null}}]
}}"""
    try:
        data = call_llm_json(system, user, max_tokens=4500)
    except LLMError as e:
        raise HTTPException(502, f"Event simulation failed: {e}")

    current_hour = _current_hour_estimate()
    id_to_citizen = {c["id"]: c for c in STATE["citizens"]}
    report_rows = []
    for r in data["citizen_reactions"]:
        c = id_to_citizen.get(r["id"])
        if not c:
            continue
        c["last_action"] = r["reaction"]
        c["memories"].append(f"Day {STATE['day']}, {data['event_name']}: {r['reaction']}")
        if r.get("aware") and r.get("redirect_to") and c["schedule"]:
            for entry in c["schedule"]:
                if entry["end_hour"] > current_hour:
                    entry["location"] = r["redirect_to"]
                    entry["activity"] = f"Responding to {data['event_name']}"
        report_rows.append({"id": c["id"], "name": c["name"], "occupation": c["occupation"], "aware": bool(r.get("aware")), "reaction": r["reaction"]})

    arrow = " \u2192 "
    agency_parts = [f"{a['role']} {arrow} {arrow.join(a['chain'])}" for a in data["agent_reasoning"]]
    agency_text = " | ".join(agency_parts)
    STATE["log"].append({"day": STATE["day"], "text": f"[EVENT] {data['event_name']} at {data['location']}. {data['narrative']}"})
    STATE["log"].append({"day": STATE["day"], "text": f"Agency response: {agency_text}"})
    STATE["last_event"] = {
        "event_name": data["event_name"],
        "location": data["location"],
        "narrative": data["narrative"],
        "agent_reasoning": data["agent_reasoning"],
        "citizen_report": report_rows,
    }
    return get_state()


def _current_hour_estimate():
    # Best-effort: frontend tracks the real simulated hour; backend just
    # needs a reasonable cutoff for redirecting the rest of the day.
    return random.randint(8, 16)


@app.post("/api/citizen/{cid}/ask")
def ask_citizen(cid: int, req: AskRequest):
    c = find_citizen(cid)
    system = (
        f"You are {c['name']}, a {c['age']}-year-old {c['occupation']} in NeoVille. "
        f"Personality: {c['personality']}. Your goal: {c['goal']}. "
        f"Your memories: {c['memories'][-8:]}. "
        f"Today you are doing: {c.get('last_action') or 'going about your day'}. "
        "Answer the question in first person, in character, 2-4 sentences. Plain text only."
    )
    try:
        answer = call_llm(system, req.question, max_tokens=400, temperature=0.8)
    except LLMError as e:
        raise HTTPException(502, str(e))

    c["chat_history"].append({"role": "user", "text": req.question})
    c["chat_history"].append({"role": "citizen", "text": answer.strip()})
    return {"answer": answer.strip(), "chat_history": c["chat_history"]}


@app.post("/api/reset")
def reset():
    STATE["world"] = None
    STATE["buildings"] = []
    STATE["center"] = None
    STATE["citizens"] = []
    STATE["day"] = 0
    STATE["log"] = []
    STATE["last_event"] = None
    return {"ok": True}


# Serve the frontend (index.html, app.js, style.css) at the site root, so
# `uvicorn main:app` gives you the whole app on one port.
frontend_dir = Path(__file__).parent.parent / "frontend"
app.mount("/", StaticFiles(directory=str(frontend_dir), html=True), name="frontend")
