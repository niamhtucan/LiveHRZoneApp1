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
    { name: '', maxHR: 0, weight: 70, device: null, characteristic: null,
      hr: 0, zone: 0, connected: false,
      hrSum: 0, hrCount: 0, zoneTime: [0, 0, 0, 0, 0], lastUpdateAt: null,
      hrHistory: [] },
    { name: '', maxHR: 0, weight: 70, device: null, characteristic: null,
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
      weight:   u.weight,
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
    const nameEl   = document.getElementById('name'   + i);
    const maxHREl  = document.getElementById('maxhr'  + i);
    const weightEl = document.getElementById('weight' + i);
    if (nameEl   && p.name)   nameEl.value   = p.name;
    if (maxHREl  && p.maxHR)  maxHREl.value  = p.maxHR;
    if (weightEl && p.weight) weightEl.value = p.weight;
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
  const nameEl   = document.getElementById('name'   + index);
  const maxHREl  = document.getElementById('maxhr'  + index);
  const weightEl = document.getElementById('weight' + index);
  const btn      = document.getElementById('connect' + index);

  const name   = nameEl.value.trim() || 'Athlete ' + (index + 1);
  const maxHR  = parseInt(maxHREl.value, 10);
  const wVal   = parseInt(weightEl.value, 10);
  const weight = (wVal >= 30 && wVal <= 200) ? wVal : 70;

  if (!maxHR || maxHR < 100 || maxHR > 220) {
    setStatus(index, 'Enter a valid max HR (100–220).', 'error');
    return;
  }

  if (!navigator.bluetooth) {
    setStatus(index, 'Web Bluetooth not available. Use Chrome on macOS.', 'error');
    return;
  }

  state.users[index].name   = name;
  state.users[index].maxHR  = maxHR;
  state.users[index].weight = weight;

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
    const nameEl   = document.getElementById('name'   + i);
    const maxHREl  = document.getElementById('maxhr'  + i);
    const weightEl = document.getElementById('weight' + i);
    if (nameEl.value.trim())  state.users[i].name  = nameEl.value.trim();
    if (maxHREl.value)        state.users[i].maxHR = parseInt(maxHREl.value, 10);
    const wVal = parseInt(weightEl.value, 10);
    if (wVal >= 30 && wVal <= 200) state.users[i].weight = wVal;
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

/* ─── Calorie + Award Calculations ───────────────────────────────────────── */

const ZONE_METS = [3.0, 5.0, 7.0, 9.0, 11.0];

function estimateCalories(user) {
  const kg = (user.weight >= 30 && user.weight <= 200) ? user.weight : 70;
  return Math.round(
    user.zoneTime.reduce((sum, ms, z) => sum + (ms / 60000) * ZONE_METS[z] * kg / 60, 0)
  );
}

function computeAwards(users) {
  const awards = [];
  const isSolo = state.sessionMode === 'solo';

  // ── Cool Down Champion ──────────────────────────────────────────────────
  function recoveryTimes(u) {
    const times = [];
    let lastZ3t = null;
    u.hrHistory.forEach(p => {
      const z = getZone(p.hr, u.maxHR);
      if (z >= 3) {
        lastZ3t = p.t;
      } else if (z === 1 && lastZ3t !== null) {
        times.push(p.t - lastZ3t);
        lastZ3t = null;
      }
    });
    return times;
  }

  const rt0 = recoveryTimes(users[0]);
  const rt1 = isSolo ? [] : recoveryTimes(users[1]);
  const avg0 = rt0.length >= 2 ? rt0.reduce((a, b) => a + b, 0) / rt0.length : Infinity;
  const avg1 = rt1.length >= 2 ? rt1.reduce((a, b) => a + b, 0) / rt1.length : Infinity;

  if (avg0 !== Infinity || avg1 !== Infinity) {
    let winner, desc;
    const diff = Math.abs(avg0 - avg1);
    if (isSolo || avg1 === Infinity) {
      winner = users[0].name;
      desc   = 'Avg recovery: ' + formatMinSec(avg0);
    } else if (avg0 === Infinity) {
      winner = users[1].name;
      desc   = 'Avg recovery: ' + formatMinSec(avg1);
    } else if (diff <= 5000) {
      winner = users[0].name + ' & ' + users[1].name;
      desc   = 'Tied — ' + formatMinSec(Math.min(avg0, avg1));
    } else {
      const w = avg0 < avg1 ? users[0] : users[1];
      winner = w.name;
      desc   = 'Avg recovery: ' + formatMinSec(Math.min(avg0, avg1));
    }
    awards.push({ id: 'cooldown', title: 'Cool Down Champion', winner, desc });
  }

  // ── Range Ruler ─────────────────────────────────────────────────────────
  function hrRange(u) {
    if (!state.sessionStart || u.hrHistory.length < 2) return null;
    const rangeStart = state.sessionStart + 5 * 60 * 1000;
    const rangeEnd   = u.hrHistory[u.hrHistory.length - 1].t - 5 * 60 * 1000;
    const trimmed    = u.hrHistory.filter(p => p.t >= rangeStart && p.t <= rangeEnd);
    if (trimmed.length < 2) return null;
    return Math.max(...trimmed.map(p => p.hr)) - Math.min(...trimmed.map(p => p.hr));
  }

  const range0 = hrRange(users[0]);
  const range1 = isSolo ? null : hrRange(users[1]);

  if (range0 !== null || range1 !== null) {
    let winner, desc;
    if (isSolo || range1 === null) {
      winner = users[0].name;
      desc   = 'HR range: ' + (range0 ?? range1) + ' bpm';
    } else if (range0 === null) {
      winner = users[1].name;
      desc   = 'HR range: ' + range1 + ' bpm';
    } else if (range0 === range1) {
      winner = users[0].name + ' & ' + users[1].name;
      desc   = 'Tied — ' + range0 + ' bpm range';
    } else {
      const w = range0 > range1 ? users[0] : users[1];
      winner = w.name;
      desc   = 'HR range: ' + Math.max(range0, range1) + ' bpm';
    }
    awards.push({ id: 'range', title: 'Range Ruler', winner, desc });
  }

  // ── Max Calorie ──────────────────────────────────────────────────────────
  const cal0 = users[0].hrCount > 0 ? estimateCalories(users[0]) : null;
  const cal1 = (!isSolo && users[1].hrCount > 0) ? estimateCalories(users[1]) : null;

  if (cal0 !== null || cal1 !== null) {
    let winner, desc;
    if (isSolo || cal1 === null) {
      winner = users[0].name;
      desc   = (cal0 ?? cal1) + ' kcal';
    } else if (cal0 === null) {
      winner = users[1].name;
      desc   = cal1 + ' kcal';
    } else if (Math.abs(cal0 - cal1) <= 10) {
      winner = users[0].name + ' & ' + users[1].name;
      desc   = 'Tied — ' + Math.max(cal0, cal1) + ' kcal';
    } else {
      const w = cal0 > cal1 ? users[0] : users[1];
      winner = w.name;
      desc   = Math.max(cal0, cal1) + ' kcal';
    }
    awards.push({ id: 'calorie', title: 'Max Calorie', winner, desc });
  }

  return awards;
}

const AWARD_ICONS = {
  cooldown: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <line x1="12" y1="2" x2="12" y2="22"/><line x1="2" y1="12" x2="22" y2="12"/>
    <line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/><line x1="19.07" y1="4.93" x2="4.93" y2="19.07"/>
    <circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none"/>
  </svg>`,
  range: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <line x1="12" y1="3" x2="12" y2="21"/>
    <polyline points="7 8 12 3 17 8"/><polyline points="7 16 12 21 17 16"/>
    <line x1="7" y1="12" x2="17" y2="12"/>
  </svg>`,
  calorie: `<svg viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 2C9.5 5.5 7 8 7 12a5 5 0 0 0 10 0c0-1.8-.7-3.4-1.8-5C14.5 8.8 13 10 12 10c0-2.5 1-5 0-8z"/>
  </svg>`,
};

const AWARD_SHAPES = {
  cooldown: 'circle',
  range:    'shield',
  calorie:  'pennant',
};

const AWARD_ACCENTS = {
  cooldown: '#6787AF',
  range:    '#BADDCF',
  calorie:  '#B2F332',
};

function renderAwards(awards) {
  const section = document.getElementById('awardsSection');
  if (!awards.length) { section.hidden = true; return; }

  section.innerHTML = awards.map(a => {
    const shape  = AWARD_SHAPES[a.id];
    const accent = AWARD_ACCENTS[a.id];
    const icon   = AWARD_ICONS[a.id];
    return `<div class="award-badge award-badge--${shape}" style="--accent:${accent}">
      <div class="award-badge__border">
        <div class="award-badge__inner">${icon}</div>
      </div>
      <div class="award-badge__desc">${a.desc}</div>
      <div class="award-badge__title">${a.title}</div>
      <div class="award-badge__winner">${a.winner}</div>
    </div>`;
  }).join('');

  section.hidden = false;
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
    card.querySelector('.summary-avg-hr').textContent      = u.hrCount > 0 ? Math.round(u.hrSum / u.hrCount) + ' bpm' : '--';
    card.querySelector('.summary-total-time').textContent  = formatMinSec(u.zoneTime.reduce((a, b) => a + b, 0));

    const peakHR = u.hrHistory.length > 0 ? Math.max(...u.hrHistory.map(p => p.hr)) : null;
    card.querySelector('.summary-max-hr').textContent      = peakHR !== null ? peakHR + ' bpm' : '--';
    card.querySelector('.summary-calories').textContent    = u.hrCount > 0 ? estimateCalories(u) + ' kcal' : '--';

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

  renderAwards(computeAwards(state.users));
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
