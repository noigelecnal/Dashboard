# Container Showcase (BioPod)

Interactive 3D container viewer (open/close lid, exploded view, component visibility, clickable 3D markers) combined with the BioPod chamber dashboard: four-sensor readings, actuators, setpoints, charts, alerts, ADT / recovery metrics, manual log and the 30-minute trial log.
React + Vite + Three.js + React Three Fiber + Drei + Lucide.

```bash
npm install
npm run build      # production build into ./dist
python server.py   # BioPod server: http://127.0.0.1:8080 (serves ./dist, takes ESP32 data)
npm run start      # build, then run the server
npm run dev        # http://localhost:5173, proxies /api to python server.py on port 8080
npm run verify     # headless browser test (needs Playwright + Chromium, run build first)
```

For development run `python server.py` and `npm run dev` side by side. The ESP32 always posts to port 8080 (`/api/reading`), exactly as before, so `biopod.ino` does not change. State (latest reading, setpoints, 30-minute log) is saved to `./data`.

Right now a **procedural placeholder container** is shown until a GLB is configured. The dashboard shows "No data" until the ESP32 posts, the demo is started, or a manual reading is added.

## Where things live

| File | Purpose |
| --- | --- |
| `src/config/modelConfig.js` | GLB path, animation clip names, component → Blender object mapping, exploded offsets, marker positions |
| `src/components/ContainerModel.jsx` | Shared rig: finds parts, open/close, exploded view, highlight, visibility |
| `src/components/DemoContainer.jsx` | The placeholder model (object names match the config) |
| `src/components/BlenderModel.jsx` | Loads the real GLB when `glbUrl` is set |
| `src/hooks/useBiopod.js` | BioPod state: ESP32 polling, demo telemetry, manual entries, setpoints, alerts, ADT / RT |
| `src/lib/biopod.js` | BioPod constants and pure helpers (status bands, hysteresis, completeness, CSV) |
| `src/components/BiopodDashboard.jsx` | Chamber map, actuators + setpoints, charts row, alert feed, manual log, timestamped log |
| `src/components/TrendChart.jsx` | Dependency-free SVG chart (four sensors, average, acceptance band, setpoint) |
| `server.py` | BioPod server: serves `dist`, ESP32 API, setpoints, 30-minute log and CSV |

`src/services/sensorService.js`, `src/hooks/useSensorData.js`, `src/components/SensorDashboard.jsx` and `src/components/ModelMap.jsx` are no longer used by the app and can be deleted.

## Swapping in the Blender model

1. Put the file at `public/models/container.glb` (create the `public/models` folder).
2. In `modelConfig.js` set `glbUrl: '/models/container.glb'`.
3. Name your Blender objects as listed below, or add your names to each component's `meshNames`.

Names the site looks for (first match wins):

| Component | Blender object names |
| --- | --- |
| Container body | `ContainerBody`, `Body`, `Container` |
| Lid | `Lid`, `Cover`, `Top` |
| Hinge | `Hinge`, `HingePin`, `Hinge_Pin` |
| Inner tray | `InnerTray`, `Tray`, `Inner_Tray` |
| Sensor module | `SensorModule`, `Sensor`, `Sensor_Module` |

Animation clips (case-insensitive): open = `Open`, `LidOpen`, `Lid_Open`, `OpenContainer`, `Opening`; close = `Close`, `LidClose`, `Lid_Close`, `CloseContainer`, `Closing`.
The site uses the open clip scrubbed forwards and backwards, so one clip is enough.

### Blender export checklist

1. Make each part its own top-level object (lid, body, hinge, tray, sensor), not merged into one mesh. Keep them unparented from each other so hiding and exploding one never moves another.
2. Lid pivot: put the lid's **origin on the hinge line** (Object > Set Origin > Origin to 3D Cursor, with the cursor on the hinge edge). Without this, the fallback rotation swings around the wrong point.
3. Animation: in the Action Editor, key the lid rotation at frame 1 (closed) and frame 30 (open). Name the action `Open`. Push it down to an NLA strip or keep it as the object's action.
4. Apply scale and rotation (Ctrl+A) on every object; use metres, +Y up (the glTF exporter converts from Blender's Z up).
5. File > Export > glTF 2.0 (.glb): Format `glTF Binary`, enable Animation, and under Animation turn on "Always Sample Animations" and "Export all actions" if you have more than one. Include Materials.
6. If the GLB has no matching clip, the site rotates the `Lid` object 110° about its origin instead (`animation.lidFallback`). If there is no lid object either, open/close is disabled and a banner says so.
7. Update `labelAnchor` and `explodeOffset` in the config for your model's size. Both are in model units.

## Connecting the ESP32

1. In `Project/esp32/biopod.ino` set `WIFI_SSID`, `WIFI_PASS` and `DASHBOARD_HOST` (the LAN IP of the PC running `python server.py`). Port 8080 is unchanged.
2. Start `python server.py`. The ESP32 POSTs to `/api/reading` every 5 s; the response carries the current setpoints.
3. The header pill changes to "ESP32 linked" once a reading arrives. Setpoints applied in the dashboard are sent to the server and picked up by the ESP32 on its next reading.
