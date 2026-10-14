import { useMemo, useState } from 'react'
import { SENSOR_COLORS, eventLabel, formatTime, showNumber } from '../lib/biopod'

// Dependency-free SVG line chart: four sensors + average, a shaded acceptance band,
// a dashed setpoint line and a marker for every setpoint change.

const W = 640
const H = 300
const M = { l: 46, r: 14, t: 14, b: 30 }
const PLOT_W = W - M.l - M.r
const PLOT_H = H - M.t - M.b

export default function TrendChart({ readings, events, unit, setpoint, tolerance, yTitle, suffix }) {
  const [hover, setHover] = useState(null)
  const isTemp = unit === 'temp'

  const view = useMemo(() => {
    if (readings.length === 0) return null
    let t0 = readings[0].time
    let t1 = readings[readings.length - 1].time
    if (t1 === t0) {
      t0 -= 60000
      t1 += 60000
    }
    const valueOf = (r, s) => (isTemp ? r.temps[s] : r.hums[s])
    const avgOf = (r) => (isTemp ? r.avgTemp : r.avgHum)

    let lo = setpoint - tolerance
    let hi = setpoint + tolerance
    for (const r of readings) {
      for (let s = 0; s < 4; s++) {
        const v = valueOf(r, s)
        if (v !== null) {
          lo = Math.min(lo, v)
          hi = Math.max(hi, v)
        }
      }
    }
    const pad = (hi - lo) * 0.08 || 1
    lo -= pad
    hi += pad

    const x = (t) => M.l + ((t - t0) / (t1 - t0)) * PLOT_W
    const y = (v) => M.t + (1 - (v - lo) / (hi - lo)) * PLOT_H

    const sensorPaths = SENSOR_COLORS.map((color, s) => {
      const pts = readings.filter((r) => valueOf(r, s) !== null).map((r) => `${x(r.time).toFixed(1)},${y(valueOf(r, s)).toFixed(1)}`)
      return { color, label: `Sensor ${s + 1}`, points: pts.join(' ') }
    })
    const avgPts = readings.filter((r) => avgOf(r) !== null).map((r) => `${x(r.time).toFixed(1)},${y(avgOf(r)).toFixed(1)}`)

    const yTicks = Array.from({ length: 5 }, (_, i) => lo + ((hi - lo) * i) / 4)
    const xTicks = Array.from({ length: 5 }, (_, i) => t0 + ((t1 - t0) * i) / 4)
    const marks = events
      .filter((e) => e.time >= t0 && e.time <= t1)
      .map((e) => ({ x: x(e.time), text: eventLabel(e, unit) }))

    return { t0, t1, x, y, sensorPaths, avgPts: avgPts.join(' '), yTicks, xTicks, marks, valueOf, avgOf }
  }, [readings, events, unit, setpoint, tolerance, isTemp])

  if (!view) return <p className="note chart-empty">No data yet. Run the demo, link the ESP32, or add a manual log.</p>

  const onMove = (e) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
    const px = frac * W
    const t = view.t0 + ((px - M.l) / PLOT_W) * (view.t1 - view.t0)
    let best = 0
    let bestD = Infinity
    for (let i = 0; i < readings.length; i++) {
      const d = Math.abs(readings[i].time - t)
      if (d < bestD) {
        bestD = d
        best = i
      }
    }
    setHover(best)
  }

  const hovered = hover !== null && readings[hover] ? readings[hover] : null
  const hoverX = hovered ? view.x(hovered.time) : 0
  const showPoints = readings.length <= 40

  return (
    <div className="chart-wrap" onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${yTitle} over time`} className="chart-svg">
        <rect
          x={M.l}
          y={view.y(setpoint + tolerance)}
          width={PLOT_W}
          height={view.y(setpoint - tolerance) - view.y(setpoint + tolerance)}
          fill="rgba(61, 139, 99, 0.12)"
          stroke="rgba(61, 139, 99, 0.28)"
        />
        {view.yTicks.map((v) => (
          <g key={v}>
            <line x1={M.l} x2={W - M.r} y1={view.y(v)} y2={view.y(v)} stroke="rgba(217, 208, 189, 0.7)" />
            <text x={M.l - 6} y={view.y(v) + 4} textAnchor="end" className="chart-tick">{v.toFixed(1)}</text>
          </g>
        ))}
        {view.xTicks.map((t) => (
          <text key={t} x={view.x(t)} y={H - 10} textAnchor="middle" className="chart-tick">{formatTime(t).slice(11, 16)}</text>
        ))}
        <text x={12} y={M.t + PLOT_H / 2} transform={`rotate(-90 12 ${M.t + PLOT_H / 2})`} textAnchor="middle" className="chart-axis">{yTitle}</text>

        <line x1={M.l} x2={W - M.r} y1={view.y(setpoint)} y2={view.y(setpoint)} stroke="#c9a227" strokeWidth="2" strokeDasharray="6 4" />

        {view.marks.map((m, i) => (
          <g key={i}>
            <line x1={m.x} x2={m.x} y1={M.t} y2={M.t + PLOT_H} stroke="#c45c26" strokeWidth="1.5" strokeDasharray="4 4" />
            {m.text && <text x={m.x + 4} y={M.t + 12} className="chart-event">{m.text}</text>}
          </g>
        ))}

        {view.sensorPaths.map((p) => (
          <polyline key={p.label} points={p.points} fill="none" stroke={p.color} strokeWidth="2" strokeLinejoin="round" />
        ))}
        <polyline points={view.avgPts} fill="none" stroke="#14261f" strokeWidth="2.5" strokeLinejoin="round" />

        {showPoints &&
          view.sensorPaths.map((p, s) =>
            readings.map((r, i) =>
              view.valueOf(r, s) === null ? null : (
                <circle key={`${s}-${i}`} cx={view.x(r.time)} cy={view.y(view.valueOf(r, s))} r="3" fill="#fffdf8" stroke={p.color} strokeWidth="2" />
              ),
            ),
          )}

        {hovered && <line x1={hoverX} x2={hoverX} y1={M.t} y2={M.t + PLOT_H} stroke="rgba(20, 38, 31, 0.35)" />}
      </svg>

      {hovered && (
        <div className="chart-tip" style={{ left: `${(hoverX / W) * 100}%` }} data-flip={hoverX / W > 0.6}>
          <strong>{formatTime(hovered.time)}</strong>
          {view.sensorPaths.map((p, s) => (
            <span key={p.label}>
              <i style={{ background: p.color }} />
              {p.label}: {showNumber(view.valueOf(hovered, s))}{suffix}
            </span>
          ))}
          <span>
            <i style={{ background: '#14261f' }} />
            Average: {showNumber(view.avgOf(hovered))}{suffix}
          </span>
        </div>
      )}

      <ul className="chart-legend">
        {view.sensorPaths.map((p) => (
          <li key={p.label}><i style={{ background: p.color }} />{p.label}</li>
        ))}
        <li><i style={{ background: '#14261f' }} />Average</li>
      </ul>
    </div>
  )
}
