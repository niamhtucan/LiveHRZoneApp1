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
  sessionMode: 'duo', // 'solo' | 'duo' — memory only, never localStorage
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

function setSessionMode(mode, startBtn) {
  state.sessionMode = mode;
  document.getElementById('setupUser1').hidden = (mode === 'solo');
  if (mode === 'solo' && state.users[1].connected) {
    try { state.users[1].device.gatt.disconnect(); } catch (_) {}
    state.users[1].connected = false;
    document.getElementById('connect1').textContent = 'Connect Watch';
    document.getElementById('connect1').classList.remove('connected');
    setStatus(1, 'Not connected', '');
  }
  updateStartButton(startBtn);
}

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

  document.querySelectorAll('input[name="sessionMode"]').forEach(radio => {
    radio.addEventListener('change', () => setSessionMode(radio.value, startBtn));
  });

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
  if (state.sessionMode === 'solo') {
    startBtn.disabled = !state.users[0].connected;
  } else {
    startBtn.disabled = !(state.users[0].connected && state.users[1].connected);
  }
}

function startWorkout() {
  // Hard gate — enforce connection requirements regardless of button state
  if (!state.users[0].connected) return;
  if (state.sessionMode === 'duo' && !state.users[1].connected) return;

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

  // Apply solo/duo layout class to dashboard
  document.getElementById('screen-dashboard')
    .classList.toggle('solo-mode', state.sessionMode === 'solo');

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

  const isDashboard = canvas.id === 'graphCanvas0' || canvas.id === 'graphCanvas1';

  const dpr = ensureCanvasSize(canvas);
  const ctx = canvas.getContext('2d');
  const W   = canvas.width;
  const H   = canvas.height;

  // Margins (device pixels) — dashboard gets extra bottom room for X-axis labels
  const ML = 42 * dpr;
  const MT = 10 * dpr;
  const MR =  8 * dpr;
  const MB = isDashboard ? 22 * dpr : 6 * dpr;
  const PW = W - ML - MR;
  const PH = H - MT - MB;

  function bpmToY(bpm) {
    return MT + PH * (1 - (bpm - GRAPH_BPM_MIN) / (GRAPH_BPM_MAX - GRAPH_BPM_MIN));
  }

  // Clear + background
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#121212';
  ctx.fillRect(0, 0, W, H);

  // Y-axis gridlines + labels
  ctx.strokeStyle  = 'rgba(255,255,255,0.08)';
  ctx.lineWidth    = 1 * dpr;
  ctx.fillStyle    = 'rgba(255,255,255,0.35)';
  ctx.font         = (10 * dpr) + 'px -apple-system, BlinkMacSystemFont, sans-serif';
  ctx.textAlign    = 'right';
  ctx.textBaseline = 'middle';

  GRAPH_GRID_BPM.forEach(bpm => {
    const y = bpmToY(bpm);
    ctx.beginPath();
    ctx.moveTo(ML, y);
    ctx.lineTo(W - MR, y);
    ctx.stroke();
    ctx.fillText(String(bpm), ML - 5 * dpr, y);
  });

  const history = state.users[userIndex].hrHistory;
  if (history.length < 2) return;

  const maxHR  = state.users[userIndex].maxHR || 190;
  const firstT = history[0].t;
  const lastT  = history[history.length - 1].t;

  // Rolling 3-minute window on dashboard; full session on summary
  const WINDOW_MS   = 3 * 60 * 1000;
  const windowStart = isDashboard ? lastT - WINDOW_MS : firstT;
  const tSpan       = isDashboard ? WINDOW_MS : Math.max(lastT - firstT, 1);

  function tToX(t) {
    return ML + ((t - windowStart) / tSpan) * PW;
  }

  // X-axis time labels (dashboard only) — at 0, 1, 2, 3 minute marks
  if (isDashboard) {
    ctx.fillStyle    = 'rgba(255,255,255,0.35)';
    ctx.font         = (9 * dpr) + 'px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'top';
    [0, 1, 2, 3].forEach(min => {
      const t = windowStart + min * 60000;
      if (t < firstT) return;
      const x      = ML + (min / 3) * PW;
      const elSec  = Math.round((t - firstT) / 1000);
      const m      = Math.floor(elSec / 60);
      const s      = elSec % 60;
      ctx.fillText(m + ':' + String(s).padStart(2, '0'), x, H - MB + 4 * dpr);
    });
  }

  // Draw zone-coloured line — only points within the window
  const visibleHistory = isDashboard
    ? history.filter(p => p.t >= windowStart)
    : history;

  if (visibleHistory.length < 2) return;

  ctx.lineWidth = 2.5 * dpr;
  ctx.lineJoin  = 'round';
  ctx.lineCap   = 'round';

  let currentZone = null;

  visibleHistory.forEach((p, idx) => {
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

  document.getElementById('modeDuo').checked = true;
  setSessionMode('duo', document.getElementById('startBtn'));
  showScreen('screen-setup');
}

/* ─── Boot ────────────────────────────────────────────────────────────────── */

document.addEventListener('DOMContentLoaded', () => {
  initSetup();
  document.getElementById('endBtn').addEventListener('click', endWorkout);
  document.getElementById('newSessionBtn').addEventListener('click', initNewSession);
});

/* ─── Confetti ────────────────────────────────────────────────────────────── */
(function () {
  const PALETTE = ['#BADDCF', '#E8F3DA', '#6787AF', '#19123D', '#B2F332', '#F3EEE8'];

  function startConfetti() {
    const canvas = document.getElementById('confettiCanvas');
    if (!canvas) return;
    canvas.width  = window.innerWidth;
    canvas.height = window.innerHeight;
    canvas.style.display = 'block';

    const ctx = canvas.getContext('2d');
    const W = canvas.width;
    const H = canvas.height;

    const pieces = Array.from({ length: 130 }, () => ({
      x:      Math.random() * W,
      y:      Math.random() * H - H,
      w:      6 + Math.random() * 10,
      h:      3 + Math.random() * 6,
      colour: PALETTE[Math.floor(Math.random() * PALETTE.length)],
      vx:     (Math.random() - 0.5) * 2,
      vy:     2.5 + Math.random() * 3,
      angle:  Math.random() * Math.PI * 2,
      spin:   (Math.random() - 0.5) * 0.15,
    }));

    const end = Date.now() + 3000;

    function draw() {
      const remaining = end - Date.now();
      if (remaining <= 0) {
        ctx.clearRect(0, 0, W, H);
        canvas.style.display = 'none';
        return;
      }
      ctx.clearRect(0, 0, W, H);
      ctx.globalAlpha = Math.min(1, remaining / 600);
      pieces.forEach(p => {
        p.x += p.vx;
        p.y += p.vy;
        p.angle += p.spin;
        if (p.y > H) { p.y = -p.h; p.x = Math.random() * W; }
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.angle);
        ctx.fillStyle = p.colour;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
      });
      requestAnimationFrame(draw);
    }
    draw();
  }

  document.addEventListener('DOMContentLoaded', () => {
    const summaryScreen = document.getElementById('screen-summary');
    new MutationObserver(() => {
      if (!summaryScreen.hasAttribute('hidden')) startConfetti();
    }).observe(summaryScreen, { attributes: true, attributeFilter: ['hidden'] });
  });
}());
