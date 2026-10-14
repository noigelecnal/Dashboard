import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import {
  DEFAULT_ACTUATORS,
  DEFAULT_METRICS,
  DEFAULT_SETPOINTS,
  HUM_TOLERANCE,
  MAX_READINGS,
  SETPOINT_HOLD_MS,
  TEMP_TOLERANCE,
  average,
  buildCsv,
  downloadBlob,
  formatTime,
  getStatus,
  loggingCompleteness,
  nextActuators,
  rangeOf,
  setpointLabel,
  showNumber,
} from '../lib/biopod'

// BioPod chamber state: readings from the ESP32 (via server.py), demo telemetry and
// manual log entries, plus setpoints, actuators, alerts and the ADT / RT metrics.
// Ported from the old Project/script.js; same logic, held in React state.

const KEYS = {
  readings: 'biopod_readings',
  setpoints: 'biopod_setpoints',
  events: 'biopod_events',
  alerts: 'biopod_alerts',
  metrics: 'biopod_metrics',
}

function readKey(key) {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function loadStore() {
  return {
    readings: readKey(KEYS.readings) ?? [],
    setpoints: readKey(KEYS.setpoints) ?? { ...DEFAULT_SETPOINTS },
    events: readKey(KEYS.events) ?? [],
    alerts: readKey(KEYS.alerts) ?? [],
    metrics: { ...DEFAULT_METRICS, ...(readKey(KEYS.metrics) ?? {}) },
    actuators: { ...DEFAULT_ACTUATORS },
    serverLog: null,
    setpointAppliedAt: 0,
  }
}

const jitter = (base, spread) => base + (Math.random() * 2 - 1) * spread

export function useBiopod() {
  const store = useRef(null)
  if (store.current === null) store.current = loadStore()
  const [, bump] = useReducer((n) => n + 1, 0)
  const [toast, setToast] = useState(null)
  const [demoOn, setDemoOn] = useState(false)

  const demoTimer = useRef(null)
  const demoState = useRef(null)
  const lastId = useRef(null)
  const toastTimer = useRef(null)

  const showToast = useCallback((message) => {
    setToast(message)
    clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 4200)
  }, [])

  const persist = useCallback(() => {
    const s = store.current
    try {
      localStorage.setItem(KEYS.readings, JSON.stringify(s.readings))
      localStorage.setItem(KEYS.setpoints, JSON.stringify(s.setpoints))
      localStorage.setItem(KEYS.events, JSON.stringify(s.events))
      localStorage.setItem(KEYS.alerts, JSON.stringify(s.alerts))
      localStorage.setItem(KEYS.metrics, JSON.stringify(s.metrics))
    } catch {
      // storage full or blocked: the server-side log is unaffected
    }
  }, [])

  // ADT = Ta - To : Ta is when the dashboard receives the alert, To is the sample time
  // (NTP timestamp from the ESP32) at which the chamber first went out of range.
  // RT  = Tr - Td : Td is the marked disturbance, Tr is the first in-range sample after
  // the chamber actually left the range because of that disturbance.
  const handleAlertAndRecovery = useCallback(
    (reading) => {
      if (Math.abs(Date.now() - reading.time) >= 15000) return // not a live sample
      const s = store.current
      const m = s.metrics
      if (reading.status === 'Out of range') {
        if (m.waitingForRecovery) m.disturbanceExceeded = true
        if (m.outOfRangeAt === null) {
          m.outOfRangeAt = reading.time
          const received = Date.now()
          const adt = Math.max(0, (received - reading.time) / 1000)
          m.lastAdtSec = adt
          const message = `Out of range: ${showNumber(reading.avgTemp)} °C / ${showNumber(reading.avgHum)}% RH`
          s.alerts.unshift({ time: received, outAt: reading.time, adt, message })
          showToast(`Alert · ADT ${adt.toFixed(1)} s · ${message}`)
        }
      } else {
        if (m.waitingForRecovery && m.disturbanceAt && m.disturbanceExceeded) {
          m.lastRtSec = Math.max(0, (reading.time - m.disturbanceAt) / 1000)
          m.waitingForRecovery = false
          m.disturbanceExceeded = false
          m.disturbanceAt = null
          s.alerts.unshift({
            time: Date.now(),
            message: `Recovered to setpoint band. RT = ${m.lastRtSec.toFixed(1)} s`,
          })
        }
        m.outOfRangeAt = null
      }
    },
    [showToast],
  )

  const pushReading = useCallback(
    (temps, hums, time, source) => {
      const s = store.current
      const avgTemp = average(temps)
      const avgHum = average(hums)
      const reading = {
        time: time || Date.now(),
        temps,
        hums,
        avgTemp,
        avgHum,
        uniT: rangeOf(temps),
        uniH: rangeOf(hums),
        status: getStatus(avgTemp, avgHum, s.setpoints),
        source: source || 'manual',
        actuators: { ...s.actuators },
      }
      s.readings.push(reading)
      s.readings.sort((a, b) => a.time - b.time)
      if (s.readings.length > MAX_READINGS) s.readings = s.readings.slice(s.readings.length - MAX_READINGS)
      handleAlertAndRecovery(reading)
      persist()
      bump()
      return reading
    },
    [handleAlertAndRecovery, persist],
  )

  // ---- Manual log entry ---------------------------------------------------
  // `tempTexts` / `humTexts` are four strings from the form. Returns an error message or null.
  const addManualReading = useCallback(
    (tempTexts, humTexts, timeText) => {
      const temps = []
      const hums = []
      for (let i = 0; i < 4; i++) {
        const t = tempTexts[i] === '' ? null : Number(tempTexts[i])
        const h = humTexts[i] === '' ? null : Number(humTexts[i])
        if (t !== null && (Number.isNaN(t) || t < 0 || t > 60)) return `Temperature for sensor ${i + 1} must be between 0 and 60.`
        if (h !== null && (Number.isNaN(h) || h < 0 || h > 100)) return `Humidity for sensor ${i + 1} must be between 0 and 100.`
        temps.push(t)
        hums.push(h)
      }
      if (average(temps) === null && average(hums) === null) return 'Please enter at least one sensor reading.'
      const time = timeText === '' ? Date.now() : new Date(timeText).getTime()
      const s = store.current
      s.actuators = nextActuators(s.actuators, s.setpoints, average(temps), average(hums))
      pushReading(temps, hums, time, 'manual')
      return null
    },
    [pushReading],
  )

  // ---- Setpoints ----------------------------------------------------------
  const pushSetpointsToServer = useCallback(() => {
    const { temp, hum } = store.current.setpoints
    fetch('/api/setpoints', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ temp, hum }),
    })
      .then((res) => {
        if (!res.ok) showToast('Server rejected the setpoints (outside the safe range).')
        else showToast('Setpoints sent. The ESP32 picks them up on its next reading.')
      })
      .catch(() => showToast('Could not reach the server; the ESP32 was not updated.'))
  }, [showToast])

  // Returns an error message or null.
  const applySetpoints = useCallback(
    (tempText, humText) => {
      if (tempText === '' || humText === '') return 'Please enter both setpoints.'
      const newTemp = Number(tempText)
      const newHum = Number(humText)
      if (Number.isNaN(newTemp) || newTemp < 25 || newTemp > 45) return 'Temperature setpoint must be between 25 and 45.'
      if (Number.isNaN(newHum) || newHum < 20 || newHum > 90) return 'Humidity setpoint must be between 20 and 90.'
      const s = store.current
      if (newTemp === s.setpoints.temp && newHum === s.setpoints.hum) return 'Setpoints are unchanged.'
      s.events.push({
        time: Date.now(),
        oldTemp: s.setpoints.temp,
        newTemp,
        oldHum: s.setpoints.hum,
        newHum,
        label: setpointLabel(s.setpoints.temp, newTemp, s.setpoints.hum, newHum),
      })
      s.setpoints = { temp: newTemp, hum: newHum }
      s.setpointAppliedAt = Date.now()
      persist()
      pushSetpointsToServer()
      bump()
      return null
    },
    [persist, pushSetpointsToServer],
  )

  // ---- Disturbance, demo, export, clear -----------------------------------
  const markDisturbance = useCallback(() => {
    const s = store.current
    s.metrics.disturbanceAt = Date.now()
    s.metrics.disturbanceExceeded = false
    s.metrics.waitingForRecovery = true
    s.metrics.lastRtSec = null
    s.alerts.unshift({ time: Date.now(), message: 'Controlled disturbance marked (door open). Recovery timer started.' })
    if (demoState.current) {
      demoState.current.temp -= 3.2
      demoState.current.hum -= 8
    }
    persist()
    bump()
    showToast(`Disturbance marked. Wait for return to ±${TEMP_TOLERANCE} °C / ±${HUM_TOLERANCE}% RH.`)
  }, [persist, showToast])

  const demoTick = useCallback(() => {
    const d = demoState.current
    if (!d) return
    const s = store.current
    d.tick += 1
    d.temp += (s.setpoints.temp - d.temp) * 0.18 + jitter(0, 0.08)
    d.hum += (s.setpoints.hum - d.hum) * 0.12 + jitter(0, 0.35)
    if (d.tick === 18) {
      d.temp = 35.1
      d.hum = 41
    }
    const temps = [jitter(d.temp, 0.18), jitter(d.temp, 0.16), jitter(d.temp, 0.22), jitter(d.temp, 0.15)]
    const hums = [jitter(d.hum, 0.8), jitter(d.hum, 0.9), jitter(d.hum, 1.1), jitter(d.hum, 0.7)]
    s.actuators = nextActuators(s.actuators, s.setpoints, average(temps), average(hums))
    pushReading(temps, hums, Date.now(), 'demo')
  }, [pushReading])

  const stopDemo = useCallback(() => {
    if (demoTimer.current) {
      clearInterval(demoTimer.current)
      demoTimer.current = null
    }
    demoState.current = null
    setDemoOn(false)
  }, [])

  const startDemo = useCallback(() => {
    if (demoTimer.current) return
    demoState.current = { temp: 36.4, hum: 47.5, tick: 0 }
    setDemoOn(true)
    demoTick()
    demoTimer.current = setInterval(demoTick, 2000)
  }, [demoTick])

  const exportCsv = useCallback(() => {
    const s = store.current
    // Prefer the server's official 30-minute log when a trial is running.
    if (s.serverLog?.entries?.length > 0) {
      const a = document.createElement('a')
      a.href = '/api/log.csv'
      a.download = 'biopod_log_30min.csv'
      a.click()
      return
    }
    if (s.readings.length === 0) {
      showToast('There are no readings to export.')
      return
    }
    downloadBlob(new Blob([buildCsv(s.readings)], { type: 'text/csv' }), 'biopod_log.csv')
  }, [showToast])

  const clearAll = useCallback(() => {
    if (!window.confirm("Delete all readings, setpoints, alerts and events? This also restarts the server's 30-minute log.")) return
    stopDemo()
    const s = store.current
    s.readings = []
    s.events = []
    s.alerts = []
    s.serverLog = null
    s.setpoints = { ...DEFAULT_SETPOINTS }
    s.metrics = { ...DEFAULT_METRICS }
    s.actuators = { ...DEFAULT_ACTUATORS }
    s.setpointAppliedAt = Date.now()
    fetch('/api/log/reset', { method: 'POST' }).catch(() => {})
    pushSetpointsToServer()
    persist()
    bump()
  }, [persist, pushSetpointsToServer, stopDemo])

  // ---- ESP32 telemetry from server.py -------------------------------------
  const ingestPayload = useCallback(
    (payload) => {
      if (!payload || !payload.temps || !payload.hums) return
      const s = store.current
      const incomingTime = payload.time || Date.now()
      if (s.readings.some((r) => r.source === 'esp32' && r.time === incomingTime)) return
      const newest = s.readings.length ? s.readings[s.readings.length - 1].time : 0
      if (incomingTime + 2000 < newest) return
      // The server holds the authoritative setpoints; do not let a stale echo from the
      // ESP32 overwrite values the user has just applied.
      if (payload.setpoints && Date.now() - s.setpointAppliedAt > SETPOINT_HOLD_MS) {
        const next = { ...s.setpoints }
        if (typeof payload.setpoints.temp === 'number') next.temp = payload.setpoints.temp
        if (typeof payload.setpoints.hum === 'number') next.hum = payload.setpoints.hum
        s.setpoints = next
      }
      if (payload.actuators) s.actuators = { ...s.actuators, ...payload.actuators }
      else s.actuators = nextActuators(s.actuators, s.setpoints, average(payload.temps), average(payload.hums))
      pushReading(payload.temps, payload.hums, incomingTime, 'esp32')
    },
    [pushReading],
  )

  useEffect(() => {
    const pollReading = () => {
      fetch('/api/reading', { cache: 'no-store' })
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (!data || !data.temps) return
          if (data.id && lastId.current === data.id) return
          lastId.current = data.id
          ingestPayload(data)
        })
        .catch(() => {})
    }
    const pollLog = () => {
      fetch('/api/log', { cache: 'no-store' })
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (!data) return
          store.current.serverLog = data
          bump()
        })
        .catch(() => {})
    }
    pollReading()
    pollLog()
    const readingId = setInterval(pollReading, 2000)
    const logId = setInterval(pollLog, 15000)
    return () => {
      clearInterval(readingId)
      clearInterval(logId)
    }
  }, [ingestPayload])

  useEffect(
    () => () => {
      clearInterval(demoTimer.current)
      clearTimeout(toastTimer.current)
    },
    [],
  )

  // ---- Derived values for the UI ------------------------------------------
  const s = store.current
  const latest = s.readings.length ? s.readings[s.readings.length - 1] : null

  let link
  if (demoOn) link = { cls: 'live', text: 'Demo live' }
  else if (latest?.source === 'esp32') link = { cls: 'live', text: 'ESP32 linked' }
  else link = { cls: '', text: latest ? 'Logged' : 'Standby' }
  if (latest?.status === 'Out of range') link = { ...link, cls: `${link.cls} alert`.trim() }

  return {
    readings: s.readings,
    events: s.events,
    alerts: s.alerts,
    metrics: s.metrics,
    setpoints: s.setpoints,
    actuators: s.actuators,
    serverLog: s.serverLog,
    latest,
    completeness: loggingCompleteness(s.readings, s.serverLog),
    link,
    demoOn,
    toast,
    startDemo,
    stopDemo,
    markDisturbance,
    addManualReading,
    applySetpoints,
    exportCsv,
    clearAll,
    formatTime,
  }
}
