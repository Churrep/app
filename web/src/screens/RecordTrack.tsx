import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { api, errorText, upload } from '../api'
import { AudioPlayer } from '../components/AudioPlayer'
import { Header } from '../components/Header'
import { InsecureHelp, isPermissionError, mediaAvailable, musicAudio, PermissionHelp } from '../components/MediaHelp'
import { ErrorState, Loading } from '../components/States'
import { computePeaks, Waveform } from '../components/Waveform'
import { calibrate, click, encodeWav, loadBuffer, PcmRecorder, saveLatencyMs, savedLatencyMs } from '../lib/pcm'
import { useMe } from '../session'
import type { Spot } from '../types'
import { fmtDuration, nameOf } from '../types'

type Phase = 'intro' | 'preparing' | 'recording' | 'mix' | 'uploading' | 'interrupted' | 'denied'

const clampOffset = (ms: number) => Math.max(-300, Math.min(300, Math.round(ms / 5) * 5))

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
  const [offset, setOffset] = useState(0)
  const [gainBacking, setGainBacking] = useState(1)
  const [gainTrack, setGainTrack] = useState(1)
  const [playing, setPlaying] = useState(false)
  const [progress, setProgress] = useState(0)
  const [latency, setLatency] = useState<number | null>(savedLatencyMs)
  const [calibrating, setCalibrating] = useState(false)

  const ctx = useRef<AudioContext | null>(null)
  const backing = useRef<AudioBuffer | null>(null)
  const stream = useRef<MediaStream | null>(null)
  const recorder = useRef<PcmRecorder | null>(null)
  const sources = useRef<AudioScheduledSourceNode[]>([])
  const backingAt = useRef(0)
  const raf = useRef(0)

  useEffect(() => {
    api<Spot>(`/spots/${encodeURIComponent(id)}`).then(setSpot).catch(setLoadError)
  }, [id])

  useEffect(() => () => {
    cancelAnimationFrame(raf.current)
    stopSources()
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

  // AudioContext и микрофон — только по нажатию (требование iPhone).
  async function prepare() {
    if (!ctx.current) ctx.current = new AudioContext({ latencyHint: 'interactive' })
    await ctx.current.resume()
    if (!backing.current) backing.current = await loadBuffer(ctx.current, spot!.backing_url)
    if (!stream.current) stream.current = await navigator.mediaDevices.getUserMedia({ audio: musicAudio })
    return ctx.current
  }

  async function runCalibration() {
    setCalibrating(true)
    setError('')
    try {
      const c = await prepare()
      const ms = await calibrate(c, stream.current!)
      saveLatencyMs(ms)
      setLatency(Math.round(ms))
    } catch (e) {
      if (isPermissionError(e)) setPhase('denied')
      else setError(errorText(e))
    } finally {
      setCalibrating(false)
    }
  }

  async function record() {
    if (!spot) return
    setError('')
    setPhase('preparing')
    try {
      const c = await prepare()
      const rec = await PcmRecorder.create(c, stream.current!)
      recorder.current = rec

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
    const { startTime, samples } = await rec.stop()
    // Выравниваем: сэмпл 0 партии = момент, когда заиграл минус.
    const shift = Math.round((backingAt.current - startTime) * c.sampleRate)
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
    // Звук доходит до ушей и обратно в микрофон с задержкой — по умолчанию сдвигаем партию раньше.
    const estimate = latency ?? ((c.outputLatency || 0) + c.baseLatency) * 1000 + 10
    setOffset(clampOffset(-estimate))
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
          <label className="field">
            <span className="label">Сдвиг: {offset > 0 ? '+' : ''}{offset} мс. Если отстаёшь — подвинь влево</span>
            <input type="range" min={-300} max={300} step={5} value={offset} onChange={(e) => setOffset(Number(e.target.value))} />
          </label>
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
          <p className="small">{latency === null ? 'Не настроена. Калибровка поможет точнее совпасть с минусом.' : `Сейчас ${latency} мс — подставим её в сдвиг.`}</p>
          <p className="small muted">Для калибровки поднеси наушник к микрофону телефона: прозвучат 6 щелчков.</p>
          <button className="btn btn-secondary" disabled={calibrating} onClick={runCalibration}>{calibrating ? 'Слушаем…' : 'Откалибровать'}</button>
        </section>
      </div>
      <div className="bottom-actions">
        {error && <p className="error-text" role="alert">{error}</p>}
        <button className="btn btn-primary" onClick={record}>Начать запись</button>
      </div>
    </main>
  )
}
