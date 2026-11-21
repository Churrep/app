import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { api, errorText, upload } from '../api'
import { AudioPlayer } from '../components/AudioPlayer'
import { Header } from '../components/Header'
import { InsecureHelp, isPermissionError, mediaAvailable, PermissionHelp } from '../components/MediaHelp'
import { ErrorState, Loading } from '../components/States'
import { computePeaks, Waveform } from '../components/Waveform'
import { keepAwake, listDevices, openContext, openMic, routeLabels } from '../lib/calibration'
import { checkDevices, findResult, getAdjust, getPrefs, looksBluetooth, type Method, methodName, setAdjust as storeAdjust } from '../lib/calibrationStore'
import { click, encodeWav, loadBuffer, PcmRecorder } from '../lib/pcm'
import { useMe } from '../session'
import type { Spot } from '../types'
import { fmtDuration, nameOf } from '../types'

type Phase = 'intro' | 'preparing' | 'recording' | 'mix' | 'uploading' | 'interrupted' | 'denied'

// Сервер принимает сдвиг от −300 до 300 мс, с точностью до миллисекунды.
const MAX_OFFSET = 300
const clampOffset = (ms: number) => Math.max(-MAX_OFFSET, Math.min(MAX_OFFSET, Math.round(ms)))

// Калибровки для выбранных входа и выхода: какими методами есть результат.
function availableMethods() {
  const p = getPrefs()
  return (['A', 'B', 'C'] as const).filter((m) => findResult(p.inputId, p.outputId, m))
}

// Метод по умолчанию: выбранный в настройках, если по нему есть результат, иначе самый точный из имеющихся.
function defaultMethod(): Method | null {
  const avail = availableMethods()
  const pref = getPrefs().method
  return avail.includes(pref) ? pref : avail[0] ?? null
}

export function RecordTrack() {
  const { id = '' } = useParams()
  const { catalog } = useMe()
  const navigate = useNavigate()
  const [spot, setSpot] = useState<Spot | null>(null)
  const [loadError, setLoadError] = useState<unknown>(null)
  const [phase, setPhase] = useState<Phase>('intro')
  const [error, setError] = useState('')
  const [startSec, setStartSec] = useState(0)
  const [pos, setPos] = useState(0)
  const [countIn, setCountIn] = useState(0)
  const [track, setTrack] = useState<Float32Array | null>(null)
  const [gainBacking, setGainBacking] = useState(1)
  const [gainTrack, setGainTrack] = useState(1)
  const [playing, setPlaying] = useState(false)
  const [progress, setProgress] = useState(0)
  const [method, setMethod] = useState<Method | null>(defaultMethod)
  // Сдвиг партии = −(задержка + подстройка). base — задержка из калибровки (или оценка браузера), adjust — ручная добавка.
  const [base, setBase] = useState<{ ms: number; key: string | null; label: string }>({ ms: 0, key: null, label: '' })
  const [adjust, setAdjustState] = useState(0)
  const [monitor, setMonitor] = useState(false)
  const [warnings, setWarnings] = useState<string[]>([])
  const [routeWarn, setRouteWarn] = useState('')

  const ctx = useRef<AudioContext | null>(null)
  const backing = useRef<AudioBuffer | null>(null)
  const stream = useRef<MediaStream | null>(null)
  const recorder = useRef<PcmRecorder | null>(null)
  const sources = useRef<AudioScheduledSourceNode[]>([])
  const monitorNode = useRef<MediaStreamAudioSourceNode | null>(null)
  const releaseWake = useRef<() => void>(() => {})
  const backingAt = useRef(0)
  const raf = useRef(0)

  const offset = clampOffset(-(base.ms + adjust))
  const prefs = getPrefs()
  const avail = availableMethods()
  const chosen = method ? findResult(prefs.inputId, prefs.outputId, method) : null

  useEffect(() => {
    api<Spot>(`/spots/${encodeURIComponent(id)}`).then(setSpot).catch(setLoadError)
  }, [id])

  // Подсказки про маршрут: устройства поменялись или похоже на Bluetooth.
  useEffect(() => {
    checkDevices().then(async (changed) => {
      const d = navigator.mediaDevices ? await listDevices().catch(() => null) : null
      const l = routeLabels(d, prefs.inputId, prefs.outputId)
      if (changed) setRouteWarn('Устройства поменялись после калибровки — лучше откалибровать заново.')
      else if (looksBluetooth(l.input) || looksBluetooth(l.output)) setRouteWarn('Похоже на Bluetooth-наушники: задержка большая и меняется. Проводные точнее.')
    })
  }, [prefs.inputId, prefs.outputId])

  useEffect(() => () => {
    cancelAnimationFrame(raf.current)
    stopSources()
    monitorNode.current?.disconnect()
    releaseWake.current()
    stream.current?.getTracks().forEach((t) => t.stop())
    ctx.current?.close()
  }, [])

  // Свернули приложение во время записи — запись прерывается, начинаем заново.
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden' && phase === 'recording') {
        stopSources()
        recorder.current?.stop()
        recorder.current = null
        setPhase('interrupted')
      }
    }
    document.addEventListener('visibilitychange', onHide)
    return () => document.removeEventListener('visibilitychange', onHide)
  }, [phase])

  function stopSources() {
    sources.current.forEach((s) => {
      try {
        s.stop()
      } catch {
        // уже остановлен
      }
    })
    sources.current = []
    setPlaying(false)
  }

  // AudioContext и микрофон — только по нажатию (требование iPhone). Вход и выход — те же, что при калибровке.
  async function prepare() {
    const w: string[] = []
    if (!ctx.current) {
      const opened = await openContext(prefs.outputId)
      ctx.current = opened.ctx
      w.push(...opened.warnings)
    }
    await ctx.current.resume()
    if (!backing.current) backing.current = await loadBuffer(ctx.current, spot!.backing_url)
    if (!stream.current) {
      const mic = await openMic(prefs.inputId)
      stream.current = mic.stream
      w.push(...mic.warnings)
    }
    if (w.length) setWarnings(w)
    return ctx.current
  }

  // compensation — задержка для сдвига: калибровка выбранным методом под эту частоту, иначе оценка браузера.
  function compensation(c: AudioContext) {
    if (method) {
      const exact = findResult(prefs.inputId, prefs.outputId, method, c.sampleRate)
      if (exact) return { ms: exact.rec.rtlMs, key: exact.key, label: `калибровка «${methodName[method]}»` }
    }
    // Без калибровки подстройку не запоминаем: она ни к чему не привязана.
    return { ms: ((c.outputLatency || 0) + c.baseLatency) * 1000 + 10, key: null, label: 'оценка браузера, без калибровки' }
  }

  function changeAdjust(ms: number) {
    const v = Math.max(-500, Math.min(500, Math.round(ms)))
    setAdjustState(v)
    if (base.key) storeAdjust(base.key, v) // подстройка запоминается как добавка к этой калибровке
  }

  async function record() {
    if (!spot) return
    setError('')
    setPhase('preparing')
    try {
      const c = await prepare()
      const rec = await PcmRecorder.create(c, stream.current!)
      recorder.current = rec
      releaseWake.current = await keepAwake()
      // Слышать себя — только в наушниках, иначе динамик заведёт микрофон.
      if (monitor) {
        monitorNode.current = c.createMediaStreamSource(stream.current!)
        monitorNode.current.connect(c.destination)
      }

      // Отсчёт: один такт (4 доли) по темпу песни, потом минус.
      const beat = 60 / spot.bpm
      const t0 = c.currentTime + 0.3
      for (let i = 0; i < 4; i++) click(c, t0 + i * beat, i === 0)
      const at = t0 + 4 * beat
      backingAt.current = at
      const src = c.createBufferSource()
      src.buffer = backing.current
      src.connect(c.destination)
      src.start(at, startSec)
      src.onended = () => finish()
      sources.current = [src]
      setPhase('recording')

      const tick = () => {
        const now = c.currentTime
        setCountIn(now < at ? Math.ceil((at - now) / beat) : 0)
        setPos(Math.max(0, now - at))
        raf.current = requestAnimationFrame(tick)
      }
      tick()
    } catch (e) {
      setPhase(isPermissionError(e) ? 'denied' : 'intro')
      if (!isPermissionError(e)) setError(errorText(e))
    }
  }

  async function finish() {
    const rec = recorder.current
    const c = ctx.current
    if (!rec || !c) return
    recorder.current = null
    cancelAnimationFrame(raf.current)
    stopSources()
    monitorNode.current?.disconnect()
    monitorNode.current = null
    releaseWake.current()
    const { startFrame, samples } = await rec.stop()
    // Выравниваем: сэмпл 0 партии = кадр, в который заиграл минус. Сама запись не сдвигается —
    // задержку учитывает offset при сведении (на сервере и в «Послушать вместе»).
    const shift = Math.round(backingAt.current * c.sampleRate) - startFrame
    let aligned: Float32Array
    if (shift >= 0) aligned = samples.slice(shift)
    else {
      aligned = new Float32Array(samples.length - shift)
      aligned.set(samples, -shift)
    }
    if (aligned.length < c.sampleRate) {
      setError('Слишком короткая запись. Сыграй хотя бы пару секунд')
      setPhase('intro')
      return
    }
    // Звук доходит до ушей и обратно в микрофон с задержкой — сдвигаем партию раньше на неё.
    const comp = compensation(c)
    setBase(comp)
    setAdjustState(comp.key ? getAdjust(comp.key) : 0)
    setTrack(aligned)
    setPhase('mix')
  }

  function playMix() {
    const c = ctx.current
    if (!c || !track || !backing.current) return
    stopSources()
    const trackBuf = c.createBuffer(1, track.length, c.sampleRate)
    trackBuf.copyToChannel(track as Float32Array<ArrayBuffer>, 0)
    const at = c.currentTime + 0.1
    const gb = c.createGain()
    gb.gain.value = gainBacking
    const gt = c.createGain()
    gt.gain.value = gainTrack
    const b = c.createBufferSource()
    b.buffer = backing.current
    b.connect(gb).connect(c.destination)
    const t = c.createBufferSource()
    t.buffer = trackBuf
    t.connect(gt).connect(c.destination)
    const dur = trackBuf.duration + 0.5
    b.start(at, startSec, dur)
    const off = offset / 1000
    if (off >= 0) t.start(at + off)
    else t.start(at, -off)
    b.onended = () => setPlaying(false)
    sources.current = [b, t]
    setPlaying(true)
  }

  async function send() {
    const c = ctx.current
    if (!track || !c) return
    stopSources()
    setPhase('uploading')
    setError('')
    setProgress(0)
    try {
      await upload(`/spots/${id}/responses`, {
        offset_ms: String(offset), start_ms: String(Math.round(startSec * 1000)),
        gain_backing: String(gainBacking), gain_track: String(gainTrack),
      }, encodeWav(track, c.sampleRate), 'part.wav', setProgress)
      stream.current?.getTracks().forEach((t) => t.stop())
      navigate(`/tracks/${id}`, { replace: true })
    } catch (e) {
      setError(errorText(e))
      setPhase('mix')
    }
  }

  const peaks = useMemo(() => {
    if (!track || !backing.current || !ctx.current) return null
    const rate = ctx.current.sampleRate
    const from = Math.round(startSec * backing.current.sampleRate)
    const len = Math.round((track.length / rate) * backing.current.sampleRate)
    return {
      backing: computePeaks(backing.current.getChannelData(0).subarray(from, from + len), 200),
      track: computePeaks(track, 200),
    }
  }, [track, startSec])

  if (loadError) return <main className="screen"><Header back /><ErrorState error={loadError} onRetry={() => location.reload()} /></main>
  if (!spot) return <main className="screen"><Header back /><Loading /></main>

  const total = spot.backing_duration_ms / 1000
  const title = `Партия: ${nameOf(catalog.instruments, spot.instrument_id).toLowerCase()}`

  if (!mediaAvailable()) {
    return (
      <main className="screen">
        <Header title={title} back />
        <div className="screen-body"><InsecureHelp /></div>
      </main>
    )
  }

  if (phase === 'denied') {
    return (
      <main className="screen">
        <Header title={title} back />
        <div className="screen-body"><PermissionHelp what="mic" onRetry={() => setPhase('intro')} /></div>
      </main>
    )
  }

  if (phase === 'mix' || phase === 'uploading') {
    return (
      <main className="screen">
        <Header title="Сведение" back={phase === 'mix' ? () => { stopSources(); setPhase('intro') } : undefined} />
        <div className="screen-body">
          <div className="field">
            <span className="label">Минус</span>
            {peaks && <Waveform peaks={peaks.backing} height={48} />}
            <span className="label">Твоя партия</span>
            {peaks && <div style={{ transform: `translateX(${(offset / 1000 / (track!.length / (ctx.current?.sampleRate ?? 48000))) * 100}%)` }}><Waveform peaks={peaks.track} height={48} /></div>}
          </div>
          <section className="field">
            <span className="label">Сдвиг партии: {offset > 0 ? '+' : ''}{offset} мс. Если отстаёшь — подвинь влево</span>
            <span className="small muted">
              Задержка {base.ms.toFixed(1)} мс ({base.label}) {adjust >= 0 ? '+' : '−'} подстройка {Math.abs(adjust)} мс
            </span>
            {Math.abs(base.ms + adjust) > MAX_OFFSET && <span className="small warn-text">Сдвиг больше 300 мс не поддерживается — так бывает с Bluetooth. Возьми проводные наушники.</span>}
            <input type="range" min={-MAX_OFFSET} max={MAX_OFFSET} step={1} value={offset} onChange={(e) => changeAdjust(-Number(e.target.value) - base.ms)} />
            <div className="adjust-row" aria-label="Подстройка на слух">
              {[-5, -1, 1, 5].map((d) => (
                <button key={d} className="btn btn-secondary" onClick={() => changeAdjust(adjust + d)}>{d > 0 ? `+${d}` : `−${-d}`}</button>
              ))}
              <input className="input" type="number" inputMode="numeric" value={adjust} aria-label="Подстройка, мс"
                onChange={(e) => changeAdjust(Number(e.target.value) || 0)} />
              <span className="small muted">мс подстройки{base.key ? ' — запомним' : ''}</span>
            </div>
            <span className="small muted">Плюс — партия раньше, минус — позже.</span>
          </section>
          <label className="field">
            <span className="label">Громкость минуса</span>
            <input type="range" min={0} max={1.5} step={0.05} value={gainBacking} onChange={(e) => setGainBacking(Number(e.target.value))} />
          </label>
          <label className="field">
            <span className="label">Громкость партии</span>
            <input type="range" min={0} max={1.5} step={0.05} value={gainTrack} onChange={(e) => setGainTrack(Number(e.target.value))} />
          </label>
          <button className="btn btn-secondary" disabled={phase === 'uploading'} onClick={playing ? stopSources : playMix}>
            {playing ? '■ Стоп' : '▶ Послушать вместе'}
          </button>
          <p className="small muted">Подвинул ползунки — включи заново, чтобы услышать.</p>
        </div>
        <div className="bottom-actions">
          {error && <p className="error-text" role="alert">{error}</p>}
          {phase === 'uploading' && <div className="progress"><div style={{ width: `${progress * 100}%` }} /></div>}
          <button className="btn btn-primary" disabled={phase === 'uploading'} onClick={send}>
            {phase === 'uploading' ? `Отправляем… ${Math.round(progress * 100)}%` : 'Отправить группе'}
          </button>
          <button className="btn btn-secondary" disabled={phase === 'uploading'} onClick={() => { stopSources(); setTrack(null); setPhase('intro') }}>
            Перезаписать
          </button>
        </div>
      </main>
    )
  }

  if (phase === 'recording' || phase === 'preparing') {
    return (
      <main className="screen">
        <Header title={title} />
        <div className="screen-body center-body">
          {phase === 'preparing' && <Loading />}
          {phase === 'recording' && (
            <>
              <div className="countdown-inline">{countIn > 0 ? countIn : <span className="rec-timer"><span className="rec-dot" /> Запись</span>}</div>
              <Waveform peaks={spot.backing_peaks} progress={(startSec + pos) / total} height={64} />
              <p className="muted">{fmtDuration((startSec + pos) * 1000)} / {fmtDuration(total * 1000)}</p>
              <p className="small muted">Не сворачивай приложение и не блокируй экран.</p>
            </>
          )}
        </div>
        <div className="bottom-actions">
          <button className="rec-btn stop" disabled={phase !== 'recording'} onClick={finish} aria-label="Стоп"><span /></button>
        </div>
      </main>
    )
  }

  return (
    <main className="screen">
      <Header title={title} back />
      <div className="screen-body">
        {phase === 'interrupted' && <p className="note error-text">Запись прервалась: приложение свернулось. Запиши ещё раз.</p>}
        <p className="note">🎧 Надень наушники, лучше проводные: у Bluetooth задержка 150–250 мс, и партия уедет.</p>
        <AudioPlayer src={spot.backing_url} peaks={spot.backing_peaks} durationMs={spot.backing_duration_ms} label="Послушай минус, чтобы подготовиться" />
        <label className="field">
          <span className="label">Начать с {fmtDuration(startSec * 1000)} — можно записать только фрагмент</span>
          <input type="range" min={0} max={Math.max(0, Math.floor(total) - 5)} step={1} value={startSec} onChange={(e) => setStartSec(Number(e.target.value))} />
        </label>
        <p className="small muted">Перед записью прозвучит один такт метронома ({spot.bpm} BPM). Остановить можно в любой момент.</p>
        <section className="card">
          <h3>Задержка звука</h3>
          {avail.length === 0 ? (
            <p className="small">Не откалибрована — возьмём оценку браузера, она обычно неточная. Калибровка займёт минуту.</p>
          ) : (
            <>
              <span className="label">Компенсация</span>
              <div className="chips">
                {avail.map((m) => (
                  <button key={m} className="chip" aria-pressed={method === m} onClick={() => setMethod(m)}>{methodName[m]}</button>
                ))}
              </div>
              {chosen && (
                <p className="small">
                  {chosen.rec.rtlMs.toFixed(1)} мс ±{chosen.rec.spreadMs.toFixed(1)}
                  {chosen.rec.method === 'C' ? ' (эффективное смещение)' : ''}
                  {chosen.rec.stale ? <span className="warn-text"> · устарела</span> : ''}
                  {chosen.rec.reliable ? '' : <span className="warn-text"> · ненадёжно</span>}
                </p>
              )}
            </>
          )}
          {routeWarn && <p className="small warn-text">{routeWarn}</p>}
          <Link className="btn btn-secondary" to="/me/settings/audio">{avail.length ? 'Откалибровать заново' : 'Откалибровать'}</Link>
        </section>
        <label className="toggle-row">
          <span>
            Слышать себя в наушниках
            <span className="muted small block">Только в наушниках: из динамика звук заведёт микрофон</span>
          </span>
          <input type="checkbox" role="switch" className="switch" checked={monitor} onChange={(e) => setMonitor(e.target.checked)} />
        </label>
        {warnings.map((w) => <p key={w} className="small warn-text">{w}</p>)}
      </div>
      <div className="bottom-actions">
        {error && <p className="error-text" role="alert">{error}</p>}
        <button className="btn btn-primary" onClick={record}>Начать запись</button>
      </div>
    </main>
  )
}
