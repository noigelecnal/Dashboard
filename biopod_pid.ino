/*
  BioPod ESP32 firmware - PID version (replaces the on/off hysteresis control)

  What changed compared with biopod.ino
    * Heater and Peltier are driven with PWM (0-100 % duty) by ONE PID loop
      ("split-range": positive output = heater, negative output = Peltier).
    * Humidifier and blower are unchanged (humidifier keeps its hysteresis, blower is always on).
    * Telemetry is backwards compatible: "actuators" stays boolean (true = duty > 0),
      new fields "duty" and "pid" carry the real numbers. server.py and the dashboard
      work unchanged and simply ignore the new fields until you choose to show them.
    * Serial prints a "CSV,..." line every sample, used for system identification and
      PSO tuning (tools/pso_tune.py).

  Control loop (every SAMPLE_INTERVAL_MS):
      read 4 sensors -> average -> PID -> split-range -> PWM -> POST to dashboard

  Libraries: "DHT sensor library" (Adafruit) + "Adafruit Unified Sensor".
  Works with Arduino-ESP32 core 2.x and 3.x (the PWM API differs; handled below).
  Files: biopod_pid.ino + PidController.h must sit in the SAME folder named biopod_pid.
*/

#include <WiFi.h>
#include <HTTPClient.h>
#include <time.h>
#include "DHT.h"
#include "PidController.h"

// =====================================================================
// 1. NETWORK
// =====================================================================
const char* WIFI_SSID = "YOUR_WIFI";
const char* WIFI_PASS = "YOUR_PASSWORD";
const char* DASHBOARD_HOST = "192.168.1.10";   // LAN IP of the PC running server.py
const uint16_t DASHBOARD_PORT = 8080;

// =====================================================================
// 2. SETPOINTS, LIMITS AND TIMING
// =====================================================================
float tempSetpoint = 37.0;                     // overwritten by the dashboard value
float humSetpoint = 50.0;
const float HUM_HYST = 2.0;                    // humidifier hysteresis (+/- % RH), unchanged

const float TEMP_SP_MIN = 25.0, TEMP_SP_MAX = 45.0;   // clamp for remote setpoints
const float HUM_SP_MIN = 20.0, HUM_SP_MAX = 90.0;

// The PID gains below were computed for THIS sample time. If you change it, re-tune.
const unsigned long SAMPLE_INTERVAL_MS = 5000;        // DHT22 needs >= 2 s
const unsigned long WIFI_RETRY_MS = 10000;

// =====================================================================
// 3. PID TUNING  (paste the output of tools/pso_tune.py here)
// =====================================================================
// PLACEHOLDER values computed from a nominal model (Kh=18 C, Kc=9 C, tau=420 s,
// theta=20 s, ambient 30 C). They are NOT identified from your hardware yet:
// run the step test (section 4), then `pso_tune.py fit` and `pso_tune.py tune`.
const float TEMP_KP = 18.3493f;       // % output per degC
const float TEMP_KI = 0.062480f;      // % output per (degC*s)   = Kp / Ti
const float TEMP_KD = 0.0f;           // % output per (degC/s)   = Kp * Td
const float TEMP_D_FILTER_S = 15.0f;  // derivative low-pass time constant [s]

const float OUT_DEADBAND_PCT = 1.0f;  // |output| below this -> both loads off (stops chatter)
const float HEATER_MAX_PCT = 100.0f;  // cap the heater duty here if the PTC is oversized
const float PELTIER_MAX_PCT = 100.0f; // cap the Peltier duty (also limits its current)

// Peltier gate: cooling is only allowed once the chamber is this far ABOVE the setpoint,
// and is released again when it falls back below the release level. Inside the gate the
// Peltier duty is proportional. 0.5 would match the paper literally ("only above the
// upper acceptance limit") but then the chamber is already out of range when cooling starts.
const float PELTIER_ENGAGE_C = 0.3f;
const float PELTIER_RELEASE_C = 0.1f;

// Independent hard safety limit, enforced outside the PID.
const float TEMP_CUTOFF_C = 45.0f;    // above this the heater is forced off

// =====================================================================
// 4. SYSTEM-IDENTIFICATION TEST MODE
// =====================================================================
// Set ONE of these > 0 to run an OPEN-LOOP step (no PID) at that duty and log it over
// Serial. Start from a chamber at rest (everything off for ~30 min). Capture the
// Serial output to a text file and feed it to `pso_tune.py fit`. Set back to 0 afterwards.
const float IDENT_HEATER_STEP_PCT = 0.0f;
const float IDENT_PELTIER_STEP_PCT = 0.0f;
const unsigned long IDENT_STEP_AFTER_MS = 30000;      // log a baseline, then apply the step

// =====================================================================
// 5. PINS AND PWM
// =====================================================================
#define DHTTYPE DHT22
const int DHT_PINS[4] = {14, 27, 26, 25};
const int PIN_HEATER = 32;
const int PIN_PELTIER = 33;
const int PIN_FAN = 18;
const int PIN_HUMIDIFIER = 19;

const int PWM_BITS = 10;                              // 0..1023
const int PWM_MAX = (1 << PWM_BITS) - 1;
const uint32_t HEATER_PWM_HZ = 1000;
// Peltiers dislike slow on/off cycling (thermal fatigue). Keep this >= 1 kHz; higher is
// better for the module but makes the MOSFET switching losses larger - check MOSFET heat.
const uint32_t PELTIER_PWM_HZ = 5000;
const int CH_HEATER = 0, CH_PELTIER = 1;              // used by core 2.x only

// NOTE: pin numbers must be checked against the 4.0-inch ESP32 touchscreen board you use;
// the display and touch controller occupy several GPIOs.

// =====================================================================
// 6. STATE
// =====================================================================
DHT dht0(DHT_PINS[0], DHTTYPE);
DHT dht1(DHT_PINS[1], DHTTYPE);
DHT dht2(DHT_PINS[2], DHTTYPE);
DHT dht3(DHT_PINS[3], DHTTYPE);
DHT* sensors[4] = {&dht0, &dht1, &dht2, &dht3};

// Output range [-100, 100]: +x = heater x %, -x = Peltier x %.
PidController tempPid(TEMP_KP, TEMP_KI, TEMP_KD, 0.0f, 100.0f, TEMP_D_FILTER_S);

float heaterDuty = 0;      // 0..100 %
float peltierDuty = 0;     // 0..100 %
bool humidifierOn = false;
bool coolingAllowed = false;
float lastPidOut = 0;

unsigned long lastSample = 0;
unsigned long lastWifiTry = 0;
unsigned long bootMs = 0;

// =====================================================================
// 7. SMALL HELPERS
// =====================================================================
String numOrNull(float v) {
  if (isnan(v)) return "null";
  return String(v, 2);
}

// Pull a number out of a tiny JSON string, e.g. "temp":37.0
bool extractNumber(const String& body, const char* key, float& out) {
  String needle = String("\"") + key + "\":";
  int idx = body.indexOf(needle);
  if (idx < 0) return false;
  out = body.substring(idx + needle.length()).toFloat();
  return true;
}

void applyServerSetpoints(const String& resp) {
  int sp = resp.indexOf("\"setpoints\"");
  if (sp < 0) return;
  String part = resp.substring(sp);
  float t, h;
  if (extractNumber(part, "temp", t) && t >= TEMP_SP_MIN && t <= TEMP_SP_MAX) tempSetpoint = t;
  if (extractNumber(part, "hum", h) && h >= HUM_SP_MIN && h <= HUM_SP_MAX) humSetpoint = h;
}

// ---- PWM abstraction (core 2.x uses channels, core 3.x uses pins) ----
void pwmBegin() {
#if defined(ESP_ARDUINO_VERSION_MAJOR) && ESP_ARDUINO_VERSION_MAJOR >= 3
  ledcAttach(PIN_HEATER, HEATER_PWM_HZ, PWM_BITS);
  ledcAttach(PIN_PELTIER, PELTIER_PWM_HZ, PWM_BITS);
#else
  ledcSetup(CH_HEATER, HEATER_PWM_HZ, PWM_BITS);
  ledcAttachPin(PIN_HEATER, CH_HEATER);
  ledcSetup(CH_PELTIER, PELTIER_PWM_HZ, PWM_BITS);
  ledcAttachPin(PIN_PELTIER, CH_PELTIER);
#endif
}

void pwmWritePercent(bool isHeater, float pct) {
  if (pct < 0) pct = 0;
  if (pct > 100) pct = 100;
  uint32_t duty = (uint32_t)(pct * PWM_MAX / 100.0f + 0.5f);
#if defined(ESP_ARDUINO_VERSION_MAJOR) && ESP_ARDUINO_VERSION_MAJOR >= 3
  ledcWrite(isHeater ? PIN_HEATER : PIN_PELTIER, duty);
#else
  ledcWrite(isHeater ? CH_HEATER : CH_PELTIER, duty);
#endif
}

// =====================================================================
// 8. CONTROL
// =====================================================================
// Temperature: PID + split-range. All failure paths end with BOTH loads off.
void controlTemperature(float avgT, float dt) {
  if (isnan(avgT)) {                    // no valid sensor: fail safe, everything off
    heaterDuty = 0;
    peltierDuty = 0;
    lastPidOut = 0;
    tempPid.resetDerivative();          // do not let the first sample back look like a step
    return;
  }

  if (avgT >= TEMP_CUTOFF_C) {          // hard over-temperature cut-off
    heaterDuty = 0;
    peltierDuty = 0;
    tempPid.reset();
    return;
  }

  // Open-loop identification step (bypasses the PID, but NOT the safety checks above)
  if (IDENT_HEATER_STEP_PCT > 0 || IDENT_PELTIER_STEP_PCT > 0) {
    bool stepOn = (millis() - bootMs) > IDENT_STEP_AFTER_MS;
    heaterDuty = (stepOn && IDENT_HEATER_STEP_PCT > 0) ? IDENT_HEATER_STEP_PCT : 0;
    peltierDuty = (stepOn && IDENT_PELTIER_STEP_PCT > 0) ? IDENT_PELTIER_STEP_PCT : 0;
    return;
  }

  // Cooling gate with hysteresis (see PELTIER_ENGAGE_C). Telling the PID that cooling
  // is unavailable (outMin = 0) also stops the integrator from winding up negative.
  if (!coolingAllowed && avgT > tempSetpoint + PELTIER_ENGAGE_C) coolingAllowed = true;
  else if (coolingAllowed && avgT < tempSetpoint + PELTIER_RELEASE_C) coolingAllowed = false;
  tempPid.setOutputLimits(coolingAllowed ? -PELTIER_MAX_PCT : 0.0f, HEATER_MAX_PCT);

  float u = tempPid.update(tempSetpoint, avgT, dt);
  lastPidOut = u;

  if (fabsf(u) < OUT_DEADBAND_PCT) u = 0;
  if (u > 0) { heaterDuty = u;  peltierDuty = 0; }       // never heat and cool together
  else       { heaterDuty = 0;  peltierDuty = -u; }
}

// Humidity: unchanged latching on/off (an ultrasonic atomizer is not PWM-friendly).
void controlHumidity(float avgH) {
  if (isnan(avgH)) {
    humidifierOn = false;
    return;
  }
  if (!humidifierOn && avgH < humSetpoint - HUM_HYST) humidifierOn = true;
  else if (humidifierOn && avgH >= humSetpoint + HUM_HYST) humidifierOn = false;
}

void driveOutputs() {
  pwmWritePercent(true, heaterDuty);
  pwmWritePercent(false, peltierDuty);
  digitalWrite(PIN_HUMIDIFIER, humidifierOn ? HIGH : LOW);
  digitalWrite(PIN_FAN, HIGH);          // blower runs continuously
}

// =====================================================================
// 9. NETWORK
// =====================================================================
void connectWifi(unsigned long timeoutMs) {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  unsigned long start = millis();
  Serial.print("WiFi");
  while (WiFi.status() != WL_CONNECTED && millis() - start < timeoutMs) {
    delay(400);
    Serial.print(".");
  }
  Serial.println();
  if (WiFi.status() == WL_CONNECTED) Serial.println(WiFi.localIP());
}

void postReading(float temps[4], float hums[4]) {
  HTTPClient http;
  String url = String("http://") + DASHBOARD_HOST + ":" + DASHBOARD_PORT + "/api/reading";
  http.begin(url);
  http.addHeader("Content-Type", "application/json");

  String body = "{";
  time_t now = time(nullptr);
  if (now > 1700000000) {               // NTP synced: send the real sample time (epoch ms)
    char tbuf[24];
    snprintf(tbuf, sizeof(tbuf), "%llu", (unsigned long long)now * 1000ULL);
    body += String("\"time\":") + tbuf + ",";
  }
  body += "\"temps\":[" + numOrNull(temps[0]) + "," + numOrNull(temps[1]) + "," +
          numOrNull(temps[2]) + "," + numOrNull(temps[3]) + "],";
  body += "\"hums\":[" + numOrNull(hums[0]) + "," + numOrNull(hums[1]) + "," +
          numOrNull(hums[2]) + "," + numOrNull(hums[3]) + "],";
  body += "\"setpoints\":{\"temp\":" + String(tempSetpoint, 1) +
          ",\"hum\":" + String(humSetpoint, 1) + "},";
  // Backwards compatible booleans (true = load is doing something)
  body += "\"actuators\":{\"heater\":" + String(heaterDuty > 0.5f ? "true" : "false") +
          ",\"peltier\":" + String(peltierDuty > 0.5f ? "true" : "false") +
          ",\"fan\":true,\"humidifier\":" + String(humidifierOn ? "true" : "false") + "},";
  // New: real PWM duty and the PID internals
  body += "\"duty\":{\"heater\":" + String(heaterDuty, 1) +
          ",\"peltier\":" + String(peltierDuty, 1) + "},";
  body += "\"pid\":{\"u\":" + String(lastPidOut, 1) +
          ",\"p\":" + String(tempPid.pTerm, 1) +
          ",\"i\":" + String(tempPid.iTerm, 1) +
          ",\"d\":" + String(tempPid.dTerm, 1) + "}";
  body += "}";

  int code = http.POST(body);
  Serial.printf("POST %d %s\n", code, body.c_str());
  if (code == 200) applyServerSetpoints(http.getString());
  http.end();
}

// =====================================================================
// 10. ARDUINO ENTRY POINTS
// =====================================================================
void setup() {
  Serial.begin(115200);
  bootMs = millis();

  pwmBegin();
  pwmWritePercent(true, 0);             // outputs OFF before anything else happens
  pwmWritePercent(false, 0);
  pinMode(PIN_FAN, OUTPUT);
  pinMode(PIN_HUMIDIFIER, OUTPUT);
  digitalWrite(PIN_HUMIDIFIER, LOW);
  digitalWrite(PIN_FAN, HIGH);

  for (int i = 0; i < 4; i++) sensors[i]->begin();

  connectWifi(20000);                   // control keeps running even if Wi-Fi fails
  configTime(0, 0, "pool.ntp.org", "time.google.com");
  Serial.println("CSVHEADER,seconds,avgTempC,heaterPct,peltierPct");
}

void loop() {
  if (WiFi.status() != WL_CONNECTED && millis() - lastWifiTry > WIFI_RETRY_MS) {
    lastWifiTry = millis();
    WiFi.disconnect();
    WiFi.begin(WIFI_SSID, WIFI_PASS);
  }

  unsigned long nowMs = millis();
  if (nowMs - lastSample < SAMPLE_INTERVAL_MS) return;
  float dt = (nowMs - lastSample) / 1000.0f;   // real elapsed time keeps the integral honest
  if (lastSample == 0 || dt > 30.0f) dt = SAMPLE_INTERVAL_MS / 1000.0f;
  lastSample = nowMs;

  float temps[4];
  float hums[4];
  float tSum = 0, hSum = 0;
  int tCount = 0, hCount = 0;

  for (int i = 0; i < 4; i++) {
    temps[i] = sensors[i]->readTemperature();
    hums[i] = sensors[i]->readHumidity();
    if (!isnan(temps[i])) { tSum += temps[i]; tCount++; }
    if (!isnan(hums[i])) { hSum += hums[i]; hCount++; }
  }

  float avgT = tCount ? tSum / tCount : NAN;
  float avgH = hCount ? hSum / hCount : NAN;

  controlTemperature(avgT, dt);
  controlHumidity(avgH);
  driveOutputs();

  Serial.printf("CSV,%.1f,%.2f,%.1f,%.1f\n", (nowMs - bootMs) / 1000.0f, avgT, heaterDuty, peltierDuty);

  if (WiFi.status() == WL_CONNECTED && tCount > 0) {
    postReading(temps, hums);
  }
}
