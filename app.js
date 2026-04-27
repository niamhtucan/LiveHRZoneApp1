/* ─── Zone Logic ──────────────────────────────────────────────────────────── */

const ZONE_COLOURS = ['#9E9E9E', '#2196F3', '#4CAF50', '#FF9800', '#F44336'];
const ZONE_NAMES   = ['Zone 1', 'Zone 2', 'Zone 3', 'Zone 4', 'Zone 5'];

function getZone(hr, maxHR) {
  const r = hr / maxHR;
  if (r < 0.60) return 1;
  if (r < 0.70) return 2;
  if (r < 0.80) return 3;
  if (r < 0.90) return 4;
  return 5;
}

function parseHR(dataView) {
  const flags = dataView.getUint8(0);
  const isUint16 = (flags & 0x01) === 1;
  return isUint16 ? dataView.getUint16(1, true) : dataView.getUint8(1);
}

/* ─── State ───────────────────────────────────────────────────────────────── */

const state = {
  users: [
    { name: '', maxHR: 0, device: null, characteristic: null,
      hr: 0, zone: 0, connected: false,
      hrSum: 0, hrCount: 0, zoneTime: [0, 0, 0, 0, 0], lastUpdateAt: null,
      hrHistory: [] },
    { name: '', maxHR: 0, device: null, characteristic: null,
      hr: 0, zone: 0, connected: false,
      hrSum: 0, hrCount: 0, zoneTime: [0, 0, 0, 0, 0], lastUpdateAt: null,
      hrHistory: [] },
  ],
  sessionStart: null,
};

/* ─── Screen Switching ────────────────────────────────────────────────────── */

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => { s.hidden = true; });
  document.getElementById(id).hidden = false;
}

/* ─── Storage Helpers ─────────────────────────────────────────────────────── */

function saveProfile(index) {
  const u = state.users[index];
  try {
    localStorage.setItem('user' + index + 'Profile', JSON.stringify({
      name:     u.name,
      maxHR:    u.maxHR,
      deviceId: u.device ? u.device.id : null,
    }));
  } catch (_) {}
}

function loadProfile(index) {
  try {
    const raw = localStorage.getItem('user' + index + 'Profile');
    return raw ? JSON.parse(raw) : null;
  } catch (_) { return null; }
}

function saveSummary() {
  try {
    localStorage.setItem('sessionSummary', JSON.stringify(
      state.users.map(u => ({
        name:      u.name,
        avgHR:     u.hrCount > 0 ? Math.round(u.hrSum / u.hrCount) : 0,
        zoneTime:  u.zoneTime.slice(),
        totalTime: u.zoneTime.reduce((a, b) => a + b, 0),
      }))
    ));
  } catch (_) {}
}

/* ─── Setup Screen ────────────────────────────────────────────────────────── */

function initSetup() {
  // Pre-fill from saved profiles
  [0, 1].forEach(i => {
    const p = loadProfile(i);
    if (!p) return;
    const nameEl  = document.getElementById('name'  + i);
    const maxHREl = document.getElementById('maxhr' + i);
    if (nameEl  && p.name)  nameEl.value  = p.name;
    if (maxHREl && p.maxHR) maxHREl.value = p.maxHR;
  });

  const startBtn = document.getElementById('startBtn');

  [0, 1].forEach(i => {
    document.getElementById('connect' + i)
      .addEventListener('click', () => connectDevice(i, startBtn));
  });

  startBtn.addEventListener('click', startWorkout);
}

function setStatus(index, text, type) {
  const el = document.getElementById('status' + index);
  el.textContent = text;
  el.className   = 'status' + (type ? ' ' + type : '');
}

async function connectDevice(index, startBtn) {
  const nameEl  = document.getElementById('name'  + index);
  const maxHREl = document.getElementById('maxhr' + index);
  const btn     = document.getElementById('connect' + index);

  const name  = nameEl.value.trim() || 'Athlete ' + (index + 1);
  const maxHR = parseInt(maxHREl.value, 10);

  if (!maxHR || maxHR < 100 || maxHR > 220) {
    setStatus(index, 'Enter a valid max HR (100–220).', 'error');
    return;
  }

  if (!navigator.bluetooth) {
    setStatus(index, 'Web Bluetooth not available. Use Chrome on macOS.', 'error');
    return;
  }

  state.users[index].name  = name;
  state.users[index].maxHR = maxHR;

  setStatus(index, 'Opening Bluetooth picker…', 'connecting');
  btn.disabled = true;

  try {
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ services: ['heart_rate'] }],
    });

    setStatus(index, 'Connecting to ' + device.name + '…', 'connecting');

    const server         = await device.gatt.connect();
    const service        = await server.getPrimaryService('heart_rate');
    const characteristic = await service.getCharacteristic('heart_rate_measurement');

    await characteristic.startNotifications();

    // Listeners set ONCE here — never inside the data handler
    characteristic.addEventListener('characteristicvaluechanged', evt => {
      onHRData(index, evt.target.value);
    });
    device.addEventListener('gattserverdisconnected', () => {
      onDisconnectedSetup(index, startBtn);
    });

    state.users[index].device         = device;
    state.users[index].characteristic = characteristic;
    state.users[index].connected      = true;

    saveProfile(index);

    btn.textContent = 'Connected ✓';
    btn.classList.add('connected');
    btn.disabled = false;
    setStatus(index, 'Connected to ' + device.name, 'connected');
    updateStartButton(startBtn);

  } catch (err) {
    btn.disabled = false;
    if (err.name === 'NotFoundError' || err.name === 'AbortError') {
      setStatus(index, 'No device selected.', '');
    } else {
      setStatus(index, 'Error: ' + err.message, 'error');
    }
  }
}

function onDisconnectedSetup(index, startBtn) {
  state.users[index].connected = false;
  const btn = document.getElementById('connect' + index);
  btn.textContent = 'Connect Watch';
  btn.classList.remove('connected');
  setStatus(index, 'Disconnected. Try reconnecting.', 'error');
  updateStartButton(startBtn);
}

function updateStartButton(startBtn) {
  startBtn.disabled = !(state.users[0].connected && state.users[1].connected);
}

function startWorkout() {
  // Capture any last-minute edits to name/maxHR fields
  [0, 1].forEach(i => {
    const nameEl  = document.getElementById('name'  + i);
    const maxHREl = document.getElementById('maxhr' + i);
    if (nameEl.value.trim())  state.users[i].name  = nameEl.value.trim();
    if (maxHREl.value)        state.users[i].maxHR = parseInt(maxHREl.value, 10);
    saveProfile(i);
  });

  // Reset session accumulators (supports "New Session" without page reload)
  state.sessionStart = Date.now();
  state.users.forEach(u => {
    u.hr           = 0;
    u.zone         = 0;
    u.hrSum        = 0;
    u.hrCount      = 0;
    u.zoneTime     = [0, 0, 0, 0, 0];
    u.lastUpdateAt = null;
    u.hrHistory    = [];
  });

  // Populate tile names and reset display
  [0, 1].forEach(i => {
    document.getElementById('tileName'   + i).textContent = state.users[i].name;
    document.getElementById('tileZone'   + i).textContent = '–';
    document.getElementById('tileHRValue'+ i).textContent = '--';
    document.getElementById('tilePct'    + i).textContent = '--%';
    document.getElementById('tileBar'    + i).style.width = '0%';
    const tile = document.getElementById('tile' + i);
    tile.className = 'tile';
  });

  // Clear canvases for fresh session
  [0, 1].forEach(i => {
    const c = document.getElementById('graphCanvas' + i);
    if (c && c.clientWidth > 0) { c.width = c.clientWidth; c.height = c.clientHeight; }
  });

  // Rewire disconnection handlers for the dashboard context
  state.users.forEach((u, i) => {
    if (u.device) {
      u.device.removeEventListener('gattserverdisconnected', u._setupDisconnectHandler);
      u.device.addEventListener('gattserverdisconnected', () => onDashboardDisconnect(i));
    }
  });

  // Attempt Wake Lock to keep screen on during workout
  if (navigator.wakeLock) {
    navigator.wakeLock.request('screen').catch(() => {});
  }

  showScreen('screen-dashboard');
}

/* ─── HR Data Handler (shared across setup/dashboard contexts) ────────────── */

function onHRData(index, dataView) {
  const hr  = parseHR(dataView);
  const u   = state.users[index];
  const now = Date.now();

  u.hrSum   += hr;
  u.hrCount += 1;

  // Accumulate time in previous zone before updating
  if (u.lastUpdateAt !== null && u.zone > 0) {
    u.zoneTime[u.zone - 1] += now - u.lastUpdateAt;
  }
  u.lastUpdateAt = now;

  const newZone    = getZone(hr, u.maxHR);
  const zoneChanged = newZone !== u.zone;
  u.hr   = hr;
  u.zone = newZone;

  // Record history (capped at 3600 points — 1 hour at 1Hz)
  u.hrHistory.push({ t: now, hr });
  if (u.hrHistory.length > 3600) u.hrHistory.shift();

  // DOM patch — only update what changed
  const hrValueEl = document.getElementById('tileHRValue' + index);
  if (hrValueEl) hrValueEl.textContent = hr;

  const pct = Math.min(100, Math.round((hr / u.maxHR) * 100));

  const pctEl = document.getElementById('tilePct' + index);
  if (pctEl) pctEl.textContent = pct + '%';

  const barEl = document.getElementById('tileBar' + index);
  if (barEl) barEl.style.width = pct + '%';

  if (zoneChanged) {
    const tile = document.getElementById('tile' + index);
    if (tile) {
      tile.classList.remove('zone-1', 'zone-2', 'zone-3', 'zone-4', 'zone-5');
      tile.classList.add('zone-' + newZone);
    }
    const zoneEl = document.getElementById('tileZone' + index);
    if (zoneEl) zoneEl.textContent = ZONE_NAMES[newZone - 1];
  }

  renderUserGraph(document.getElementById('graphCanvas' + index), index);
}

/* ─── Dashboard Disconnection ─────────────────────────────────────────────── */

function onDashboardDisconnect(index) {
  const u    = state.users[index];
  const tile = document.getElementById('tile' + index);
  u.connected = false;

  tile.classList.remove('zone-1', 'zone-2', 'zone-3', 'zone-4', 'zone-5');
  tile.classList.add('tile--disconnected');
  document.getElementById('tileHRValue' + index).textContent = '--';
  document.getElementById('tileZone'    + index).textContent = 'Disconnected';

  const reconnectBtn = document.getElementById('tileReconnect' + index);
  reconnectBtn.style.display = 'block';
  reconnectBtn.onclick = async () => {
    reconnectBtn.style.display = 'none';
    try {
      const server         = await u.device.gatt.connect();
      const service        = await server.getPrimaryService('heart_rate');
      const characteristic = await service.getCharacteristic('heart_rate_measurement');
      await characteristic.startNotifications();

      characteristic.addEventListener('characteristicvaluechanged', evt => {
        onHRData(index, evt.target.value);
      });

      u.characteristic = characteristic;
      u.connected      = true;
      tile.classList.remove('tile--disconnected');
      document.getElementById('tileZone' + index).textContent =
        u.zone ? ZONE_NAMES[u.zone - 1] : '–';
    } catch (_) {
      document.getElementById('tileZone' + index).textContent = 'Disconnected';
      reconnectBtn.style.display = 'block';
    }
  };
}

/* ─── End Workout ─────────────────────────────────────────────────────────── */

function endWorkout() {
  const now = Date.now();

  // Flush remaining zone time for connected users
  state.users.forEach(u => {
    if (u.lastUpdateAt !== null && u.zone > 0) {
      u.zoneTime[u.zone - 1] += now - u.lastUpdateAt;
      u.lastUpdateAt = now;
    }
  });

  saveSummary();

  // Disconnect BLE cleanly
  state.users.forEach(u => {
    try { if (u.device && u.device.gatt.connected) u.device.gatt.disconnect(); } catch (_) {}
    u.connected = false;
  });

  renderSummary();
  showScreen('screen-summary');
}

/* ─── HR Graph (Canvas) ───────────────────────────────────────────────────── */

const GRAPH_BPM_MIN  = 40;
const GRAPH_BPM_MAX  = 220;
const GRAPH_GRID_BPM = [60, 80, 100, 120, 140, 160, 180, 200];

function ensureCanvasSize(canvas) {
  const w   = canvas.clientWidth;
  const h   = canvas.clientHeight;
  const dpr = window.devicePixelRatio || 1;
  const tw  = Math.round(w * dpr);
  const th  = Math.round(h * dpr);
  if (canvas.width !== tw || canvas.height !== th) {
    canvas.width  = tw;
    canvas.height = th;
  }
  return dpr;
}

function renderUserGraph(canvas, userIndex) {
  if (!canvas || canvas.clientWidth === 0) return;

  const dpr = ensureCanvasSize(canvas);
  const ctx = canvas.getContext('2d');
  const W   = canvas.width;
  const H   = canvas.height;

  // Margins (device pixels)
  const ML = 42 * dpr;  // left  — Y-axis labels
  const MT = 10 * dpr;  // top
  const MR =  8 * dpr;  // right
  const MB =  6 * dpr;  // bottom
  const PW = W - ML - MR;  // plot width
  const PH = H - MT - MB;  // plot height

  // BPM → Y (device pixels, plot-relative, then offset by MT)
  function bpmToY(bpm) {
    return MT + PH * (1 - (bpm - GRAPH_BPM_MIN) / (GRAPH_BPM_MAX - GRAPH_BPM_MIN));
  }

  // Clear + background
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#121212';
  ctx.fillRect(0, 0, W, H);

  // Gridlines + Y-axis labels
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth   = 1 * dpr;
  ctx.fillStyle   = 'rgba(255,255,255,0.35)';
  ctx.font        = (10 * dpr) + 'px -apple-system, BlinkMacSystemFont, sans-serif';
  ctx.textAlign   = 'right';
  ctx.textBaseline = 'middle';

  GRAPH_GRID_BPM.forEach(bpm => {
    const y = bpmToY(bpm);
    ctx.beginPath();
    ctx.moveTo(ML, y);
    ctx.lineTo(W - MR, y);
    ctx.stroke();
    ctx.fillText(String(bpm), ML - 5 * dpr, y);
  });

  // No data — axes drawn, stop here
  const history = state.users[userIndex].hrHistory;
  if (history.length < 2) return;

  const t0    = history[0].t;
  const tSpan = Math.max(history[history.length - 1].t - t0, 1);
  const maxHR = state.users[userIndex].maxHR || 190;

  // Time → X (device pixels)
  function tToX(t) {
    return ML + ((t - t0) / tSpan) * PW;
  }

  // Draw zone-coloured line — segment per zone run
  ctx.lineWidth   = 2.5 * dpr;
  ctx.lineJoin    = 'round';
  ctx.lineCap     = 'round';

  let currentZone = null;

  history.forEach((p, idx) => {
    const zone = getZone(p.hr, maxHR);
    const x    = tToX(p.t);
    const y    = bpmToY(p.hr);

    if (idx === 0) {
      ctx.beginPath();
      ctx.strokeStyle = ZONE_COLOURS[zone - 1];
      ctx.moveTo(x, y);
      currentZone = zone;
      return;
    }

    if (zone !== currentZone) {
      // Extend current segment to this point (seamless join), then start new colour
      ctx.lineTo(x, y);
      ctx.stroke();
      ctx.beginPath();
      ctx.strokeStyle = ZONE_COLOURS[zone - 1];
      ctx.moveTo(x, y);
      currentZone = zone;
    } else {
      ctx.lineTo(x, y);
    }
  });
  ctx.stroke();
}

/* ─── Summary Screen ──────────────────────────────────────────────────────── */

function formatMinSec(ms) {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m + 'm ' + String(s).padStart(2, '0') + 's';
}

function renderSummary() {
  state.users.forEach((u, i) => {
    const card = document.getElementById('summaryCard' + i);

    card.querySelector('.summary-card__name').textContent  = u.name || 'Athlete ' + (i + 1);
    card.querySelector('.summary-avg-hr').textContent      = u.hrCount > 0 ? u.hrCount && Math.round(u.hrSum / u.hrCount) + ' bpm' : '--';
    card.querySelector('.summary-total-time').textContent  = formatMinSec(u.zoneTime.reduce((a, b) => a + b, 0));

    const maxZoneMs = Math.max(...u.zoneTime, 1);
    u.zoneTime.forEach((ms, z) => {
      const pct   = Math.round((ms / maxZoneMs) * 100);
      const fill  = card.querySelector('.zone-bar-fill-'  + z);
      const label = card.querySelector('.zone-bar-label-' + z);
      if (fill)  { fill.style.width = pct + '%'; fill.style.backgroundColor = ZONE_COLOURS[z]; }
      if (label) label.textContent = formatMinSec(ms);
    });
  });

  // Render per-user summary graphs from full session history
  renderUserGraph(document.getElementById('graphCanvasSummary0'), 0);
  renderUserGraph(document.getElementById('graphCanvasSummary1'), 1);
}

function initNewSession() {
  // Disconnect any lingering BLE before returning to setup
  state.users.forEach(u => {
    try { if (u.device && u.device.gatt.connected) u.device.gatt.disconnect(); } catch (_) {}
    u.connected      = false;
    u.device         = null;
    u.characteristic = null;
  });

  // Reset connect buttons and status
  [0, 1].forEach(i => {
    const btn = document.getElementById('connect' + i);
    btn.textContent = 'Connect Watch';
    btn.classList.remove('connected');
    setStatus(i, 'Not connected', '');
  });

  document.getElementById('startBtn').disabled = true;
  showScreen('screen-setup');
}

/* ─── Boot ────────────────────────────────────────────────────────────────── */

document.addEventListener('DOMContentLoaded', () => {
  initSetup();
  document.getElementById('endBtn').addEventListener('click', endWorkout);
  document.getElementById('newSessionBtn').addEventListener('click', initNewSession);
});
