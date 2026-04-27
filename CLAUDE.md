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

## Mistakes to Avoid
- Bad: assuming HR is always a single byte. Always check flags byte bit 0 first.
- Bad: zone background set via `style.backgroundColor` on every HR tick. Zone class is swapped only when zone number changes.
- Bad: trying to persist BLE object references across page navigations. They don't survive. The fix is SPA architecture.
