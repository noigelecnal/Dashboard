import { useEffect, useState } from 'react'
import TrendChart from './TrendChart'
import {
  HUM_HYSTERESIS,
  HUM_TOLERANCE,
  TEMP_HYSTERESIS,
  TEMP_TOLERANCE,
  formatTime,
  inHumBand,
  inTempBand,
  showNumber,
  toInputValue,
} from '../lib/biopod'

const ZONES = ['S1 · Upper left', 'S2 · Upper right', 'S3 · Lower left', 'S4 · Lower right']

export function ChamberPanel({ latest, setpoints }) {
  return (
    <section className="panel" aria-labelledby="chamber-title">
      <div className="panel-head">
        <h2 id="chamber-title" className="panel-title">Chamber map</h2>
        <p>Four AM2302B points · 35 × 35 × 35 cm</p>
      </div>
      <div className="chamber-frame">
        {ZONES.map((name, i) => {
          const t = latest ? latest.temps[i] : null
          const h = latest ? latest.hums[i] : null
          const ok = latest && (t === null || inTempBand(t, setpoints)) && (h === null || inHumBand(h, setpoints))
          const cls = !latest ? '' : ok ? ' in' : ' out'
          return (
            <article key={name} className={`zone${cls}`}>
              <span className="zone-id">{name}</span>
              <strong>{latest ? `${showNumber(t)}°` : '—'}</strong>
              <span>{latest ? `${showNumber(h)}% RH` : '— % RH'}</span>
            </article>
          )
        })}
      </div>
      <p className="chamber-caption">Color shows in-range (moss) or out-of-band (terracotta) at each point.</p>
    </section>
  )
}

const ACTUATORS = [
  { key: 'heater', label: 'PTC heater', on: 'Heating', off: 'Idle' },
  { key: 'peltier', label: 'Peltier TEC1-12706', on: 'Cooling', off: 'Idle' },
  { key: 'fan', label: '5010 blower', on: 'Circulating', off: 'Off' },
  { key: 'humidifier', label: 'Ultrasonic atomizer', on: 'Mist on', off: 'Idle' },
]

export function ActuatorPanel({ actuators, setpoints, onApply }) {
  const [temp, setTemp] = useState(String(setpoints.temp))
  const [hum, setHum] = useState(String(setpoints.hum))
  const [error, setError] = useState(null)

  // Follow setpoint changes that come from the server / ESP32.
  useEffect(() => {
    setTemp(String(setpoints.temp))
    setHum(String(setpoints.hum))
  }, [setpoints.temp, setpoints.hum])

  const submit = (e) => {
    e.preventDefault()
    setError(onApply(temp, hum))
  }

  return (
    <section className="panel" aria-labelledby="actuators-title">
      <div className="panel-head">
        <h2 id="actuators-title" className="panel-title">Actuators</h2>
        <p>MOSFET-switched 12 V / 5 V loads</p>
      </div>
      <ul className="actuators">
        {ACTUATORS.map((a) => (
          <li key={a.key} className={actuators[a.key] ? 'on' : ''}>
            <span>{a.label}</span>
            <b>{actuators[a.key] ? a.on : a.off}</b>
          </li>
        ))}
      </ul>
      <form className="setpoint-box" onSubmit={submit}>
        <h3>Setpoints</h3>
        <div className="set-row">
          <label htmlFor="tempSetpoint">Temperature (°C)</label>
          <input type="number" step="0.1" id="tempSetpoint" value={temp} onChange={(e) => setTemp(e.target.value)} />
        </div>
        <div className="set-row">
          <label htmlFor="humSetpoint">Humidity (% RH)</label>
          <input type="number" step="0.1" id="humSetpoint" value={hum} onChange={(e) => setHum(e.target.value)} />
        </div>
        <button type="submit" className="btn primary">Apply setpoints</button>
        {error && <p className="note note-warn" role="alert">{error}</p>}
        <p className="hint">
          Hysteresis ±{TEMP_HYSTERESIS} °C / ±{HUM_HYSTERESIS}% RH. Acceptance range ±{TEMP_TOLERANCE} °C / ±{HUM_TOLERANCE}% RH.
        </p>
      </form>
    </section>
  )
}

export function ChartsRow({ readings, events, setpoints }) {
  return (
    <div className="charts-grid">
      <section className="panel" aria-labelledby="temp-chart-title">
        <div className="panel-head">
          <h2 id="temp-chart-title" className="panel-title">Temperature over time</h2>
          <p>Shaded band = ±{TEMP_TOLERANCE} °C acceptance range</p>
        </div>
        <TrendChart readings={readings} events={events} unit="temp" setpoint={setpoints.temp} tolerance={TEMP_TOLERANCE} yTitle="Temperature (°C)" suffix=" °C" />
      </section>
      <section className="panel" aria-labelledby="hum-chart-title">
        <div className="panel-head">
          <h2 id="hum-chart-title" className="panel-title">Humidity over time</h2>
          <p>Shaded band = ±{HUM_TOLERANCE} % RH acceptance range</p>
        </div>
        <TrendChart readings={readings} events={events} unit="humidity" setpoint={setpoints.hum} tolerance={HUM_TOLERANCE} yTitle="Relative humidity (%)" suffix=" %" />
      </section>
    </div>
  )
}

export function AlertsPanel({ alerts }) {
  return (
    <section className="panel" aria-labelledby="alerts-title">
      <div className="panel-head">
        <h2 id="alerts-title" className="panel-title">Alert feed</h2>
        <p>Dashboard notifications for out-of-range events</p>
      </div>
      <ul className="alerts">
        {alerts.length === 0 && <li className="empty">No alerts yet.</li>}
        {alerts.slice(0, 12).map((a, i) => (
          <li key={`${a.time}-${i}`}>{formatTime(a.time)} — {a.message}</li>
        ))}
      </ul>
    </section>
  )
}

const blank = () => ['', '', '', '']

export function ManualLogPanel({ onAdd }) {
  const [temps, setTemps] = useState(blank)
  const [hums, setHums] = useState(blank)
  const [time, setTime] = useState(() => toInputValue(Date.now()))
  const [error, setError] = useState(null)

  const set = (setter) => (i, value) => setter((prev) => prev.map((v, idx) => (idx === i ? value : v)))
  const setTempAt = set(setTemps)
  const setHumAt = set(setHums)

  const submit = (e) => {
    e.preventDefault()
    const err = onAdd(temps, hums, time)
    setError(err)
    if (!err) {
      setTemps(blank())
      setHums(blank())
      setTime(toInputValue(Date.now()))
    }
  }

  return (
    <section className="panel" aria-labelledby="manual-title">
      <div className="panel-head">
        <h2 id="manual-title" className="panel-title">Manual log entry</h2>
        <p>For bench tests when the ESP32 is offline</p>
      </div>
      <form onSubmit={submit}>
        <div className="sensor-head">
          <span>Point</span>
          <span>Temp (°C)</span>
          <span>RH (%)</span>
        </div>
        {[0, 1, 2, 3].map((i) => (
          <div className="sensor-row" key={i}>
            <label htmlFor={`temp${i + 1}`}>Sensor {i + 1}</label>
            <input type="number" step="0.1" id={`temp${i + 1}`} value={temps[i]} placeholder={i === 0 ? '36.8' : ''} onChange={(e) => setTempAt(i, e.target.value)} />
            <input type="number" step="0.1" id={`hum${i + 1}`} value={hums[i]} placeholder={i === 0 ? '50.0' : ''} aria-label={`Sensor ${i + 1} humidity`} onChange={(e) => setHumAt(i, e.target.value)} />
          </div>
        ))}
        <label className="field-label" htmlFor="readingTime">Date and time</label>
        <input type="datetime-local" id="readingTime" value={time} onChange={(e) => setTime(e.target.value)} />
        <button type="submit" className="btn primary">Add reading</button>
        {error && <p className="note note-warn" role="alert">{error}</p>}
      </form>
    </section>
  )
}

export function LogPanel({ readings, events, onExport, onClear }) {
  const rows = [
    ...readings.map((r) => ({ kind: 'reading', time: r.time, data: r })),
    ...events.map((e) => ({ kind: 'event', time: e.time, data: e })),
  ]
    .sort((a, b) => b.time - a.time)
    .slice(0, 250)

  return (
    <section className="panel" aria-labelledby="log-title">
      <div className="log-head">
        <div>
          <h2 id="log-title" className="panel-title">Timestamped log</h2>
          <p className="sub">Live samples shown below · Export CSV downloads the official 30-minute trial log</p>
        </div>
        <div className="actions">
          <button type="button" className="btn ghost" onClick={onExport}>Export CSV</button>
          <button type="button" className="btn danger" onClick={onClear}>Clear all data</button>
        </div>
      </div>
      <div className="table-wrap">
        <table className="log-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>S1 T</th><th>S2 T</th><th>S3 T</th><th>S4 T</th>
              <th>S1 H</th><th>S2 H</th><th>S3 H</th><th>S4 H</th>
              <th>Avg T</th><th>Avg H</th><th>ΔT</th><th>ΔH</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) =>
              row.kind === 'event' ? (
                <tr key={`e-${row.time}`} className="event-row">
                  <td>{formatTime(row.time)}</td>
                  <td colSpan={13}>Setpoint changed: {row.data.label}</td>
                </tr>
              ) : (
                <tr key={`r-${row.time}-${row.data.source}`} className={row.data.status === 'Out of range' ? 'out-row' : ''}>
                  <td>{formatTime(row.time)}</td>
                  {row.data.temps.map((v, i) => <td key={`t${i}`}>{showNumber(v)}</td>)}
                  {row.data.hums.map((v, i) => <td key={`h${i}`}>{showNumber(v)}</td>)}
                  <td>{showNumber(row.data.avgTemp)}</td>
                  <td>{showNumber(row.data.avgHum)}</td>
                  <td>{showNumber(row.data.uniT)}</td>
                  <td>{showNumber(row.data.uniH)}</td>
                  <td>{row.data.status}</td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      </div>
      <p className="footnote">
        BioPod is a student prototype for educational incubation monitoring. It is not a certified laboratory incubator. Start <code>python server.py</code> so the ESP32 can POST to <code>/api/reading</code>.
      </p>
    </section>
  )
}
