# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview
Live heart rate zone dashboard for 2 Garmin users training together.
Displays real-time HR and zones on a shared MacBook screen running Chrome.
MVP only — no backend, no accounts, no history beyond session summary.

## Tech Stack
- Plain HTML / CSS / JS (no framework, no build step)
- Web Bluetooth API (`navigator.bluetooth`) — requires Chrome on macOS (not Safari, not Firefox)
- `localStorage` for session summary + user profiles (name, maxHR, device.id per user)
- `sessionStorage` for passing config between pages within a session

## How to Run
Serve locally over HTTP — Web Bluetooth requires a secure context (localhost counts):
```
cd LiveHRZoneApp1
python3 -m http.server 8080
```
Then open `http://localhost:8080` in Chrome. Direct `file://` URLs will not work.

**Chrome requirement:** Go to `chrome://flags` and confirm `#enable-web-bluetooth` is not disabled. On macOS, Chrome must have Bluetooth permission granted in System Settings → Privacy & Security → Bluetooth.

## Project Structure
```
LiveHRZoneApp1/
├── index.html   ← single-page app: all three screens in one file
├── style.css    ← all styles
├── app.js       ← BLE logic, zone calculation, state, screen switching
└── CLAUDE.md
```

## Key Users & Devices
- 2 users: Niamh (Garmin Venu Sq) + partner (Garmin Fenix)
- Display device: MacBook running Chrome
- Both watches broadcast HR over BLE standard GATT Heart Rate Service

## Code Architecture

### Single-page app — three screens, one HTML file
`index.html` contains three `<div class="screen">` sections: `#screen-setup`, `#screen-dashboard`, `#screen-summary`. Only one is visible at a time. `showScreen(id)` sets `hidden` on all screens then removes it from the target.

### State
A single `state` object at module scope holds both users' runtime data (HR, zone, BLE objects, accumulated zone time). Because there is no page navigation, BLE objects remain alive in `state` for the entire session. HR data never touches `localStorage` — it lives in `state` only.

### BLE connection flow
`connectDevice(index)` is called only from a button click handler on the setup screen. It runs the full GATT chain:
`requestDevice` → `gatt.connect()` → `getPrimaryService('heart_rate')` → `getCharacteristic('heart_rate_measurement')` → `startNotifications()`.

Both `characteristicvaluechanged` and `gattserverdisconnected` listeners are attached **once** at the end of `connectDevice`. On `startWorkout()`, the `gattserverdisconnected` handler is rewired from `onDisconnectedSetup` to `onDashboardDisconnect` so the dashboard context gets the right behaviour.

### Zone calculation
`getZone(hr, maxHR)` is a pure function. `parseHR(dataView)` reads the flags byte first — bit 0 = 0 means HR is uint8 at byte 1; bit 0 = 1 means HR is uint16 (little-endian) at bytes 1–2.

### Session data flow
Setup screen → `startWorkout()` resets accumulators and calls `showScreen('screen-dashboard')`. On "End Workout" → `endWorkout()` flushes zone time, calls `saveSummary()` (writes to `localStorage`), calls `renderSummary()` to populate summary DOM, then `showScreen('screen-summary')`. "New Session" → `initNewSession()` disconnects BLE, resets buttons, calls `showScreen('screen-setup')`.

## HR Zone Logic (DO NOT deviate)
```
ratio = currentHR / maxHR
< 0.60 → Zone 1 (Grey,   #9E9E9E)
< 0.70 → Zone 2 (Blue,   #2196F3)
< 0.80 → Zone 3 (Green,  #4CAF50)
< 0.90 → Zone 4 (Orange, #FF9800)
>= 0.90 → Zone 5 (Red,   #F44336)
```

## Design System
- Dark theme. Background: `#121212`. Card background: `#1E1E1E`
- Zone colour fills the **entire** card background via `.zone-1` through `.zone-5` classes — not a badge or strip
- Zone transitions use CSS `transition: background-color 0.5s ease` on `.tile` — never `style.backgroundColor` on every tick
- **Primary tile metric: % of maxHR** (large, `~80px+`, bold). BPM is secondary (`22px`, below the %). Elements: `.tile__pct` and `.tile__bpm`
- Zone label: 24px, bold, white. Buttons: pill shape, solid fill, no outlines
- Typography: `-apple-system, BlinkMacSystemFont, sans-serif` — no Google Fonts
- Dashboard layout: two equal tiles side by side (CSS Grid) + shared HR graph below tiles

## HR Graph
- **Canvas-based**, no libraries. One `<canvas>` per user — no shared graph.
- **Dashboard canvases**: `#graphCanvas0`, `#graphCanvas1` — redrawn on every `onHRData()` call via `renderUserGraph(canvas, userIndex)`
- **Summary canvases**: `#graphCanvasSummary0`, `#graphCanvasSummary1` — rendered once by `renderSummary()` from full `hrHistory`
- `ensureCanvasSize(canvas)` resizes canvas pixel dimensions to `clientWidth/Height * devicePixelRatio` only when dimensions change — prevents unnecessary clears and supports Retina/HiDPI
- **Line colour**: zone-coloured segments. Line colour changes at zone boundaries using consecutive segment detection — each segment runs `beginPath → moveTo → lineTo → stroke` with `strokeStyle = ZONE_COLOURS[zone-1]`. The join point is included in both the ending and starting segment for a seamless colour transition.
- **Y axis**: fixed 40–220 BPM. `bpmToY(bpm) = MT + PH * (1 - (bpm - 40) / 180)`. Gridlines at 60/80/100/120/140/160/180/200 BPM. Labels in small grey text, right-aligned in the 42px left margin.
- **X axis**: spans first to last point in that user's `hrHistory`. `tToX(t) = ML + ((t - t0) / tSpan) * PW`
- `hrHistory` per user: max 3600 `{t, hr}` entries (1 hour @ 1Hz). Recording starts at first BLE notification (during setup), not at "Start Workout"
- Layout: `.user-panels` (flex row) → `.user-panel` (flex column) → `[tile][canvas]`. Replaces the old `.tiles` CSS Grid.

## Critical Rules
- NEVER use a framework — plain JS only, no imports, no npm
- NEVER use `localStorage` for HR data — session HR lives in `state` in memory only
- NEVER call `navigator.bluetooth.requestDevice()` except inside a user-gesture handler (button click)
- NEVER add `addEventListener` inside the `characteristicvaluechanged` handler — set listeners once at connect time
- Always handle BLE disconnection gracefully — `gattserverdisconnected` fires; show "Disconnected" on tile, never crash
- Use inline error messages in the UI — never `alert()`
- BLE Heart Rate Service UUID: `0x180D` / characteristic: `0x2A37`

## Setup Screen Layout

The setup screen (`#screen-setup`) uses a **swipe-card viewport** — one athlete card visible at a time:

- `.setup-card-viewport` — `overflow: hidden`, `max-width: 480px`
- `.setup-card-track` — flex row of two `.setup-user` cards; `transform: translateX(0 or -100%)` for navigation
- `.setup-card-dots` — dot pagination (hidden in solo mode)
- `.watch-indicators` — row of smartwatch SVG icons above the viewport, one per user; grey (`#9E9E9E`) when disconnected, lime (`#B2F332`) when connected via `.watch-indicator--connected` class

**Navigation:** `showSetupCard(index)` sets track `translateX` and toggles dot `.active` class. Touch swipe (touchstart/touchend) and dot click both call `showSetupCard`. In solo mode swipe is disabled and dots/indicator1 are hidden.

**Connection state updates:** `updateWatchIndicator(index)` toggles `.watch-indicator--connected` and updates the name label. Called from `connectDevice()` (success), `onDisconnectedSetup()`, `initSetup()` (init), and `setSessionMode()` (on disconnect).

**All existing element IDs unchanged:** `setupUser0/1`, `connect0/1`, `name0/1`, `maxhr0/1`, `weight0/1`, `status0/1`.

## Session Mode
`state.sessionMode` — `'duo'` (default) or `'solo'`. Memory-only, never written to localStorage.

- **Duo**: both users must connect before "Start Session" enables. Dashboard shows two tiles side by side.
- **Solo**: only User 0's setup card is shown. "Start Session" enables when User 0 connects. Dashboard adds `solo-mode` CSS class — hides User 1 panel, centres User 0 panel (`max-width: 640px`).

`setSessionMode(mode, startBtn)` handles all UI side-effects: toggling `.mode-btn--active`, hiding/showing `#setupUser1`, disconnecting User 1 if switching to solo mid-connect, calling `updateStartButton()`. `initNewSession()` resets mode to `'duo'`.

## Navigation Flow

```
Landing → Let's Go → Mode Selector → Continue → Setup → Start Workout → Dashboard → End Workout → Summary
               ↑ back          ↑ back                                                        ↑ back (→ Landing via initNewSession)
```

Back arrows appear on **Mode Selector**, **Setup**, and **Summary**. No back arrow on Landing or Dashboard.

- Mode → back → Landing: `showScreen('screen-landing')` — radio selections preserved
- Setup → back → Mode: `showScreen('screen-mode')` — form inputs and BLE connections preserved
- Summary → back → Landing: `initNewSession()` — resets state, disconnects BLE, goes to landing

`.back-btn` is `position: absolute; top: 16px; left: 12px; z-index: 3; 44×44px touch target`.
On mode and setup screens, `.setup-logo` is shifted to `left: 60px` to avoid overlap.

## Workout Type

`state.workoutType` — `'free-ride'` or `'tabata'`. Set on the mode selector screen, `null` until selected. Memory-only.

- **Free Ride**: no guided structure. Dashboard shows tiles + graphs, no overlay.
- **Tabata Ride**: `startTabata()` is called from `startWorkout()` after `showScreen`. Adds `.tabata-mode` class to `#screen-dashboard`, hides `.dash-hero`, shows `#tabataOverlay`.

## Tabata Mode

### Phase engine
`TABATA_PHASES` — constant array of 9 phase objects (35 min total: warmup 5 + 4×tabata + 3×recovery + cooldown 5 + 1 brief recovery).

Each phase object: `{ id, name, durationMs, type, targetZones, prompts, alerts }`. Tabata-type phases also have `{ rounds, workMs, restMs, physiologicalLag }`.

### Timer architecture
All timing uses `Date.now()` diffs — never accumulated `setInterval` ticks. Two timestamps:
- `state.tabata.phaseStartTime` — when current phase began
- `state.tabata.intervalStartTime` — when current work/rest interval began

A 100ms `setInterval` drives `tickTabata()`. Each tick: check phase completion → check interval completion → update DOM → run HR evaluation every 3s.

### State
`state.tabata` holds: `active`, `intervalId`, `phaseIndex`, `phaseStartTime`, `roundIndex`, `intervalPhase`, `intervalStartTime`, `lastHRCheckTime`, `promptTimerId`, `promptPriority` (0=idle,1=info,2=alert,3=safety), `users[i].lowHRRoundCount`, `completions[]`, `recoveryData[]`.

### Prompt system
`showTabataPrompt(text, type, durationMs, userIndex)` — types: `info/alert/safety`. Lower-priority prompts cannot replace higher-priority ones still displayed. In duo mode with `userIndex` provided, text is prefixed with the user's name.

### Physiological lag rule
HR evaluation is skipped for rounds 0–2 of every Tabata set (lag for HR to respond to short intervals). `phase.physiologicalLag === true` enables the guard in `evaluateHR()`.

### Safety checks
Run on every HR data point inside `onHRData()` (not the 3s eval loop): ≥97% maxHR → alert prompt; ≥100% maxHR → safety prompt.

### Summary metrics (Tabata only)
`state.tabata.completions` — `[{ setId, round, zone }]` per round.
`state.tabata.recoveryData` — `[{ setId, round, dropMs }]`.
Computed in `renderSummary()`: interval completion quality, recovery efficiency, training load.

## Mistakes to Avoid
- Bad: assuming HR is always a single byte. Always check flags byte bit 0 first.
- Bad: zone background set via `style.backgroundColor` on every HR tick. Zone class is swapped only when zone number changes.
- Bad: trying to persist BLE object references across page navigations. They don't survive. The fix is SPA architecture.
