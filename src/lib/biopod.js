// Shared BioPod constants and pure helpers (ported from the old Project/script.js).

export const TEMP_TOLERANCE = 0.5 // acceptance range, +/- C
export const HUM_TOLERANCE = 5 // acceptance range, +/- % RH
export const TEMP_HYSTERESIS = 0.2 // control hysteresis band, +/- C
export const HUM_HYSTERESIS = 2 // humidifier hysteresis, +/- % RH
export const LOG_INTERVAL_MS = 30 * 60 * 1000
export const MAX_READINGS = 1500 // keeps browser storage bounded; the official 30-min log lives on the server
export const SETPOINT_HOLD_MS = 15000 // ignore ESP32-echoed setpoints right after the user applies new ones
export const SENSOR_COLORS = ['#1f6b4a', '#c45c26', '#3d6b8b', '#c9a227']

export const DEFAULT_SETPOINTS = { temp: 37, hum: 50 }
export const DEFAULT_ACTUATORS = { heater: false, peltier: false, fan: true, humidifier: false }
export const DEFAULT_METRICS = {
  lastAdtSec: null,
  lastRtSec: null,
  disturbanceAt: null,
  disturbanceExceeded: false,
  outOfRangeAt: null,
  waitingForRecovery: false,
}

export const pad = (n) => (n < 10 ? `0${n}` : `${n}`)

export function formatTime(ms) {
  const d = new Date(ms)
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export function toInputValue(ms) {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const isNum = (v) => v !== null && v !== undefined && !Number.isNaN(v)

export function average(list) {
  let sum = 0
  let count = 0
  for (const v of list) {
    if (isNum(v)) {
      sum += v
      count += 1
    }
  }
  return count === 0 ? null : sum / count
}

export function rangeOf(list) {
  const vals = list.filter(isNum)
  if (vals.length === 0) return null
  return Math.max(...vals) - Math.min(...vals)
}

export function showNumber(value, digits = 1) {
  if (!isNum(value)) return '—'
  return Number(value).toFixed(digits)
}

export const inTempBand = (t, sp) => t !== null && Math.abs(t - sp.temp) <= TEMP_TOLERANCE
export const inHumBand = (h, sp) => h !== null && Math.abs(h - sp.hum) <= HUM_TOLERANCE

export function getStatus(avgTemp, avgHum, sp) {
  if (avgTemp === null && avgHum === null) return 'No data'
  const tempOk = avgTemp === null ? true : inTempBand(avgTemp, sp)
  const humOk = avgHum === null ? true : inHumBand(avgHum, sp)
  return tempOk && humOk ? 'In range' : 'Out of range'
}

// Same latching hysteresis as the firmware, used for demo / manual entries.
export function nextActuators(prev, setpoints, avgTemp, avgHum) {
  const a = { ...prev, fan: true }
  if (avgTemp !== null) {
    const sp = setpoints.temp
    if (!a.heater && avgTemp < sp - TEMP_HYSTERESIS) a.heater = true
    else if (a.heater && avgTemp >= sp + TEMP_HYSTERESIS) a.heater = false
    if (!a.peltier && avgTemp > sp + TEMP_TOLERANCE) a.peltier = true
    else if (a.peltier && avgTemp <= sp + TEMP_HYSTERESIS) a.peltier = false
    if (a.heater && a.peltier) a.heater = false
  }
  if (avgHum !== null) {
    const hp = setpoints.hum
    if (!a.humidifier && avgHum < hp - HUM_HYSTERESIS) a.humidifier = true
    else if (a.humidifier && avgHum >= hp + HUM_HYSTERESIS) a.humidifier = false
  }
  return a
}

// Logging completeness = valid records / expected records x 100 (paper formula).
// The official records are the server's 30-minute log; the local fallback is only
// used for demo / manual sessions where no server log exists.
export function loggingCompleteness(readings, serverLog) {
  if (serverLog && serverLog.expected > 0) {
    return { pct: (serverLog.valid / serverLog.expected) * 100, valid: serverLog.valid, expected: serverLog.expected, server: true }
  }
  if (readings.length === 0) return { pct: null, valid: 0, expected: 0, server: false }
  const start = readings[0].time
  const end = readings[readings.length - 1].time
  let expected = Math.floor((end - start) / LOG_INTERVAL_MS) + 1
  const buckets = new Set()
  for (const r of readings) buckets.add(Math.floor((r.time - start) / LOG_INTERVAL_MS))
  if (expected < 1) expected = 1
  return { pct: (buckets.size / expected) * 100, valid: buckets.size, expected, server: false }
}

export function eventLabel(event, unit) {
  if (unit === 'temp' && event.newTemp !== event.oldTemp) return `${event.oldTemp} → ${event.newTemp} °C`
  if (unit !== 'temp' && event.newHum !== event.oldHum) return `${event.oldHum} → ${event.newHum} %`
  return ''
}

export function setpointLabel(oldTemp, newTemp, oldHum, newHum) {
  const parts = []
  if (newTemp !== oldTemp) parts.push(`${oldTemp} to ${newTemp} °C`)
  if (newHum !== oldHum) parts.push(`${oldHum} to ${newHum} %`)
  return parts.join(', ')
}

export function buildCsv(readings) {
  const header = ['Time', 'S1 Temp', 'S2 Temp', 'S3 Temp', 'S4 Temp', 'S1 Hum', 'S2 Hum', 'S3 Hum', 'S4 Hum', 'Avg Temp', 'Avg Hum', 'Temp range', 'Hum range', 'Status', 'Source']
  const lines = [header.join(',')]
  const sorted = [...readings].sort((a, b) => a.time - b.time)
  for (const r of sorted) {
    const row = [formatTime(r.time)]
    for (let t = 0; t < 4; t++) row.push(r.temps[t] === null ? '' : r.temps[t])
    for (let h = 0; h < 4; h++) row.push(r.hums[h] === null ? '' : r.hums[h])
    row.push(r.avgTemp === null ? '' : r.avgTemp.toFixed(2))
    row.push(r.avgHum === null ? '' : r.avgHum.toFixed(2))
    row.push(r.uniT === null ? '' : r.uniT.toFixed(2))
    row.push(r.uniH === null ? '' : r.uniH.toFixed(2))
    row.push(r.status)
    row.push(r.source || '')
    lines.push(row.join(','))
  }
  return lines.join('\n')
}

export function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  URL.revokeObjectURL(url)
}
