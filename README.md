# NeoVille — AI Simulation Engine

A local, free-to-run version of the AI town simulation: independent AI citizens
with personalities, goals, memory and daily schedules, visualized on a live
animated town map. Runs entirely on your machine from VS Code.

## What it does

- **Generate a world** — set population, weather, economy; every citizen gets a
  distinct personality, occupation, goal and starting relationships.
- **Real-world satellite map** — the town map runs on Leaflet.js with free Esri
  satellite imagery (no key needed) instead of a flat abstract layout. Pan by
  dragging, zoom with scroll/pinch, exactly like Google Maps.
- **Real-world geography** — on "Generate World," the backend geocodes the
  "Real-World Location" field via OpenStreetMap (Nominatim), then pulls actual
  nearby hospitals, schools, banks, markets, shops etc. via the Overpass API
  (both free, no key). Citizens' homes, workplaces, and schedules are built
  around these real places, positioned at their real coordinates. If
  OpenStreetMap can't be reached, it falls back to a generic layout centered
  on the same real location, so the app still works offline.
- **Type your own event** — instead of only random events, type a description
  (e.g. "a gas leak is reported near the Market") and the AI simulates that
  specific scenario, choosing a plausible location and only the agencies that
  would realistically respond. Leave it blank for a random event, same as before.
- **Citizen awareness report** — after any event, a dedicated panel shows
  every citizen by name with a clear AWARE / NOT AWARE tag and exactly what
  they're doing about it (or not, if they haven't heard yet) — not everyone
  learns about an event simultaneously; the AI decides this per citizen based
  on occupation and proximity.
- **Real-time map** — citizens are dots that move between buildings across a
  simulated 24-hour clock, following the schedule the AI planned for them that
  morning. Watch the whole town go about its day.
- **Click a citizen** — see their personality bars, mood, money, full 24-hour
  schedule (current hour highlighted), and memory log.
- **Ask them directly** — a chat box on each citizen answers in character,
  using their personality, goal, and memories as context.
- **Trigger a random event** — fire, robbery, flood, festival, etc. Police,
  hospital, and other agencies reason independently, and citizens react
  according to their own personality.
- **Advance Day** — plans the next day fresh, informed by what happened before.

## Cost

$0. The default LLM provider is **Groq**, which has a free tier (no credit
card) with fast open models. See `backend/.env.example` for how to swap in
Google Gemini's free tier or a fully local Ollama model instead — the code
only depends on an OpenAI-compatible `/chat/completions` endpoint.

## Setup (in VS Code)

1. Open this folder (`neoville-sim`) in VS Code.
2. Open a terminal (`` Ctrl+` ``) and create a virtual environment:
   ```bash
   cd backend
   python -m venv venv
   # Windows: venv\Scripts\activate
   source venv/bin/activate
   pip install -r requirements.txt
   ```
3. Get a free API key at **console.groq.com/keys**.
4. Copy the env template and paste your key in:
   ```bash
   cp .env.example .env
   # then edit .env and set LLM_API_KEY
   ```
5. Run the server:
   ```bash
   uvicorn main:app --reload --port 8000
   ```
6. Open **http://localhost:8000** in your browser (or VS Code's Simple Browser).

That's it — one process serves both the API and the UI.

## Project structure

```
neoville-sim/
  backend/
    main.py        # FastAPI app: world state, scheduling, events, chat
    llm.py          # swappable LLM client (Groq by default)
    requirements.txt
    .env.example
  frontend/
    index.html
    style.css
    app.js          # map rendering, real-time clock, detail panel, chat
```

## Notes for your viva / report

- **Why an hourly schedule instead of one LLM call per tick?** A single call
  per citizen per simulated day generates their whole day's plan at once. The
  frontend clock then just walks through that plan, moving the marker on the
  map — no repeated LLM calls needed to get the "everyone working live"
  effect. This keeps it well inside free-tier rate limits even as population
  grows. (Note: with the satellite map, movement snaps to the new position
  each simulated hour rather than gliding smoothly — a Leaflet limitation,
  not a bug.)
- **State is in-memory** — restarting the server clears the town. That's
  intentional for a demo; swapping in SQLite for persistence is a natural
  "future work" point if asked.
- **Multi-agent reasoning** shows up in the event engine: each responding
  agency (police/fire/hospital) gets its own independent reasoning chain in
  the same JSON response, and citizens react individually rather than
  identically — this is the detail to point to when asked "why not just use
  normal if/else programming?"
- **On the real-map grounding**: this makes the simulation's geography real
  (actual roads, actual named hospitals/schools/banks near the location you
  give it), which is a genuine step up from an invented town. Be upfront
  about what it _isn't_, though, if asked: it's not calibrated against real
  incident data, traffic patterns, or population figures, and hasn't been
  reviewed by a domain expert — so it demonstrates the reasoning technique a
  real deployed planning tool would use, not a production-ready one. That's
  an honest, strong answer if a professor or interviewer pushes on
  "is this actually usable by a city?"
- **OpenStreetMap data quality varies by area.** Dense urban centers return
  rich results quickly; industrial/campus areas (like the default RIT Hassan
  location) may have fewer tagged POIs nearby, in which case the backend
  automatically widens its search radius until it finds enough, and always
  anchors the map with the location itself plus a residential point.
