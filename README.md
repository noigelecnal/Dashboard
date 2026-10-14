# BioPod: code documentation (top to bottom)

Covers `ArduinoDashboard/Project` (legacy dashboard + ESP32 firmware + touchscreen UI) and
`ArduinoDashboard/3dmodelwebsiteshowcase` (the current React dashboard with the 3D model).
Written from a read-through of the source. Sections follow the data from the sensors up to the screen.

---

## 1. System overview

```
 4x AM2302B (DHT22)                                   PC (python server.py, :8080)
        |                                              ┌────────────────────────────┐
        v          HTTP POST /api/reading  (every 5 s) │ latest reading             │
  ESP32 firmware  ───────────────────────────────────► │ setpoints (source of truth)│
  (control loop)  ◄─────────────────────────────────── │ 30-min trial log + CSV     │
        |            reply: {"ok":true,"setpoints":..} └─────────────┬──────────────┘
        v                                                            │ GET /api/reading (2 s)
 PWM / MOSFETs: PTC heater, Peltier TEC1-12706,                      │ GET /api/log     (15 s)
 5010 blower, ultrasonic atomizer                                    v
                                                       React dashboard / touchscreen UI
                                                       POST /api/setpoints  (user changes)
```

Key ideas:

* **The ESP32 does the control.** It keeps working if Wi-Fi or the PC is down.
* **The server is the source of truth for setpoints.** The dashboard writes them there, the ESP32
  picks them up in the reply to its next POST.
* **The server writes the official 30-minute log**, so logging does not depend on a browser tab.
* Everything is plain HTTP on the LAN, port 8080, no authentication (prototype).

### Repository map

| Path | What it is |
| --- | --- |
| `Project/esp32/biopod/biopod.ino` | Original firmware: on/off control with hysteresis |
| `Project/esp32/biopod_pid/` *(new)* | PID firmware (`biopod_pid.ino`) + `PidController.h` |
| `Project/tools/pso_tune.py` *(new)* | PSO system identification + PID tuner (runs on the PC) |
| `Project/server.py`, `index.html`, `script.js`, `style.css` | Legacy vanilla-JS dashboard and its server |
| `Project/touchscreen/` | Standalone UI for the 4.0" touch display on the device |
| `Project/_post_test.py` | Sends one fake reading to the server (manual test) |
| `Project/telemetry.json` | Persisted latest reading (written by the legacy server) |
| `3dmodelwebsiteshowcase/server.py` | Current server (serves `dist/`, state in `./data`) |
| `3dmodelwebsiteshowcase/src/**` | Current React app (dashboard + 3D viewer) |
| `3dmodelwebsiteshowcase/scripts/verify.mjs` | Headless-browser smoke test |

---

## 2. ESP32 firmware, original (`biopod.ino`)

Reads four DHT22 sensors, averages them, runs **latching on/off control**, drives four MOSFET outputs
and POSTs JSON. Spec values come from the capstone paper.

### 2.1 Constants

| Name | Value | Meaning |
| --- | --- | --- |
| `tempSetpoint` / `humSetpoint` | 37.0 / 50.0 | Defaults, overwritten by the dashboard |
| `TEMP_ACCEPT` | 0.5 | Acceptance range ±°C (Peltier engages above SP + this) |
| `TEMP_HYST` | 0.2 | Heater band ±°C |
| `HUM_HYST` | 2.0 | Humidifier band ±% RH |
| `TEMP_SP_MIN/MAX`, `HUM_SP_MIN/MAX` | 25–45 / 20–90 | Clamp for remote setpoints |
| `SAMPLE_INTERVAL_MS` | 5000 | Control + reporting period (DHT22 needs ≥ 2 s) |
| `DHT_PINS` | 14, 27, 26, 25 | Sensor data pins |
| `PIN_HEATER / PELTIER / FAN / HUMIDIFIER` | 32 / 33 / 18 / 19 | Output pins (check against the touchscreen board) |

### 2.2 Functions

| Function | What it does |
| --- | --- |
| `numOrNull(v)` | Float → JSON text; `NaN` becomes `null` |
| `extractNumber(body, key, out)` | Minimal JSON number extractor (`"temp":37.0`), avoids a JSON library |
| `applyServerSetpoints(resp)` | Reads `setpoints.temp/hum` from the server reply, accepts only values inside the safe range |
| `controlTemperature(avgT)` | Heater on below SP−0.2, off at SP+0.2. Peltier on above SP+0.5, off at SP+0.2. Never both. `NaN` → both off |
| `controlHumidity(avgH)` | Atomizer on below SP−2, off at SP+2. `NaN` → off |
| `driveOutputs()` | Writes the booleans to the pins; blower always HIGH |
| `connectWifi(timeoutMs)` | Blocking connect with a timeout; control continues if it fails |
| `postReading(temps, hums)` | Builds and POSTs the JSON body (see §4.1), applies returned setpoints |
| `setup()` | Pins to a safe OFF state, starts sensors, Wi-Fi, NTP (`pool.ntp.org`, `time.google.com`) |
| `loop()` | Wi-Fi retry every 10 s; every 5 s: read sensors → average (ignoring `NaN`) → control → drive → POST |

---

## 3. ESP32 firmware, PID version (`biopod_pid/`)

### 3.1 Why PID and what "PSO-PID" means

On/off control makes the chamber ripple around the setpoint and slams the loads on and off.
PID computes a **continuous duty cycle (0–100 %)** from the error, so the chamber settles and the
Peltier is driven gently.

**PSO (Particle Swarm Optimisation) is not a controller.** It is an optimiser that searches for the
best PID gains (Kp, Ti, Td) by simulating the chamber many times. The result is three numbers you paste
into the sketch. The ESP32 only ever runs the PID.

```
 step test on the real chamber ──► pso_tune.py fit  ──► plant model (gain, tau, dead time)
                                                    │
                                    pso_tune.py tune ──► Kp, Ki, Kd  ──► paste into biopod_pid.ino
```

### 3.2 `PidController.h`

Parallel-form PID, `u = Kp·e + I − Kd·d(meas)/dt`, with:

* derivative on **measurement** (no kick on setpoint changes),
* low-pass filtered derivative (time constant `TEMP_D_FILTER_S`) because DHT22 readings are quantised to 0.1 °C,
* **conditional-integration anti-windup** (integrator frozen while saturated and still pushing),
* run-time output limits (`setOutputLimits`), `reset()`, `resetDerivative()`,
* last P/I/D terms exposed (`pTerm`, `iTerm`, `dTerm`) for telemetry.

No Arduino dependencies, so it is unit-testable on a PC. A cross-check against the Python mirror in
`pso_tune.py` matched to within float rounding (max difference ≈ 2·10⁻⁴ % output).

### 3.3 `biopod_pid.ino`: what changed

| Area | Original | PID version |
| --- | --- | --- |
| Heater / Peltier | digital on/off with hysteresis | **one PID**, split-range, PWM duty |
| Output variables | `heaterOn`, `peltierOn` (bool) | `heaterDuty`, `peltierDuty` (0–100 %) |
| Humidifier | hysteresis | unchanged |
| Blower | always on | unchanged |
| Time base | fixed 5 s | measured `dt` between samples (keeps the integral correct when an HTTP POST runs long) |
| Telemetry | `actuators` booleans | same booleans (`true` = duty > 0.5 %) **plus** `duty` and `pid` |
| Serial | POST echo | adds a `CSV,seconds,avgT,heater%,peltier%` line every sample |

**Split-range:** the PID output `u` is in −100…+100. `u > 0` → heater at `u` %, `u < 0` → Peltier at `−u` %.
A 1 % deadband (`OUT_DEADBAND_PCT`) turns both off near zero to stop chatter. Heater and Peltier never run together.

**Peltier gate:** cooling is allowed only when the chamber is `PELTIER_ENGAGE_C` (0.3 °C) above the setpoint,
and released below `PELTIER_RELEASE_C` (0.1 °C). While the gate is closed the PID is told `outMin = 0`, which also
stops the integrator winding up negative. The paper says the Peltier engages above the upper acceptance limit
(+0.5 °C); with PID that is already out of range, so 0.3 is the default. Set `PELTIER_ENGAGE_C = 0.5f` to match the paper literally.

**Safety paths (all end with both loads OFF):** no valid sensor (`NaN`), or `avgT ≥ TEMP_CUTOFF_C` (45 °C). These run before everything else, including the open-loop step-test mode.
On sensor dropout only the derivative state is reset; on over-temperature the whole PID is reset.

### 3.4 Constants (PID version)

| Name | Default | Meaning |
| --- | --- | --- |
| `TEMP_KP` | 18.3493 | % output per °C |
| `TEMP_KI` | 0.062480 | % output per (°C·s), `= Kp/Ti` |
| `TEMP_KD` | 0.0 | % output per (°C/s), `= Kp·Td` |
| `TEMP_D_FILTER_S` | 15 | Derivative filter time constant [s] |
| `OUT_DEADBAND_PCT` | 1 | Output below this → both loads off |
| `HEATER_MAX_PCT`, `PELTIER_MAX_PCT` | 100 | Duty caps (Peltier cap also limits its current) |
| `PELTIER_ENGAGE_C`, `PELTIER_RELEASE_C` | 0.3, 0.1 | Cooling gate |
| `TEMP_CUTOFF_C` | 45 | Independent over-temperature heater cut-off |
| `HEATER_PWM_HZ`, `PELTIER_PWM_HZ` | 1000, 5000 | PWM frequencies, 10-bit resolution |
| `IDENT_HEATER_STEP_PCT`, `IDENT_PELTIER_STEP_PCT` | 0 | >0 = open-loop step test (§3.6) |

> **The default gains are placeholders.** They were computed from a nominal model (heater 18 °C at 100 %,
> Peltier 9 °C at 100 %, τ = 420 s, dead time 20 s, ambient 30 °C), not from your hardware. Identify your
> chamber (§3.6) before trusting them. Until then, treat the first run as a supervised test.

### 3.5 Functions (PID version)

| Function | What it does |
| --- | --- |
| `pwmBegin()` / `pwmWritePercent(isHeater, pct)` | LEDC PWM setup and write. Handles Arduino-ESP32 **core 2.x** (channels) and **3.x** (pins) |
| `controlTemperature(avgT, dt)` | Ident-mode bypass → fail-safes → Peltier gate → `tempPid.update` → deadband → split-range |
| `controlHumidity(avgH)` | Unchanged hysteresis |
| `driveOutputs()` | PWM for heater and Peltier, digital for atomizer and blower |
| `postReading(...)` | Same as the original plus `duty` and `pid` fields |
| `setup()` | PWM begins with outputs at 0 % **before** anything else, then sensors, Wi-Fi, NTP |
| `loop()` | Computes real `dt`, reads sensors, runs control, drives outputs, prints the CSV line, POSTs |

### 3.6 Commissioning procedure

1. **Hardware check.** Confirm the MOSFETs are logic-level, have flyback/gate resistors, and the supply can carry
   the Peltier current (a TEC1-12706 can draw about 6 A at 12 V, so `PELTIER_MAX_PCT` is also a current limit).
   Keep a thermal fuse on the heater; firmware limits are not a substitute.
2. **Heater step test.** Let the chamber sit with everything off until it is at ambient. Set
   `IDENT_HEATER_STEP_PCT = 50`, flash, open the Serial Monitor at 115200 and save the output. After 30 s the
   heater steps to 50 %. Log at least 3× the chamber time constant (typically 30–45 min) and stop before the
   chamber gets near 45 °C. Set the constant back to `0`.
3. `python tools/pso_tune.py fit --csv heater_step.txt --channel heater`: prints `--kh --tau --theta --ambient`.
   Check that the printed RMSE is below about 0.3 °C.
4. **Peltier step test** (optional but recommended): warm the chamber, turn the heater off, apply
   `IDENT_PELTIER_STEP_PCT`, then `fit --channel peltier --ambient <°C with everything off>`.
5. `python tools/pso_tune.py tune --kh … --kc … --tau … --theta … --ambient …`: about a minute. Paste the printed
   `TEMP_KP / KI / KD / D_FILTER` lines into the sketch.
6. Flash, watch the first heat-up, then use **Mark door disturbance** on the dashboard. The RT metric on the dashboard
   is the real-world result of the tuning.

### 3.7 What `pso_tune.py` simulates

* Plant: first-order + dead time, `T_inf = ambient + Kh·heater − Kc·peltier`, exact discretisation at Ts = 5 s.
* Scenarios: cold start to 37 °C, door-open (−3.2 °C, same as the dashboard demo), warm intrusion (+1.5 °C).
* Robustness: also evaluates a weaker/slower/laggier and a stronger/faster plant (±30 %), so gains are not fragile.
* Realism: 0.1 °C sensor quantisation and noise, the same cooling gate, deadband and filter as the firmware.
* Cost: weighted ITAE + time outside ±0.5 °C + overshoot² + control movement. Weights are the `W_*` constants at the top
  of the cost section; raise `W_BAND` to prioritise staying inside the acceptance range.
* Search space: Kp, Ti, Td (converted to Ki = Kp/Ti, Kd = Kp·Td). PSO: 24 particles, 60 iterations, inertia 0.9→0.4, c1 = c2 = 1.8.
* `TS` in the script **must equal** `SAMPLE_INTERVAL_MS/1000` in the sketch.

### 3.8 Reading the controller on the dashboard

The new `duty` and `pid` fields are ignored by the current server and UI. To show them, see §9 (optional patch).

---

## 4. Server (`server.py`)

Two copies exist and differ only in paths:

| | `Project/server.py` | `3dmodelwebsiteshowcase/server.py` |
| --- | --- | --- |
| Static files | `Project/` itself | `./dist` (shows a "not built" page if missing) |
| State files | next to the script | `./data/` |

Both are pure standard library (`http.server`), `ThreadingHTTPServer` on `0.0.0.0:8080`, CORS `*`, `Cache-Control: no-store`.
Because both use port 8080, run only one at a time.

### 4.1 Endpoints

| Method + path | Purpose |
| --- | --- |
| `POST /api/reading` | ESP32 telemetry. Reply: `{"ok":true,"setpoints":{...}}` |
| `GET /api/reading` | Latest reading |
| `GET /api/setpoints` | Current setpoints |
| `POST /api/setpoints` | `{"temp":37,"hum":50}`; validated against 25–45 °C and 20–90 % RH, else 400 |
| `GET /api/log` | 30-minute log + counters (`startedAt`, `expected`, `valid`, `entries`) |
| `GET /api/log.csv` | Same log as CSV |
| `POST /api/log/reset` | Starts a new trial (clears the log) |

**Telemetry body:**

```json
{
  "time": 1760400000000,                       // epoch ms from NTP (omitted until synced)
  "temps": [36.9, 37.0, 37.1, 36.8],           // null for a failed sensor
  "hums":  [49.5, 50.2, 50.0, 49.8],
  "setpoints": {"temp": 37.0, "hum": 50.0},    // echo; server ignores it and uses its own
  "actuators": {"heater": true, "peltier": false, "fan": true, "humidifier": false},
  "duty": {"heater": 42.3, "peltier": 0.0},    // new (PID firmware); currently ignored by the server
  "pid":  {"u": 42.3, "p": 12.1, "i": 30.2, "d": 0.0}   // new; currently ignored
}
```

### 4.2 Functions

| Function | What it does |
| --- | --- |
| `now_ms()` | Wall clock in ms |
| `read_json(path, default)` / `save_json(path, data)` / `load_state()` | Persistence of latest reading, setpoints and log |
| `average(values)` / `spread(values)` | Mean and max−min over numeric entries (ignores `null`) |
| `make_entry(slot_ms, reading)` | Builds one log row, status "In range" if avg temp within ±0.5 and avg RH within ±5 of the setpoints |
| `logger_loop()` | Thread, 1 s tick. Starts the trial at the first fresh reading, then writes one row per 30 min. A slot with no reading fresher than 120 s is recorded as **missed** |
| `log_csv()` | Renders the log as CSV (missed slots have empty cells) |
| `Handler` | `end_headers` (CORS), `send_body`, `read_payload` (400 on bad JSON), `do_GET`, `do_POST`, `do_OPTIONS`, `log_message` |

**Logging completeness** = `valid / expected × 100` (paper formula).

---

## 5. Web app (`3dmodelwebsiteshowcase`)

Stack: React 19, Vite, Three.js via `@react-three/fiber` + `@react-three/drei`, `lucide-react`.
Scripts: `npm run dev` (Vite on 5173, proxies `/api` → 8080), `npm run build`, `npm run start` (build + server), `npm run verify`.

### 5.1 `src/lib/biopod.js`: constants and pure helpers

| Export | Meaning |
| --- | --- |
| `TEMP_TOLERANCE` 0.5, `HUM_TOLERANCE` 5 | Acceptance range |
| `TEMP_HYSTERESIS` 0.2, `HUM_HYSTERESIS` 2 | Old on/off bands (used by the demo/manual path) |
| `LOG_INTERVAL_MS`, `MAX_READINGS` 1500 | 30 min; cap on browser-stored readings |
| `SETPOINT_HOLD_MS` 15000 | Ignore setpoints echoed back for 15 s after the user applies new ones |
| `DEFAULT_SETPOINTS`, `DEFAULT_ACTUATORS`, `DEFAULT_METRICS` | Initial state |
| `average`, `rangeOf`, `showNumber`, `pad`, `formatTime`, `toInputValue` | Formatting and statistics helpers (null-safe) |
| `inTempBand`, `inHumBand`, `getStatus` | "In range" / "Out of range" / "No data" |
| `nextActuators(prev, sp, avgT, avgH)` | Latching hysteresis **in JavaScript** for demo/manual data (mirrors the original firmware) |
| `loggingCompleteness(readings, serverLog)` | Server numbers if present, otherwise a local estimate |
| `eventLabel`, `setpointLabel` | Text for chart markers / log rows |
| `buildCsv`, `downloadBlob` | Local CSV export |

### 5.2 `src/hooks/useBiopod.js`: the state hook

Holds everything in a ref-backed store, persisted to `localStorage` (`biopod_*` keys), with a reducer `bump` to re-render.

| Function | What it does |
| --- | --- |
| `pushReading(temps, hums, time, source)` | Builds a reading (averages, uniformity, status), keeps readings sorted and capped, runs alert/recovery logic |
| `handleAlertAndRecovery(reading)` | **ADT = Ta − To**: time the dashboard receives the alert minus the sample time the chamber went out of range. **RT = Tr − Td**: first in-range sample after a *marked disturbance that really pushed it out*, minus the marked time. Only for live samples (< 15 s old) |
| `addManualReading(...)` | Validates 0–60 °C / 0–100 % RH, updates actuators with `nextActuators`, pushes a "manual" reading |
| `applySetpoints(tempText, humText)` | Validates 25–45 / 20–90, records an event, POSTs to `/api/setpoints` |
| `markDisturbance()` | Starts the RT timer (door open). In demo mode also drops the simulated chamber by 3.2 °C / 8 % RH |
| `startDemo` / `stopDemo` / `demoTick` | Simulated chamber (2 s tick) with jitter and a scripted dip at tick 18 |
| `exportCsv()` | Server's 30-minute CSV if a trial log exists, otherwise a local CSV |
| `clearAll()` | Wipes local state, resets the server log, pushes default setpoints |
| `ingestPayload(payload)` | De-duplicates by timestamp, ignores stale setpoint echoes, **merges `payload.actuators`**, then `pushReading(..., 'esp32')` |
| polling effect | `/api/reading` every 2 s, `/api/log` every 15 s |

Returned to the UI: `readings, events, alerts, metrics, setpoints, actuators, serverLog, latest, completeness, link, demoOn, toast`, plus the action functions.
`link` drives the header pill: "Demo live", "ESP32 linked", "Logged" or "Standby", with an alert style when out of range.

### 5.3 `src/App.jsx`

Page composition: top bar (brand + live pill + clock), status banner (in/out of range, demo and disturbance buttons), two KPI rows
(temperature, humidity, uniformity, logging completeness, ADT, RT; then lid, view, hidden parts, selection), the 3D viewer with
`ViewerControls`, component list/info, chamber map + actuators/setpoints, charts, alert feed + manual log, timestamped log, footer.
Local UI state: `openTarget` (0–1 lid), `motion`, `exploded`, `hiddenIds`, `selectedId`, `resetCount`, `info`, `modelError`.
Sub-components: `LoadingOverlay` (drei `useProgress`), `Clock`.

### 5.4 `src/components/BiopodDashboard.jsx`

| Component | Content |
| --- | --- |
| `ChamberPanel` | Four sensor tiles (S1–S4), green/terracotta by band |
| `ActuatorPanel` | Four load rows (on/off text), setpoint form with validation, hysteresis/acceptance hint |
| `ChartsRow` | Two `TrendChart`s (temperature, humidity) |
| `AlertsPanel` | Last 12 alerts |
| `ManualLogPanel` | Four-sensor form + date/time for bench tests |
| `LogPanel` | Last 250 rows (readings + setpoint-change events), Export CSV, Clear all |

### 5.5 `src/components/TrendChart.jsx`

Dependency-free SVG chart (640×300): four sensor lines + average, shaded ±tolerance band, dashed setpoint line, vertical marks for setpoint changes,
hover tooltip (nearest reading), point dots when ≤ 40 readings, legend. Y range auto-scales to data and the band.

### 5.6 3D viewer

| File | Role |
| --- | --- |
| `config/modelConfig.js` | `MODEL_CONFIG` (names, GLB URL, animation clip names, lid fallback, camera) and `COMPONENTS` (id, label, Blender object names, description, explode offset, marker anchor) |
| `components/Viewer3D.jsx` | Canvas, lights, environment, contact shadows, `OrbitControls` (`CameraRig` handles reset), `ModelBoundary` falls back to the placeholder if the GLB fails |
| `components/BlenderModel.jsx` | `useGLTF(url)`, hands scene + clips to `ContainerModel` |
| `components/DemoContainer.jsx` | Procedural placeholder (body, lid, tray, sensor board) with the same object names |
| `components/ContainerModel.jsx` | The rig: `buildRegistry` resolves components by name, clones materials (so highlight doesn't leak), stores base transforms; per-frame lid open (clip scrub, or 110° fallback rotation) and exploded offsets with damping; visibility and highlight effects; reports `info` and `motion` |
| `components/ModelLabels.jsx` | Clickable `Html` markers that follow the part's anchor in world space |
| `components/ComponentPanel.jsx` | Component list: select, hide/show, "Show all" |
| `components/ComponentInfo.jsx` | Description + mapped object name + visibility |
| `components/ViewerControls.jsx` | Open / close / exploded / reset camera / lid slider |

### 5.7 Unused files

`services/sensorService.js`, `hooks/useSensorData.js`, `components/SensorDashboard.jsx`, `components/ModelMap.jsx` are declared unused by the README
(I did not read them). Safe to delete after a build check.

### 5.8 `scripts/verify.mjs`

Playwright smoke test (not a dependency). Starts `vite preview` on 4179, checks rendering, open/close, slider, hide/show, selection, exploded view,
camera, demo telemetry, disturbance alert and no horizontal scroll at 390 px. See §8 for stale expectations.

---

## 6. Legacy dashboard (`Project/`)

* `index.html`, `style.css`, `script.js`: the original vanilla-JS version of the dashboard (Chart.js + annotation plugin). Same behaviour as
  `useBiopod.js`, which is a port of it (state in globals, `renderAll()` rebuilds the DOM and charts).
* `server.py`: see §4.
* `_post_test.py`: posts `{"temps":[38.4,...],"hums":[61,...],"actuators":{...}}` to `127.0.0.1:8080`; use it to test the pipeline without hardware.

## 7. Touchscreen UI (`Project/touchscreen/`)

Standalone page for the on-device display (does not use `script.js`). `touchscreen.js`:

| Function | Role |
| --- | --- |
| `stepValue`, `bindStepper` | ± buttons: tap or hold to repeat; temp in 0.1 °C steps, RH in 1 % steps |
| `applySetpoints`, `resetSetpoints` | Send to `/api/setpoints` (15 s echo hold), reset to 37 / 50 |
| `handleLive`, `markDisturbance` | Same ADT / RT logic as the web dashboard |
| `ingest`, `poll`, `pollLog` | Pull `/api/reading` (2 s) and `/api/log` (15 s) |
| `demoTick`, `startDemo`, `watchForData` | Starts a demo automatically after 8 s without data. **Contains its own hysteresis copy** |
| `render*` | Pill, home tiles, setpoints, actuator chips and list, KPIs |

---

## 8. Review findings (things to fix or know)

1. **README path is wrong.** It says `Project/esp32/biopod.ino`; the file is `Project/esp32/biopod/biopod.ino`.
2. **`verify.mjs` looks stale.** It expects 5 markers and a "Hinge" component; the current config has no hinge and the placeholder has 4 parts. It would fail until updated.
3. **Descriptions in `modelConfig.js` hard-code on/off behaviour** (heater, Peltier, humidifier, ESP32). Update them if you adopt PID (suggested text in §9).
4. **Placeholder text left in config:** tagline `'change this ion the modelConfig'`, product name `'Sample Container'`, every `labelAnchor` is `[0,0,0]`, so markers sit at each object's origin.
5. **Two servers on one port.** `Project/server.py` and `3dmodelwebsiteshowcase/server.py` are near-duplicates and will drift. Keep the one in the showcase folder.
6. **Control logic is duplicated in three places** (firmware, `nextActuators` in JS, touchscreen demo). With PID, demo mode still shows on/off behaviour; harmless but not representative.
7. **No authentication, CORS `*`, bound to `0.0.0.0`.** Fine on a lab LAN, not for a shared network. `POST /api/setpoints` can change the chamber setpoint (range-limited 25–45 °C).
8. **HTTP POST blocks the firmware loop** (HTTPClient default timeout is several seconds). Control output is held meanwhile; the PID version uses measured `dt` so the integral stays correct, but a long outage of the PC adds jitter.
9. **ADT depends on the PC and ESP32 clocks agreeing** (NTP on the ESP32 vs. the PC clock).
10. **Actuator status shows only on/off.** With PWM it is useful to show the duty (patch below).

---

## 9. Optional patch: show PID duty on the dashboard

**Server** (`server.py`, both copies): keep the new fields. In `latest = {...}` inside `do_POST` add:

```python
"duty": payload.get("duty"),
"pid": payload.get("pid"),
```

**React** (`useBiopod.js`, in `ingestPayload`): store `payload.duty` in the reading and in the hook state; then in `ActuatorPanel` show
`Heating 42 %` when `duty.heater > 0`. Update the config descriptions, e.g. PTC heater:
*"Warms the chamber. A PID controller sets its power from 0 to 100 % based on how far the average temperature is below the setpoint."*
