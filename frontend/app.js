const API = "/api";
const HOURS_PER_DAY = 24;
const SECONDS_PER_SIM_HOUR = 12; // real seconds per simulated hour -- slower still, so movement is easy to follow

let authToken = null;

function apiFetch(path, options = {}) {
  const headers = Object.assign({}, options.headers || {}, { 'X-Session-Token': authToken || '' });
  return fetch(`${API}${path}`, Object.assign({}, options, { headers }));
}

document.getElementById('btn-login').addEventListener('click', doLogin);
document.getElementById('login-password').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });

async function doLogin() {
  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value;
  const statusEl = document.getElementById('login-status');
  const errorEl = document.getElementById('login-error');
  errorEl.style.display = 'none';
  statusEl.style.display = 'flex';
  document.getElementById('btn-login').disabled = true;
  try {
    const res = await fetch(`${API}/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    if (!res.ok) throw new Error((await res.json()).detail || 'Login failed');
    const data = await res.json();
    authToken = data.token;
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('setup-screen').style.display = 'block';
  } catch (e) {
    errorEl.textContent = e.message;
    errorEl.style.display = 'block';
  } finally {
    statusEl.style.display = 'none';
    document.getElementById('btn-login').disabled = false;
  }
}

let state = { world: null, buildings: [], center: null, citizens: [], day: 0, log: [], last_event: null };
let selectedId = null;
let selectedBuilding = null;
let simHour = 0;
let clockTimer = null;

let map = null;
let buildingMarkers = {};  // name -> L.marker
let citizenMarkers = {};   // id -> L.marker
let citizenTrailPoints = {}; // id -> array of [lat,lon] visited so far today
let citizenTrailLines = {};  // id -> L.polyline
const TRAIL_COLORS = ['#4FA8A0', '#C9A227', '#C0563B', '#6FA96A', '#8A7220', '#E6C34A', '#7FCFC6', '#A15C3B', '#B08BC9', '#5C9EC0'];

// ---------- setup screen ----------
const popRange = document.getElementById('f-pop');
popRange.addEventListener('input', () => document.getElementById('pop-val').textContent = popRange.value);

document.getElementById('btn-generate').addEventListener('click', async () => {
  const body = {
    name: document.getElementById('f-name').value || 'NeoVille',
    population: parseInt(popRange.value, 10),
    weather: document.getElementById('f-weather').value,
    economy: document.getElementById('f-econ').value,
    location: document.getElementById('f-location').value || 'Rajeev Institute of Technology, Hassan, Karnataka',
  };
  setSetupBusy(true, 'Looking up the real map, then drafting citizens... (can take ~20-30s)');
  hideSetupError();
  try {
    const res = await apiFetch('/generate-world', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error((await res.json()).detail || 'World generation failed');
    state = await res.json();
    document.getElementById('setup-screen').style.display = 'none';
    document.getElementById('town-screen').style.display = 'block';
    initMap();
    renderBuildings();
    renderTownMeta();
    renderLog();
    await advanceDay(); // generate day 1 schedule immediately so the map has movement
  } catch (e) {
    showSetupError(e.message);
  } finally {
    setSetupBusy(false);
  }
});

function setSetupBusy(busy, msg) {
  document.getElementById('btn-generate').disabled = busy;
  document.getElementById('setup-status').style.display = busy ? 'flex' : 'none';
  document.getElementById('setup-status-text').textContent = msg || '';
}
function showSetupError(msg) {
  const el = document.getElementById('setup-error');
  el.textContent = msg;
  el.style.display = 'block';
}
function hideSetupError() {
  document.getElementById('setup-error').style.display = 'none';
}

// ---------- town screen ----------
function renderTownMeta() {
  document.getElementById('town-name').textContent = state.world.name;
  document.getElementById('town-sub').textContent = `Pop. ${state.citizens.length} \u00b7 ${state.world.weather} \u00b7 Economy: ${state.world.economy}`;
  document.getElementById('clock-day').textContent = state.day;
}

// ---------- Leaflet map: real satellite imagery, pan + zoom for free ----------
function initMap() {
  if (map) { map.remove(); map = null; }
  buildingMarkers = {};
  citizenMarkers = {};

  const center = state.center ? [state.center.lat, state.center.lon] : [12.990833, 76.114950];
  map = L.map('town-map', { zoomControl: true, scrollWheelZoom: true }).setView(center, 16);

  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    attribution: 'Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community',
    maxZoom: 19,
  }).addTo(map);
}

function renderBuildings() {
  const bounds = [];
  state.buildings.forEach(b => {
    bounds.push([b.lat, b.lon]);
    if (buildingMarkers[b.name]) return; // buildings don't move; only add once
    const icon = L.divIcon({
      className: 'building-icon',
      html: `<div class="building-icon-inner"><div class="b-emoji">${b.emoji}</div><div class="b-label">${escapeHtml(b.name)}</div></div>`,
      iconSize: [1, 1],
    });
    const marker = L.marker([b.lat, b.lon], { icon }).addTo(map);
    marker.on('click', () => selectBuilding(b.name));
    buildingMarkers[b.name] = marker;
  });
  if (bounds.length) map.fitBounds(bounds, { padding: [40, 40] });
}

function buildingByName(name) {
  return state.buildings.find(b => b.name === name) || state.buildings[0];
}

function renderCitizenDots() {
  state.citizens.forEach((c, idx) => {
    const loc = currentLocationFor(c);
    const b = buildingByName(loc);
    if (!b) return;
    // small offset (in degrees, ~15-20m) so citizens at the same building don't fully overlap
    const angle = (idx * 47) % 360;
    const dLat = Math.sin(angle * Math.PI / 180) * 0.00015;
    const dLon = Math.cos(angle * Math.PI / 180) * 0.00015;
    const lat = b.lat + dLat, lon = b.lon + dLon;

    if (citizenMarkers[c.id]) {
      const prev = citizenMarkers[c.id].getLatLng();
      if (Math.abs(prev.lat - lat) > 0.00001 || Math.abs(prev.lng - lon) > 0.00001) {
        addTrailPoint(c.id, [lat, lon]);
      }
      citizenMarkers[c.id].setLatLng([lat, lon]);
      updateCitizenIcon(citizenMarkers[c.id], c);
      return;
    }
    citizenTrailPoints[c.id] = [[lat, lon]];
    const icon = L.divIcon({
      className: 'citizen-marker-wrap',
      html: citizenIconHtml(c),
      iconSize: [26, 26],
    });
    const marker = L.marker([lat, lon], { icon }).addTo(map);
    marker.on('click', () => selectCitizen(c.id));
    citizenMarkers[c.id] = marker;
  });
}

function addTrailPoint(id, point) {
  if (!citizenTrailPoints[id]) citizenTrailPoints[id] = [];
  citizenTrailPoints[id].push(point);
  const color = TRAIL_COLORS[id % TRAIL_COLORS.length];
  if (citizenTrailLines[id]) {
    citizenTrailLines[id].setLatLngs(citizenTrailPoints[id]);
  } else {
    citizenTrailLines[id] = L.polyline(citizenTrailPoints[id], {
      color, weight: 2, opacity: 0.65, dashArray: '5,6',
    }).addTo(map);
  }
}

function clearTrails() {
  Object.values(citizenTrailLines).forEach(line => map.removeLayer(line));
  citizenTrailLines = {};
  citizenTrailPoints = {};
}

function citizenIconHtml(c) {
  const sel = c.id === selectedId ? ' selected' : '';
  return `<div class="citizen-marker${sel}">${occupationEmoji(c.occupation)}<div class="m-tag">${escapeHtml(c.name.split(' ')[0])}</div></div>`;
}

function occupationEmoji(occupation) {
  const o = (occupation || '').toLowerCase();
  if (o.includes('teach') || o.includes('professor') || o.includes('lecturer')) return '\u{1F469}\u200D\u{1F3EB}';
  if (o.includes('doctor') || o.includes('physician') || o.includes('surgeon')) return '\u{1F469}\u200D\u2695\uFE0F';
  if (o.includes('nurse')) return '\u{1F9D1}\u200D\u2695\uFE0F';
  if (o.includes('police') || o.includes('officer') || o.includes('cop')) return '\u{1F46E}';
  if (o.includes('fire')) return '\u{1F9D1}\u200D\u{1F692}';
  if (o.includes('farmer')) return '\u{1F9D1}\u200D\u{1F33E}';
  if (o.includes('shop') || o.includes('vendor') || o.includes('trader') || o.includes('merchant')) return '\u{1F9D1}\u200D\u{1F4BC}';
  if (o.includes('business') || o.includes('entrepreneur') || o.includes('owner') || o.includes('manager')) return '\u{1F9D1}\u200D\u{1F4BC}';
  if (o.includes('engineer') || o.includes('technician')) return '\u{1F468}\u200D\u{1F527}';
  if (o.includes('lawyer') || o.includes('advocate')) return '\u{1F9D1}\u200D\u2696\uFE0F';
  if (o.includes('chef') || o.includes('cook')) return '\u{1F9D1}\u200D\u{1F373}';
  if (o.includes('student')) return '\u{1F9D1}\u200D\u{1F393}';
  if (o.includes('artist') || o.includes('painter') || o.includes('musician')) return '\u{1F9D1}\u200D\u{1F3A8}';
  if (o.includes('driver') || o.includes('pilot') || o.includes('conductor')) return '\u{1F9D1}\u200D\u2708\uFE0F';
  return '\u{1F9D1}';
}

function updateCitizenIcon(marker, c) {
  marker.setIcon(L.divIcon({ className: 'citizen-marker-wrap', html: citizenIconHtml(c), iconSize: [26, 26] }));
}

function currentLocationFor(c) {
  if (!c.schedule || !c.schedule.length) return c.home;
  const entry = c.schedule.find(s => simHour >= s.start_hour && simHour < s.end_hour) || c.schedule[c.schedule.length - 1];
  return entry.location;
}

function renderLog() {
  const el = document.getElementById('log-list');
  el.innerHTML = state.log.slice().reverse().map(l =>
    `<div class="log-entry flex items-start text-[11px] leading-relaxed"><span class="day-tag shrink-0">D${l.day}</span><span class="text-zinc-300 font-sans">${escapeHtml(l.text)}</span></div>`
  ).join('') || '<p class="empty-note font-sans text-zinc-500 italic p-4 text-center text-xs">No logs recorded.</p>';
}

// ---------- simulated clock ----------
function startClock() {
  if (clockTimer) clearInterval(clockTimer);
  simHour = 0;
  tickClock();
  clockTimer = setInterval(tickClock, SECONDS_PER_SIM_HOUR * 1000);
}

function tickClock() {
  document.getElementById('clock-time').textContent = String(simHour).padStart(2, '0') + ':00';
  renderCitizenDots();
  if (selectedId !== null || selectedBuilding !== null) renderDetail();
  simHour++;
  if (simHour >= HOURS_PER_DAY) {
    clearInterval(clockTimer);
    document.getElementById('clock-time').textContent = 'Day complete';
  }
}

// ---------- controls ----------
document.getElementById('btn-advance').addEventListener('click', advanceDay);
document.getElementById('btn-event').addEventListener('click', triggerEvent);

async function advanceDay() {
  setControlBusy(true, 'Every citizen is planning their day...');
  try {
    const res = await apiFetch('/advance-day', { method: 'POST' });
    if (!res.ok) throw new Error((await res.json()).detail || 'Day planning failed');
    state = await res.json();
    renderTownMeta();
    renderLog();
    clearTrails();
    startClock();
    if (selectedId !== null) renderDetail();
  } catch (e) {
    alert(e.message);
  } finally {
    setControlBusy(false);
  }
}

async function triggerEvent() {
  const description = document.getElementById('event-input').value.trim();
  setControlBusy(true, description ? 'Simulating that event across the town...' : 'An event is unfolding \u2014 agencies are responding...');
  try {
    const res = await apiFetch('/trigger-event', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ description })
    });
    if (!res.ok) throw new Error((await res.json()).detail || 'Event simulation failed');
    state = await res.json();
    renderLog();
    renderCitizenDots();
    renderEventReport();
    if (selectedId !== null) renderDetail();
  } catch (e) {
    alert(e.message);
  } finally {
    setControlBusy(false);
  }
}

function renderEventReport() {
  const panel = document.getElementById('event-report-panel');
  const ev = state.last_event;
  if (!ev) { panel.style.display = 'none'; return; }
  panel.style.display = 'block';

  const chainsHtml = ev.agent_reasoning.map(a =>
    `<div class="agency-chain flex items-center flex-wrap gap-1.5 py-1 text-[10px]">
       <span class="px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-200 border border-zinc-700 font-bold uppercase font-mono">${escapeHtml(a.role)}</span>
       <span class="text-zinc-650 font-sans">→</span>
       <span class="text-zinc-400">${a.chain.map(escapeHtml).join(' <span class="text-zinc-800 font-sans">→</span> ')}</span>
     </div>`
  ).join('');

  const awareCount = ev.citizen_report.filter(r => r.aware).length;
  const rowsHtml = ev.citizen_report.map(r => `
    <div class="event-row py-2 border-b border-zinc-950 last:border-b-0 flex flex-col gap-1">
      <div class="flex items-center justify-between flex-wrap gap-2">
        <div class="flex items-center gap-1.5">
          <span class="${r.aware ? 'text-zinc-200' : 'text-zinc-600'} font-bold">${r.aware ? '✓' : '✗'}</span>
          <span class="font-semibold text-zinc-200 text-xs">${escapeHtml(r.name)}</span>
          <span class="text-[10px] text-zinc-500 font-medium">(${escapeHtml(r.occupation)})</span>
        </div>
        <span class="${r.aware ? 'aware-yes' : 'aware-no'}">${r.aware ? 'AWARE' : 'NOT AWARE'}</span>
      </div>
      <p class="text-[11px] text-zinc-400 italic font-medium pl-3">"${escapeHtml(r.reaction)}"</p>
    </div>
  `).join('');

  document.getElementById('event-report-body').innerHTML = `
    <div class="border-b border-zinc-850 pb-2 mb-2">
      <div class="font-mono text-[9px] tracking-widest text-zinc-450 font-bold uppercase mb-1">EVENT DISPATCHED</div>
      <div class="text-xs font-bold text-white">${escapeHtml(ev.event_name)}</div>
      <div class="text-[10px] text-zinc-550 mt-0.5 font-mono">${escapeHtml(ev.location)}</div>
    </div>
    <div class="event-report-narrative text-xs text-zinc-350 leading-relaxed font-medium italic border-l-2 border-zinc-700 pl-3 py-1 mb-4">${escapeHtml(ev.narrative)}</div>
    
    <div class="font-mono text-[9px] tracking-widest text-zinc-500 font-bold uppercase mb-2">AGENCY INVOLVEMENT</div>
    <div class="space-y-1 mb-4">${chainsHtml}</div>
    
    <div class="font-mono text-[9px] tracking-widest text-zinc-500 font-bold uppercase mb-2">CITIZEN RESPONSE (${awareCount}/${ev.citizen_report.length} aware)</div>
    <div class="bg-zinc-950 border border-zinc-850 rounded px-3.5 py-1.5 max-h-[160px] overflow-y-auto custom-scrollbar">${rowsHtml}</div>
  `;
}

function setControlBusy(busy, msg) {
  document.getElementById('btn-advance').disabled = busy;
  document.getElementById('btn-event').disabled = busy;
  document.getElementById('control-status').style.display = busy ? 'flex' : 'none';
  document.getElementById('control-status-text').textContent = msg || '';
}

// ---------- citizen detail panel ----------
function selectCitizen(id) {
  const prev = selectedId;
  selectedId = id;
  selectedBuilding = null;
  if (prev !== null && citizenMarkers[prev]) updateCitizenIcon(citizenMarkers[prev], state.citizens.find(x => x.id === prev));
  if (citizenMarkers[id]) updateCitizenIcon(citizenMarkers[id], state.citizens.find(x => x.id === id));
  renderDetail();
}

function selectBuilding(name) {
  selectedId = null;
  selectedBuilding = name;
  renderDetail();
}

function renderDetail() {
  const panel = document.getElementById('detail-panel');
  if (selectedBuilding) { renderBuildingDetail(panel); return; }

  const c = state.citizens.find(x => x.id === selectedId);
  if (!c) {
    panel.innerHTML = `
      <div class="flex-1 flex flex-col items-center justify-center text-center p-6 text-zinc-500">
        <div class="w-10 h-10 rounded-full border border-zinc-800 flex items-center justify-center mb-3">
          <svg class="w-4 h-4 text-zinc-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
        </div>
        <p class="text-[11px] font-semibold text-zinc-450 uppercase tracking-wider font-mono">Tactical Feed Offline</p>
        <p class="text-xs text-zinc-500 mt-1 max-w-[200px] leading-relaxed font-medium">Select a citizen marker or a building landmark on the map grid to stream telemetry profiles.</p>
      </div>
    `;
    return;
  }

  const traits = c.personality || {};
  const scheduleHtml = (c.schedule || []).map(s => {
    const isNow = simHour >= s.start_hour && simHour < s.end_hour;
    const range = `${String(s.start_hour).padStart(2, '0')}:00-${String(s.end_hour).padStart(2, '0')}:00`;
    return `<div class="schedule-item ${isNow ? 'now' : ''}">
       <div class="hr">${range}</div>
       <div class="loc">${escapeHtml(s.location)}</div>
       <div class="act">${escapeHtml(s.activity)}</div>
     </div>`;
  }).join('') || '<p class="empty-note text-zinc-500 italic p-3 text-center text-xs">No schedule mapped for today.</p>';

  const memoriesHtml = (c.memories || []).slice().reverse().map(m => `<div class="memory-item text-[11px]">${escapeHtml(m)}</div>`).join('') || '<p class="empty-note text-zinc-500 italic p-3 text-center text-xs">No cognitive logs recorded yet.</p>';

  const chatHtml = (c.chat_history || []).map(m =>
    `<div class="chat-msg ${m.role === 'user' ? 'user' : 'citizen'}">${escapeHtml(m.text)}</div>`
  ).join('');

  panel.innerHTML = `
    <!-- Profile Header -->
    <div class="flex items-center gap-3.5 mb-5 border-b border-zinc-800 pb-4">
      <div class="flex items-center justify-center w-10 h-10 rounded-full bg-zinc-800 border border-zinc-700 text-lg">
        ${occupationEmoji(c.occupation)}
      </div>
      <div>
        <h2 class="text-sm font-semibold text-zinc-100 leading-none">${escapeHtml(c.name)}</h2>
        <div class="flex items-center gap-2 mt-1.5">
          <span class="font-mono text-[9px] font-bold text-zinc-300 bg-zinc-800 border border-zinc-750 px-1.5 py-0.5 rounded uppercase">${escapeHtml(c.occupation)}</span>
          <span class="text-zinc-650 text-xs">•</span>
          <span class="text-zinc-400 text-xs">Age ${c.age}</span>
          <span class="text-zinc-650 text-xs">•</span>
          <span class="font-mono text-[9px] text-zinc-500">ID-${String(c.id).padStart(3, '0')}</span>
        </div>
      </div>
    </div>

    <!-- Personality Matrix -->
    <div class="font-mono text-[9px] tracking-wider text-zinc-450 font-bold uppercase mb-2.5 flex items-center gap-1.5"><span class="w-1.5 h-1.5 bg-zinc-450 rounded-full"></span> Personality Matrix</div>
    <div class="space-y-1 mb-4">
      ${Object.entries(traits).map(([k, v]) => `
        <div class="trait-row"><div class="tname">${k}</div><div class="trait-bar"><i style="width:${v}%;"></i></div></div>
      `).join('')}
    </div>

    <!-- Status Grid -->
    <div class="font-mono text-[9px] tracking-wider text-zinc-450 font-bold uppercase mb-2.5 flex items-center gap-1.5"><span class="w-1.5 h-1.5 bg-zinc-450 rounded-full"></span> Status Telemetry</div>
    <div class="grid grid-cols-2 gap-3 bg-zinc-950 border border-zinc-850 rounded p-3 mb-4">
      <div class="flex flex-col">
        <span class="font-mono text-[9px] tracking-wider text-zinc-550 uppercase font-medium">Mood Profile</span>
        <span class="text-xs font-bold text-zinc-200 mt-0.5">${c.mood}%</span>
      </div>
      <div class="flex flex-col">
        <span class="font-mono text-[9px] tracking-wider text-zinc-550 uppercase font-medium">Capital / Assets</span>
        <span class="text-xs font-bold text-zinc-200 mt-0.5">₹${(c.money || 0).toLocaleString('en-IN')}</span>
      </div>
      <div class="col-span-2 flex flex-col border-t border-zinc-850/60 pt-2 mt-1">
        <span class="font-mono text-[9px] tracking-wider text-zinc-550 uppercase font-medium">Core Directives</span>
        <span class="text-xs text-zinc-300 mt-0.5 leading-normal font-medium">${escapeHtml(c.goal)}</span>
      </div>
      ${c.last_action ? `
        <div class="col-span-2 flex flex-col border-t border-zinc-850/60 pt-2 mt-1">
          <span class="font-mono text-[9px] tracking-wider text-zinc-550 uppercase font-medium">Active Task</span>
          <span class="text-xs text-zinc-300 mt-0.5 leading-normal font-medium">${escapeHtml(c.last_action)}</span>
        </div>
      ` : ''}
    </div>

    <!-- Daily schedule timeline -->
    <div class="font-mono text-[9px] tracking-wider text-zinc-450 font-bold uppercase mb-2.5 flex items-center gap-1.5"><span class="w-1.5 h-1.5 bg-zinc-450 rounded-full"></span> Daily schedule timeline</div>
    <div class="schedule-list flex flex-col border border-zinc-850 bg-zinc-950/20 rounded overflow-hidden max-h-[140px] overflow-y-auto custom-scrollbar mb-4">
      ${scheduleHtml}
    </div>

    <!-- Cognitive memory log -->
    <div class="font-mono text-[9px] tracking-wider text-zinc-450 font-bold uppercase mb-2.5 flex items-center gap-1.5"><span class="w-1.5 h-1.5 bg-zinc-450 rounded-full"></span> Cognitive memory log</div>
    <div class="space-y-1.5 max-h-[140px] overflow-y-auto custom-scrollbar mb-4 pr-1">
      ${memoriesHtml}
    </div>

    <!-- Security channel query -->
    <div class="font-mono text-[9px] tracking-wider text-zinc-450 font-bold uppercase mb-2.5 flex items-center gap-1.5"><span class="w-1.5 h-1.5 bg-zinc-450 rounded-full"></span> Security channel query</div>
    <div class="flex-1 flex flex-col border border-zinc-850 bg-zinc-950/20 rounded p-3 min-h-[200px]">
      <div class="chat-thread flex-1 overflow-y-auto pr-1 custom-scrollbar flex flex-col space-y-1.5 mb-3 max-h-[160px]" id="chat-thread">
        ${chatHtml || '<p class="empty-note text-zinc-500 text-center font-sans text-[11px] italic my-auto">Transmit query via security channel...</p>'}
      </div>
      <div class="flex gap-2 items-center mt-auto border-t border-zinc-850/60 pt-3">
        <input type="text" id="chat-input" placeholder="Query status or directives..." 
               class="flex-1 bg-zinc-900 border border-zinc-800 focus:border-zinc-550 rounded text-zinc-100 font-sans text-xs focus:outline-none transition-colors px-3 py-2 placeholder-zinc-700" />
        <button id="chat-send" class="bg-zinc-100 hover:bg-zinc-200 text-zinc-950 font-mono tracking-wider text-[10px] font-bold rounded px-3.5 py-2 shrink-0">
          ASK
        </button>
      </div>
    </div>
  `;

  document.getElementById('chat-send').addEventListener('click', () => sendChat(c.id));
  document.getElementById('chat-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(c.id); });

  // Auto-scroll chat to bottom
  const chatThread = document.getElementById('chat-thread');
  if (chatThread) {
    chatThread.scrollTop = chatThread.scrollHeight;
  }
}

function renderBuildingDetail(panel) {
  const b = state.buildings.find(x => x.name === selectedBuilding);
  if (!b) { panel.innerHTML = '<div class="empty-note text-zinc-550">Click a citizen or a building on the map to see more.</div>'; return; }

  const residents = state.citizens.filter(c => c.home === b.name);
  const workers = state.citizens.filter(c => c.workplace === b.name);
  const presentNow = state.citizens.filter(c => currentLocationFor(c) === b.name);

  const listOrNone = (arr) => arr.length
    ? arr.map(c => `
        <div class="flex items-center justify-between py-1.5 border-b border-zinc-850/60 last:border-b-0">
          <div class="flex items-center gap-2">
            <span class="text-xs font-semibold text-zinc-200">${escapeHtml(c.name)}</span>
            <span class="text-[10px] text-zinc-500">(${escapeHtml(c.occupation)})</span>
          </div>
        </div>
      `).join('')
    : '<p class="text-xs text-zinc-500 italic py-1">No citizens detected.</p>';

  panel.innerHTML = `
    <!-- Building Header -->
    <div class="flex items-center gap-3.5 mb-5 border-b border-zinc-805 pb-4">
      <div class="flex items-center justify-center w-10 h-10 rounded bg-zinc-800 border border-zinc-700 text-lg">
        ${b.emoji}
      </div>
      <div>
        <h2 class="text-sm font-bold text-zinc-100 leading-none">${escapeHtml(b.name)}</h2>
        <span class="inline-block mt-1.5 font-mono text-[9px] font-bold text-zinc-400 bg-zinc-800 border border-zinc-750 px-1.5 py-0.5 rounded uppercase">${escapeHtml(b.category || 'Landmark')}</span>
      </div>
    </div>

    <!-- Stats Grid -->
    <div class="font-mono text-[9px] tracking-wider text-zinc-450 font-bold uppercase mb-2.5 flex items-center gap-1.5"><span class="w-1.5 h-1.5 bg-zinc-450 rounded-full"></span> Telemetry</div>
    <div class="grid grid-cols-1 gap-2.5 bg-zinc-950 border border-zinc-850 rounded p-3 mb-4">
      <div class="flex justify-between items-center text-xs">
        <span class="text-zinc-500 font-medium">GPS Location</span>
        <span class="font-mono font-semibold text-zinc-350">${b.lat.toFixed(5)}, ${b.lon.toFixed(5)}</span>
      </div>
    </div>

    <!-- Active Residents/Workers lists -->
    <div class="font-mono text-[9px] tracking-wider text-zinc-450 font-bold uppercase mb-2 flex items-center gap-1.5"><span class="w-1.5 h-1.5 bg-zinc-450 rounded-full"></span> Detected Signals (${presentNow.length})</div>
    <div class="bg-zinc-950/20 border border-zinc-800 rounded px-3 py-1 max-h-[120px] overflow-y-auto custom-scrollbar mb-4">
      ${listOrNone(presentNow)}
    </div>

    <div class="font-mono text-[9px] tracking-wider text-zinc-450 font-bold uppercase mb-2 flex items-center gap-1.5"><span class="w-1.5 h-1.5 bg-amber-500 rounded-full"></span> Registered Inhabitants (${residents.length})</div>
    <div class="bg-zinc-950/20 border border-zinc-800 rounded px-3 py-1 max-h-[120px] overflow-y-auto custom-scrollbar mb-4">
      ${listOrNone(residents)}
    </div>

    <div class="font-mono text-[9px] tracking-wider text-zinc-450 font-bold uppercase mb-2 flex items-center gap-1.5"><span class="w-1.5 h-1.5 bg-amber-500 rounded-full"></span> Assigned Personnel (${workers.length})</div>
    <div class="bg-zinc-950/20 border border-zinc-800 rounded px-3 py-1 max-h-[120px] overflow-y-auto custom-scrollbar">
      ${listOrNone(workers)}
    </div>
  `;
} </div>
  `;
}

async function sendChat(cid) {
  const input = document.getElementById('chat-input');
  const question = input.value.trim();
  if (!question) return;
  input.value = '';
  const btn = document.getElementById('chat-send');
  btn.disabled = true;
  btn.textContent = '...';
  try {
    const res = await apiFetch(`/citizen/${cid}/ask`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question })
    });
    if (!res.ok) throw new Error((await res.json()).detail || 'Request failed');
    const data = await res.json();
    const c = state.citizens.find(x => x.id === cid);
    c.chat_history = data.chat_history;
    renderDetail();
  } catch (e) {
    alert(e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'ASK';
  }
}

function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}
