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
    `<div class="log-entry"><span class="day-tag">D${l.day}</span>${escapeHtml(l.text)}</div>`
  ).join('') || '<p class="empty-note">Nothing logged yet.</p>';
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
    `<div class="agency-chain"><b>${escapeHtml(a.role)}</b>: ${a.chain.map(escapeHtml).join(' \u2192 ')}</div>`
  ).join('');

  const awareCount = ev.citizen_report.filter(r => r.aware).length;
  const rowsHtml = ev.citizen_report.map(r => `
    <div class="event-row">
      <span class="who">${r.aware ? '\u2713' : '\u2717'} ${escapeHtml(r.name)}</span> <span class="empty-note">(${escapeHtml(r.occupation)})</span>
      <span class="${r.aware ? 'aware-yes' : 'aware-no'}"> \u2014 ${r.aware ? 'AWARE' : 'NOT AWARE'}</span>:
      "${escapeHtml(r.reaction)}"
    </div>
  `).join('');

  document.getElementById('event-report-body').innerHTML = `
    <div class="label">${escapeHtml(ev.event_name)} \u2014 ${escapeHtml(ev.location)}</div>
    <div class="event-report-narrative">${escapeHtml(ev.narrative)}</div>
    <div class="label">Agency Response</div>
    ${chainsHtml}
    <div class="label" style="margin-top:10px;">Citizen Awareness (${awareCount}/${ev.citizen_report.length} aware)</div>
    ${rowsHtml}
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
  if (!c) { panel.innerHTML = '<div class="empty-note">Click a citizen or a building on the map to see more.</div>'; return; }

  const traits = c.personality || {};
  const scheduleHtml = (c.schedule || []).map(s => {
    const isNow = simHour >= s.start_hour && simHour < s.end_hour;
    const range = `${String(s.start_hour).padStart(2, '0')}-${String(s.end_hour).padStart(2, '0')}`;
    return `<div class="schedule-item ${isNow ? 'now' : ''}">
       <div class="hr">${range}</div>
       <div class="loc">${escapeHtml(s.location)}</div>
       <div class="act">${escapeHtml(s.activity)}</div>
     </div>`;
  }).join('') || '<p class="empty-note">No schedule yet.</p>';

  const memoriesHtml = (c.memories || []).slice().reverse().map(m => `<div class="memory-item">${escapeHtml(m)}</div>`).join('') || '<p class="empty-note">No memories yet.</p>';

  const chatHtml = (c.chat_history || []).map(m =>
    `<div class="chat-msg ${m.role === 'user' ? 'user' : 'citizen'}">${m.role === 'user' ? '\u2192 ' : ''}${escapeHtml(m.text)}</div>`
  ).join('');

  panel.innerHTML = `
    <div class="name">${escapeHtml(c.name)}</div>
    <div class="occ">${escapeHtml(c.occupation)}, ${c.age} \u00b7 #${String(c.id).padStart(3, '0')}</div>

    <div class="label">Personality</div>
    ${Object.entries(traits).map(([k, v]) => `
      <div class="trait-row"><div class="tname">${k}</div><div class="trait-bar"><i style="width:${v}%;"></i></div></div>
    `).join('')}

    <div class="label" style="margin-top:12px;">Status</div>
    <div class="stat-row"><span>Mood</span><span class="v">${c.mood}%</span></div>
    <div class="stat-row"><span>Money</span><span class="v">\u20b9${(c.money || 0).toLocaleString('en-IN')}</span></div>
    <div class="stat-row"><span>Goal</span><span class="v" style="text-align:right;max-width:60%;">${escapeHtml(c.goal)}</span></div>
    ${c.last_action ? `<div class="stat-row"><span>Today</span><span class="v" style="text-align:right;max-width:60%;">${escapeHtml(c.last_action)}</span></div>` : ''}

    <div class="label" style="margin-top:12px;">Schedule</div>
    <div class="schedule-list">${scheduleHtml}</div>

    <div class="label" style="margin-top:12px;">Memories</div>
    ${memoriesHtml}

    <div class="label" style="margin-top:12px;">Ask ${escapeHtml(c.name.split(' ')[0])} directly</div>
    <div class="chat-thread" id="chat-thread">${chatHtml}</div>
    <div class="chat-input-row">
      <input type="text" id="chat-input" placeholder="Why did you do that today?" />
      <button class="btn small" id="chat-send">Ask</button>
    </div>
  `;

  document.getElementById('chat-send').addEventListener('click', () => sendChat(c.id));
  document.getElementById('chat-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(c.id); });
}

function renderBuildingDetail(panel) {
  const b = state.buildings.find(x => x.name === selectedBuilding);
  if (!b) { panel.innerHTML = '<div class="empty-note">Click a citizen or a building on the map to see more.</div>'; return; }

  const residents = state.citizens.filter(c => c.home === b.name);
  const workers = state.citizens.filter(c => c.workplace === b.name);
  const presentNow = state.citizens.filter(c => currentLocationFor(c) === b.name);

  const listOrNone = (arr) => arr.length
    ? arr.map(c => `<div class="memory-item">${escapeHtml(c.name)} (${escapeHtml(c.occupation)})</div>`).join('')
    : '<p class="empty-note">None.</p>';

  panel.innerHTML = `
    <div class="name">${b.emoji} ${escapeHtml(b.name)}</div>
    <div class="occ">${escapeHtml(b.category || 'Landmark')}</div>

    <div class="label">Coordinates</div>
    <div class="stat-row"><span>Lat, Lon</span><span class="v">${b.lat.toFixed(5)}, ${b.lon.toFixed(5)}</span></div>

    <div class="label" style="margin-top:12px;">Currently Present (${presentNow.length})</div>
    ${listOrNone(presentNow)}

    <div class="label" style="margin-top:12px;">Residents</div>
    ${listOrNone(residents)}

    <div class="label" style="margin-top:12px;">Workers</div>
    ${listOrNone(workers)}
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
    btn.textContent = 'Ask';
  }
}

function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}
