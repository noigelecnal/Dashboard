import { useCallback, useEffect, useMemo, useState } from 'react'
import { useProgress } from '@react-three/drei'
import { TriangleAlert } from 'lucide-react'
import './App.css'
import { COMPONENTS, MODEL_CONFIG } from './config/modelConfig'
import { useBiopod } from './hooks/useBiopod'
import { HUM_TOLERANCE, TEMP_TOLERANCE, showNumber } from './lib/biopod'
import Viewer3D from './components/Viewer3D'
import ViewerControls from './components/ViewerControls'
import ComponentPanel from './components/ComponentPanel'
import ComponentInfo from './components/ComponentInfo'
import { ActuatorPanel, AlertsPanel, ChamberPanel, ChartsRow, LogPanel, ManualLogPanel } from './components/BiopodDashboard'

const EMPTY_INFO = { mode: 'none', clips: [], found: {} }

const MOTION_TEXT = {
  closed: 'Closed',
  opening: 'Opening…',
  open: 'Open',
  closing: 'Closing…',
  partial: 'Partly open',
}

function LoadingOverlay() {
  const { active, progress } = useProgress()
  if (!active) return null
  return (
    <div className="overlay" role="status">
      Loading model… {Math.round(progress)}%
    </div>
  )
}

function Clock() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(id)
  }, [])
  return <span className="clock">{now.toLocaleTimeString([], { hour12: false })}</span>
}

export default function App() {
  const [openTarget, setOpenTarget] = useState(0)
  const [motion, setMotion] = useState('closed')
  const [exploded, setExploded] = useState(false)
  const [hiddenIds, setHiddenIds] = useState(() => new Set())
  const [selectedId, setSelectedId] = useState(null)
  const [resetCount, setResetCount] = useState(0)
  const [info, setInfo] = useState(EMPTY_INFO)
  const [modelError, setModelError] = useState(null)

  const bp = useBiopod()

  const toggleHidden = useCallback((id) => {
    setHiddenIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])
  const showAll = useCallback(() => setHiddenIds(new Set()), [])
  const select = useCallback((id) => setSelectedId((prev) => (prev === id ? null : id)), [])
  const handleModelError = useCallback((err) => setModelError(err?.message ?? 'Unknown error'), [])

  const modelProps = useMemo(
    () => ({ openTarget, exploded, hiddenIds, selectedId, onSelect: select, onInfo: setInfo, onMotion: setMotion }),
    [openTarget, exploded, hiddenIds, selectedId, select],
  )

  const canAnimate = info.mode !== 'none'
  const usingPlaceholder = !MODEL_CONFIG.glbUrl || Boolean(modelError)
  const selected = COMPONENTS.find((c) => c.id === selectedId)
  const lidText = canAnimate ? MOTION_TEXT[motion] : 'No lid animation'
  const { latest, metrics, setpoints, completeness } = bp

  // Chamber status banner (in range / out of range / no data)
  let bannerClass = ''
  let kicker = 'Chamber status'
  let statusCopy = 'No readings yet. Start a live session, run the demo, or add a manual log.'
  if (latest) {
    const line = `${showNumber(latest.avgTemp)} °C · ${showNumber(latest.avgHum)}% RH`
    if (latest.status === 'Out of range') {
      bannerClass = 'out'
      kicker = 'Out of range'
      statusCopy = `${line} — outside the ±${TEMP_TOLERANCE} °C / ±${HUM_TOLERANCE}% RH acceptance range.`
    } else {
      bannerClass = 'in'
      kicker = 'In range'
      statusCopy = `${line} — holding near ${setpoints.temp} °C / ${setpoints.hum}% RH.`
    }
  }

  const sourceNote =
    bp.demoOn
      ? 'Demo telemetry'
      : latest?.source === 'esp32'
        ? 'Live from ESP32'
        : latest?.source === 'manual'
          ? 'Manual entry'
          : 'No data source'

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="mark" aria-hidden>
            <span className="mark-ring" />
            <span className="mark-core" />
          </div>
          <div>
            <p className="eyebrow">Luis Y. Ferrer Jr. SHS · STEM Capstone</p>
            <h1>{MODEL_CONFIG.productName}</h1>
            <p className="tagline">{MODEL_CONFIG.tagline}</p>
          </div>
        </div>
        <span />
        <div className="top-meta">
          <div className={`live-pill ${bp.link.cls}`} title="Data source">
            <span className="dot" aria-hidden />
            <span>{bp.link.text}</span>
          </div>
          <Clock />
        </div>
      </header>

      <section className={`status-banner ${bannerClass}`} aria-live="polite">
        <div>
          <p className="status-kicker">{kicker}</p>
          <p className="status-copy">{statusCopy}</p>
          <p className="status-sub">Lid {lidText.toLowerCase()} · {exploded ? 'exploded view' : 'assembled'}</p>
        </div>
        <div className="status-actions">
          {bp.demoOn ? (
            <button type="button" className="btn ghost" onClick={bp.stopDemo}>Stop demo</button>
          ) : (
            <button type="button" className="btn ghost" onClick={bp.startDemo}>Run demo telemetry</button>
          )}
          <button type="button" className="btn copper" onClick={bp.markDisturbance}>Mark door disturbance</button>
        </div>
      </section>

      <section className="kpi-grid" aria-label="Key performance indicators">
        <div className="kpi">
          <p className="kpi-label">Average temperature</p>
          <p className="kpi-value">{latest ? showNumber(latest.avgTemp) : '—'}<small>°C</small></p>
          <p className="kpi-note">Setpoint {setpoints.temp.toFixed(1)} ± {TEMP_TOLERANCE} · {sourceNote}</p>
        </div>
        <div className="kpi">
          <p className="kpi-label">Average humidity</p>
          <p className="kpi-value">{latest ? showNumber(latest.avgHum) : '—'}<small>% RH</small></p>
          <p className="kpi-note">Setpoint {setpoints.hum.toFixed(0)} ± {HUM_TOLERANCE} · {sourceNote}</p>
        </div>
        <div className="kpi">
          <p className="kpi-label">Chamber uniformity</p>
          <p className="kpi-value">
            {latest && latest.uniT !== null ? `${showNumber(latest.uniT)} / ${showNumber(latest.uniH)}` : '—'}
            <small>°C / %RH</small>
          </p>
          <p className="kpi-note">Range across four sensor points</p>
        </div>
        <div className="kpi">
          <p className="kpi-label">Logging completeness</p>
          <p className="kpi-value">{completeness.pct === null ? '—' : showNumber(completeness.pct, 0)}<small>%</small></p>
          <p className="kpi-note">
            {completeness.pct === null
              ? '30-minute expected slots'
              : `${completeness.valid} of ${completeness.expected} half-hour slots${completeness.server ? ' (server log)' : ''}`}
          </p>
        </div>
        <div className="kpi">
          <p className="kpi-label">Alert detection (ADT)</p>
          <p className="kpi-value">{metrics.lastAdtSec === null ? '—' : showNumber(metrics.lastAdtSec, 1)}<small>s</small></p>
          <p className="kpi-note">ADT = Ta − To (alert received − condition out of range)</p>
        </div>
        <div className="kpi">
          <p className="kpi-label">Recovery time (RT)</p>
          <p className="kpi-value">{metrics.lastRtSec === null ? '—' : showNumber(metrics.lastRtSec, 1)}<small>s</small></p>
          <p className="kpi-note">
            {metrics.waitingForRecovery ? 'Waiting for the chamber to leave, then return to, the range' : 'After last marked disturbance'}
          </p>
        </div>
      </section>

      <section className="kpi-grid kpi-grid-4" aria-label="Model summary">
        <div className="kpi">
          <p className="kpi-label">Lid</p>
          <p className="kpi-value">{canAnimate ? MOTION_TEXT[motion].replace('…', '') : '—'}</p>
          <p className="kpi-note">{Math.round(openTarget * 100)}% target</p>
        </div>
        <div className="kpi">
          <p className="kpi-label">View</p>
          <p className="kpi-value">{exploded ? 'Exploded' : 'Assembled'}</p>
          <p className="kpi-note">Toggle below the model</p>
        </div>
        <div className="kpi">
          <p className="kpi-label">Hidden parts</p>
          <p className="kpi-value">{hiddenIds.size}<small>of {COMPONENTS.length}</small></p>
          <p className="kpi-note">Use the eye icons</p>
        </div>
        <div className="kpi">
          <p className="kpi-label">Selected</p>
          <p className="kpi-value">{selected ? selected.label : '—'}</p>
          <p className="kpi-note">Click a marker or list item</p>
        </div>
      </section>

      <div className="main-grid">
        <section className="panel" aria-labelledby="viewer-title">
          <div className="panel-head">
            <h2 id="viewer-title" className="panel-title">Interactive model</h2>
            <p>Drag to rotate · scroll or pinch to zoom · click a marker to inspect a part</p>
          </div>

          <div className="viewer">
            <Viewer3D modelProps={modelProps} resetCount={resetCount} onModelError={handleModelError} />
            <LoadingOverlay />
            <span className="tag tag-state">{lidText}</span>
            {usingPlaceholder && <span className="tag tag-model">Placeholder model</span>}
          </div>

          {modelError && (
            <p className="banner" role="alert">
              <TriangleAlert size={16} aria-hidden /> Could not load {MODEL_CONFIG.glbUrl}: {modelError}. Showing the placeholder instead.
            </p>
          )}
          {!canAnimate && (
            <p className="banner" role="alert">
              <TriangleAlert size={16} aria-hidden /> This model has no opening animation and no lid object matching the configured names, so open/close is disabled.
            </p>
          )}

          <ViewerControls
            motion={motion}
            openTarget={openTarget}
            onOpenTarget={setOpenTarget}
            exploded={exploded}
            onToggleExploded={() => setExploded((v) => !v)}
            onResetCamera={() => setResetCount((n) => n + 1)}
            canAnimate={canAnimate}
          />
        </section>

        <aside className="side">
          <ComponentPanel
            found={info.found}
            hiddenIds={hiddenIds}
            selectedId={selectedId}
            onSelect={select}
            onToggleHidden={toggleHidden}
            onShowAll={showAll}
          />
          <ComponentInfo selectedId={selectedId} found={info.found} hiddenIds={hiddenIds} />
        </aside>
      </div>

      <div className="main-grid">
        <ChamberPanel latest={latest} setpoints={setpoints} />
        <ActuatorPanel actuators={bp.actuators} setpoints={setpoints} onApply={bp.applySetpoints} />
      </div>

      <ChartsRow readings={bp.readings} events={bp.events} setpoints={setpoints} />

      <div className="lower-grid">
        <AlertsPanel alerts={bp.alerts} />
        <ManualLogPanel onAdd={bp.addManualReading} />
      </div>

      <LogPanel readings={bp.readings} events={bp.events} onExport={bp.exportCsv} onClear={bp.clearAll} />

      <footer className="footer">
        <span>
          {MODEL_CONFIG.productName} · {MODEL_CONFIG.revision} · {usingPlaceholder ? 'placeholder model' : MODEL_CONFIG.glbUrl}
        </span>
        <span>
          {bp.demoOn
            ? 'Readings are demo telemetry, not measured.'
            : latest?.source === 'esp32'
              ? 'Readings come from the ESP32 through server.py.'
              : latest?.source === 'manual'
                ? 'Latest reading was entered manually.'
                : 'No sensor data source is active.'}
        </span>
      </footer>

      {bp.toast && <div className="toast" role="status">{bp.toast}</div>}
    </div>
  )
}
