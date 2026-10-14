#!/usr/bin/env python3
"""BioPod dashboard server (merged into the 3D showcase app).

Serves the built web app (the `dist` folder), accepts ESP32 telemetry, keeps the
setpoints, and writes the official 30-minute timestamped log (so logging does not
depend on a browser tab).

Endpoints
    POST /api/reading     ESP32 telemetry (response includes current setpoints)
    GET  /api/reading     latest reading
    GET  /api/setpoints   current setpoints
    POST /api/setpoints   {"temp": 37, "hum": 50}  (from the dashboard)
    GET  /api/log         30-minute log + logging-completeness counters
    GET  /api/log.csv     the same log as CSV
    POST /api/log/reset   start a new trial (clears the log)

Usage (production):
    npm run build
    python server.py          -> http://127.0.0.1:8080

Usage (development):
    python server.py          (API + ESP32 on port 8080)
    npm run dev               (Vite on 5173, proxies /api to port 8080)

State files (telemetry, setpoints, 30-minute log) are written to ./data.
"""

from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
import json
import threading
import time

ROOT = Path(__file__).resolve().parent
STATIC_DIR = ROOT / "dist"
DATA_DIR = ROOT / "data"
STATE_FILE = DATA_DIR / "telemetry.json"
LOG_FILE = DATA_DIR / "log.json"
SETPOINT_FILE = DATA_DIR / "setpoints.json"
PORT = 8080

LOG_INTERVAL_S = 30 * 60      # paper: log every 30 minutes
FRESH_S = 120                 # a reading older than this counts as a missed slot
TEMP_TOL = 0.5                # acceptance range, +/- C
HUM_TOL = 5.0                 # acceptance range, +/- % RH
TEMP_SP_RANGE = (25.0, 45.0)
HUM_SP_RANGE = (20.0, 90.0)

lock = threading.Lock()

latest = {
    "id": 0,
    "temps": None,
    "hums": None,
    "time": None,
    "received": None,
    "actuators": None,
    "setpoints": None,
}
setpoints = {"temp": 37.0, "hum": 50.0}
log_state = {"startedAt": None, "expected": 0, "valid": 0, "entries": []}

NO_BUILD_PAGE = (
    "<!doctype html><meta charset='utf-8'><title>BioPod server</title>"
    "<body style='font-family:sans-serif;max-width:40em;margin:3em auto'>"
    "<h1>BioPod server is running</h1>"
    "<p>The API is up (the ESP32 can POST to <code>/api/reading</code>), but the web app "
    "has not been built yet.</p>"
    "<p>Run <code>npm run build</code> in this folder and reload, or use "
    "<code>npm run dev</code> for development.</p></body>"
)


def now_ms():
    return int(time.time() * 1000)


def read_json(path, default):
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            pass
    return default


def load_state():
    global latest, setpoints, log_state
    DATA_DIR.mkdir(exist_ok=True)
    latest = read_json(STATE_FILE, latest)
    setpoints = read_json(SETPOINT_FILE, setpoints)
    log_state = read_json(LOG_FILE, log_state)


def save_json(path, data):
    DATA_DIR.mkdir(exist_ok=True)
    path.write_text(json.dumps(data), encoding="utf-8")


def average(values):
    vals = [v for v in values if isinstance(v, (int, float))]
    return sum(vals) / len(vals) if vals else None


def spread(values):
    vals = [v for v in values if isinstance(v, (int, float))]
    return (max(vals) - min(vals)) if vals else None


def make_entry(slot_ms, reading):
    temps, hums = reading["temps"], reading["hums"]
    avg_t, avg_h = average(temps), average(hums)
    ok = (avg_t is None or abs(avg_t - setpoints["temp"]) <= TEMP_TOL) and \
         (avg_h is None or abs(avg_h - setpoints["hum"]) <= HUM_TOL)
    return {
        "time": slot_ms,
        "sampleTime": reading.get("time"),
        "temps": temps,
        "hums": hums,
        "avgTemp": avg_t,
        "avgHum": avg_h,
        "uniT": spread(temps),
        "uniH": spread(hums),
        "status": "In range" if ok else "Out of range",
        "actuators": reading.get("actuators"),
        "missed": False,
    }


def logger_loop():
    """Record one entry per 30-minute slot; a slot with no fresh reading counts as missed."""
    while True:
        time.sleep(1)
        with lock:
            t = now_ms()
            has_fresh = (latest.get("temps") is not None and latest.get("received") and
                         t - latest["received"] <= FRESH_S * 1000)
            if log_state["startedAt"] is None:
                if not has_fresh:
                    continue
                log_state["startedAt"] = t
            slot_index = len(log_state["entries"])
            slot_ms = log_state["startedAt"] + slot_index * LOG_INTERVAL_S * 1000
            if t < slot_ms:
                continue
            log_state["expected"] += 1
            if has_fresh:
                log_state["valid"] += 1
                log_state["entries"].append(make_entry(slot_ms, latest))
            else:
                log_state["entries"].append({"time": slot_ms, "missed": True})
            save_json(LOG_FILE, log_state)


def log_csv():
    header = ["Time", "S1 Temp", "S2 Temp", "S3 Temp", "S4 Temp",
              "S1 Hum", "S2 Hum", "S3 Hum", "S4 Hum", "Avg Temp", "Avg Hum",
              "Temp range", "Hum range", "Status"]
    lines = [",".join(header)]
    for e in log_state["entries"]:
        stamp = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(e["time"] / 1000))
        if e.get("missed"):
            lines.append(stamp + "," + ",".join([""] * 12) + ",Missed")
            continue
        row = [stamp]
        for v in e["temps"] + e["hums"]:
            row.append("" if v is None else str(v))
        for key in ("avgTemp", "avgHum", "uniT", "uniH"):
            v = e.get(key)
            row.append("" if v is None else "%.2f" % v)
        row.append(e["status"])
        lines.append(",".join(row))
    return "\n".join(lines)


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(STATIC_DIR), **kwargs)

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def send_body(self, body, content_type="application/json", code=200):
        data = body if isinstance(body, bytes) else body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def read_payload(self):
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self.send_error(400, "Invalid JSON")
            return None

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def do_GET(self):
        path = self.path.split("?")[0]
        with lock:
            if path == "/api/reading":
                return self.send_body(json.dumps(latest))
            if path == "/api/setpoints":
                return self.send_body(json.dumps(setpoints))
            if path == "/api/log":
                return self.send_body(json.dumps(log_state))
            if path == "/api/log.csv":
                return self.send_body(log_csv(), "text/csv")
        if not STATIC_DIR.exists():
            return self.send_body(NO_BUILD_PAGE, "text/html; charset=utf-8")
        return super().do_GET()

    def do_POST(self):
        global latest, log_state
        path = self.path.split("?")[0]

        if path == "/api/reading":
            payload = self.read_payload()
            if payload is None:
                return
            with lock:
                t = now_ms()
                latest = {
                    "id": t,
                    "temps": payload.get("temps"),
                    "hums": payload.get("hums"),
                    "time": payload.get("time", t),
                    "received": t,
                    "actuators": payload.get("actuators"),
                    "setpoints": dict(setpoints),   # server is the source of truth
                }
                save_json(STATE_FILE, latest)
                reply = {"ok": True, "setpoints": dict(setpoints)}
            return self.send_body(json.dumps(reply))

        if path == "/api/setpoints":
            payload = self.read_payload()
            if payload is None:
                return
            try:
                temp = float(payload["temp"])
                hum = float(payload["hum"])
            except (KeyError, TypeError, ValueError):
                return self.send_error(400, "temp and hum required")
            if not (TEMP_SP_RANGE[0] <= temp <= TEMP_SP_RANGE[1] and
                    HUM_SP_RANGE[0] <= hum <= HUM_SP_RANGE[1]):
                return self.send_error(400, "Setpoint out of safe range")
            with lock:
                setpoints["temp"], setpoints["hum"] = temp, hum
                save_json(SETPOINT_FILE, setpoints)
            return self.send_body(json.dumps({"ok": True, "setpoints": setpoints}))

        if path == "/api/log/reset":
            with lock:
                log_state = {"startedAt": None, "expected": 0, "valid": 0, "entries": []}
                save_json(LOG_FILE, log_state)
            return self.send_body('{"ok":true}')

        self.send_error(404)

    def log_message(self, format, *args):
        print("[%s] %s" % (self.log_date_time_string(), format % args))


if __name__ == "__main__":
    load_state()
    threading.Thread(target=logger_loop, daemon=True).start()
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print("BioPod dashboard  http://127.0.0.1:%s" % PORT)
    print("ESP32 POST JSON   http://<pc-ip>:%s/api/reading" % PORT)
    print('Example body: {"temps":[36.8,37.0,36.9,37.1],"hums":[49,50,51,50]}')
    if not STATIC_DIR.exists():
        print("Note: no ./dist folder yet. Run `npm run build`, or use `npm run dev`.")
    server.serve_forever()
