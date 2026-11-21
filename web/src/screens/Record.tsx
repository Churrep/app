import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { errorText, upload } from '../api'
import { Header } from '../components/Header'
import { InsecureHelp, isPermissionError, mediaAvailable, musicAudio, PermissionHelp } from '../components/MediaHelp'
import { type Camera, cameraPref, type Facing, fmtZoom, listCameras, saveCameraPref, setupZoom, setZoom, videoConstraints, type Zoom, zoomStops } from '../lib/camera'
import { useMe } from '../session'
import type { Video } from '../types'

type Mode = 'video' | 'audio'
type Phase = 'setup' | 'countdown' | 'recording' | 'review' | 'uploading' | 'interrupted' | 'denied' | 'error'

// iPhone пишет в MP4, Android — в WebM. Берём первый поддерживаемый, сервер приведёт к одному формату.
function pickMime(mode: Mode) {
  const list = mode === 'video'
    ? ['video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
    : ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm']
  return list.find((m) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) ?? ''
}

const extOf = (mime: string) => (mime.includes('mp4') ? (mime.startsWith('audio') ? '.m4a' : '.mp4') : '.webm')

// openCamera — камера (сохранённый объектив, если он ещё есть) и микрофон.
async function openCamera(facing: Facing) {
  const { deviceId } = cameraPref(facing)
  try {
    return await navigator.mediaDevices.getUserMedia({ video: videoConstraints(facing, deviceId), audio: musicAudio })
  } catch (e) {
    if (!deviceId || !(e instanceof DOMException) || (e.name !== 'OverconstrainedError' && e.name !== 'NotFoundError')) throw e
    saveCameraPref(facing, { deviceId: undefined, zoom: undefined }) // объектива больше нет — берём обычный
    return navigator.mediaDevices.getUserMedia({ video: videoConstraints(facing), audio: musicAudio })
  }
}

export function Record() {
  const { catalog } = useMe()
  const navigate = useNavigate()
  const [mode, setMode] = useState<Mode>('video')
  const [facing, setFacing] = useState<Facing>('user')
  const [tag, setTag] = useState('own')
  const [phase, setPhase] = useState<Phase>('setup')
  const [count, setCount] = useState(3)
  const [elapsed, setElapsed] = useState(0)
  const [blob, setBlob] = useState<Blob | null>(null)
  const [caption, setCaption] = useState('')
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState('')
  const [ready, setReady] = useState(false)
  const [cameras, setCameras] = useState<Camera[]>([])
  const [cameraId, setCameraId] = useState('')
  const [zoom, setZoomState] = useState<Zoom | null>(null)

  const preview = useRef<HTMLVideoElement>(null)
  const previewBg = useRef<HTMLVideoElement>(null)
  const stream = useRef<MediaStream | null>(null)
  const recorder = useRef<MediaRecorder | null>(null)
  const chunks = useRef<Blob[]>([])
  const discard = useRef(false)
  const startedAt = useRef(0)
  const recordedAt = useRef('')
  const wakeLock = useRef<{ release: () => Promise<void> } | null>(null)

  const limit = tag === 'cover' ? 30 : 60

  const stopStream = () => {
    stream.current?.getTracks().forEach((t) => t.stop())
    stream.current = null
    setReady(false)
  }

  const openStream = useCallback(async () => {
    stopStream()
    setError('')
    setZoomState(null)
    if (!mediaAvailable()) return
    try {
      let s: MediaStream
      if (mode === 'video') {
        s = await openCamera(facing)
        // Сзади есть отдельная сверхширокая камера, а зумом шире не сделать — по умолчанию берём её.
        const pref = cameraPref(facing)
        const cams = await listCameras(facing).catch(() => [])
        const track = s.getVideoTracks()[0]
        const current = track?.getSettings().deviceId ?? ''
        const caps = (track?.getCapabilities?.() as { zoom?: { min: number } } | undefined)?.zoom
        const ultra = cams.find((c) => c.ultra)
        if (facing === 'environment' && !pref.deviceId && ultra && ultra.id !== current && !(caps && caps.min < 1)) {
          s.getTracks().forEach((t) => t.stop())
          saveCameraPref(facing, { deviceId: ultra.id })
          s = await openCamera(facing)
        }
        const t = s.getVideoTracks()[0]
        setCameras(cams)
        setCameraId(t?.getSettings().deviceId ?? '')
        if (t) setZoomState(await setupZoom(t, cameraPref(facing).zoom))
      } else {
        s = await navigator.mediaDevices.getUserMedia({ audio: musicAudio })
      }
      stream.current = s
      for (const v of [preview.current, previewBg.current]) if (v) v.srcObject = mode === 'video' ? s : null
      setReady(true)
      setPhase('setup')
    } catch (e) {
      setPhase(isPermissionError(e) ? 'denied' : 'error')
      setError(isPermissionError(e) ? '' : 'Не получилось включить камеру или микрофон')
    }
  }, [mode, facing])

  function switchCamera() {
    if (cameras.length < 2) return
    const i = cameras.findIndex((c) => c.id === cameraId)
    const next = cameras[(i + 1) % cameras.length]
    saveCameraPref(facing, { deviceId: next.id, zoom: undefined })
    openStream()
  }

  async function changeZoom(v: number) {
    const t = stream.current?.getVideoTracks()[0]
    if (!t || !zoom) return
    try {
      await setZoom(t, v)
      setZoomState({ ...zoom, value: v })
      saveCameraPref(facing, { zoom: v })
    } catch {
      // камера передумала — оставляем как есть
    }
  }

  useEffect(() => {
    if (phase === 'setup' || phase === 'denied' || phase === 'error') openStream()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, facing])

  useEffect(() => () => stopStream(), [])

  // Свернули приложение или заблокировали экран — запись на iPhone прерывается. Выбрасываем дубль.
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden' && (phase === 'recording' || phase === 'countdown')) {
        discard.current = true
        recorder.current?.state === 'recording' && recorder.current.stop()
        setPhase('interrupted')
      }
    }
    document.addEventListener('visibilitychange', onHide)
    return () => document.removeEventListener('visibilitychange', onHide)
  }, [phase])

  // Отсчёт 3-2-1.
  useEffect(() => {
    if (phase !== 'countdown') return
    if (count === 0) {
      begin()
      return
    }
    const t = setTimeout(() => setCount(count - 1), 1000)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, count])

  // Таймер и автостоп по лимиту.
  useEffect(() => {
    if (phase !== 'recording') return
    const t = setInterval(() => {
      const s = (Date.now() - startedAt.current) / 1000
      setElapsed(s)
      if (s >= limit) stop()
    }, 200)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, limit])

  function start() {
    if (!stream.current) return
    setCount(3)
    setElapsed(0)
    setPhase('countdown')
  }

  async function begin() {
    const s = stream.current
    if (!s) return
    const mime = pickMime(mode)
    // Кадр теперь без обрезки и может быть крупнее — ограничиваем битрейт, чтобы минута весила ~45 МБ.
    const rec = new MediaRecorder(s, { ...(mime ? { mimeType: mime } : {}), ...(mode === 'video' ? { videoBitsPerSecond: 6_000_000 } : {}) })
    chunks.current = []
    discard.current = false
    rec.ondataavailable = (e) => e.data.size && chunks.current.push(e.data)
    rec.onstop = () => {
      wakeLock.current?.release().catch(() => {})
      wakeLock.current = null
      if (discard.current) return
      setBlob(new Blob(chunks.current, { type: rec.mimeType || mime }))
      setPhase('review')
    }
    recorder.current = rec
    try {
      wakeLock.current = await (navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> } })
        .wakeLock?.request('screen') ?? null
    } catch {
      // не поддерживается — просто просим не блокировать экран
    }
    recordedAt.current = new Date().toISOString()
    startedAt.current = Date.now()
    rec.start(1000)
    setPhase('recording')
  }

  function stop() {
    if (recorder.current?.state === 'recording') recorder.current.stop()
  }

  function retake() {
    setBlob(null)
    setCaption('')
    setError('')
    openStream()
  }

  async function publish() {
    if (!blob) return
    setPhase('uploading')
    setError('')
    setProgress(0)
    try {
      await upload<Video>('/videos', { type: mode, tag, caption: caption.trim(), recorded_at: recordedAt.current }, blob, 'take' + extOf(blob.type), setProgress)
      stopStream()
      navigate('/me', { replace: true, state: { uploaded: true } })
    } catch (e) {
      setError(errorText(e))
      setPhase('review')
    }
  }

  const blobUrl = useObjectUrl(blob)

  if (!mediaAvailable()) {
    return (
      <main className="screen">
        <Header title="Запись" back />
        <div className="screen-body"><InsecureHelp /></div>
      </main>
    )
  }

  if (phase === 'denied') {
    return (
      <main className="screen">
        <Header title="Запись" back />
        <div className="screen-body"><PermissionHelp what={mode === 'video' ? 'camera' : 'mic'} onRetry={openStream} /></div>
      </main>
    )
  }

  if (phase === 'review' || phase === 'uploading') {
    return (
      <main className="screen">
        <Header title="Дубль" back={phase === 'review' ? retake : undefined} />
        <div className="screen-body">
          {blobUrl && (mode === 'video'
            ? <video className="review-video" src={blobUrl} controls playsInline />
            : <audio src={blobUrl} controls className="review-audio" />)}
          <label className="field">
            <span className="label">Подпись, до 100 символов</span>
            <input className="input" value={caption} maxLength={100} onChange={(e) => setCaption(e.target.value)} placeholder="Например, разминка перед репой" />
          </label>
          <p className="muted small">Тег: {catalog.video_tags.find((t) => t.id === tag)?.name}</p>
        </div>
        <div className="bottom-actions">
          {error && <p className="error-text" role="alert">{error}</p>}
          {phase === 'uploading' && <div className="progress" aria-label="Загрузка"><div style={{ width: `${progress * 100}%` }} /></div>}
          <button className="btn btn-primary" disabled={phase === 'uploading'} onClick={publish}>
            {phase === 'uploading' ? `Загружаем… ${Math.round(progress * 100)}%` : 'Опубликовать'}
          </button>
          <button className="btn btn-secondary" disabled={phase === 'uploading'} onClick={retake}>Ещё дубль</button>
        </div>
      </main>
    )
  }

  const busy = phase === 'countdown' || phase === 'recording'
  return (
    <main className="record">
      {mode === 'video' ? (
        // Кадр показываем целиком, а по краям — размытый он же: так же сервер собирает видео для ленты.
        <>
          <video ref={previewBg} className={'record-preview-bg' + (facing === 'user' ? ' mirror' : '')} autoPlay muted playsInline aria-hidden />
          <video ref={preview} className={facing === 'user' ? 'record-preview mirror' : 'record-preview'} autoPlay muted playsInline />
        </>
      ) : (
        <div className="record-preview record-audio"><div className={busy ? 'mic-pulse on' : 'mic-pulse'}>🎙</div></div>
      )}

      <div className="record-top">
        {!busy && <button className="icon-btn light" onClick={() => { stopStream(); navigate(-1) }} aria-label="Закрыть">✕</button>}
        {busy && <span className="rec-timer"><span className="rec-dot" /> {Math.floor(elapsed)} / {limit} с</span>}
        {!busy && mode === 'video' && (
          <span className="record-top-right">
            {cameras.length > 1 && (
              <button className="chip camera-chip" onClick={switchCamera} aria-label="Другой объектив">
                {cameras.find((c) => c.id === cameraId)?.ultra ? 'Широкий' : 'Объектив'} ⇄
              </button>
            )}
            <button className="icon-btn light" onClick={() => setFacing(facing === 'user' ? 'environment' : 'user')} aria-label="Сменить камеру">⟲</button>
          </span>
        )}
      </div>

      {phase === 'countdown' && <div className="countdown">{count}</div>}

      {phase === 'interrupted' && (
        <div className="record-panel">
          <h2>Запись прервалась</h2>
          <p className="muted">Приложение свернулось или экран заблокировался. Попробуй ещё раз.</p>
          <button className="btn btn-primary" onClick={retake}>Записать заново</button>
        </div>
      )}

      {phase === 'error' && (
        <div className="record-panel">
          <p className="error-text">{error}</p>
          <button className="btn btn-primary" onClick={openStream}>Попробовать ещё раз</button>
        </div>
      )}

      {phase === 'setup' && (
        <div className="record-panel">
          {mode === 'video' && zoom && zoomStops(zoom).length > 1 && (
            <div className="chips" role="radiogroup" aria-label="Зум">
              {zoomStops(zoom).map((v) => (
                <button key={v} className="chip" role="radio" aria-checked={Math.abs(zoom.value - v) < 0.01} aria-pressed={Math.abs(zoom.value - v) < 0.01} onClick={() => changeZoom(v)}>
                  {fmtZoom(v)}
                </button>
              ))}
            </div>
          )}
          <div className="segmented" role="radiogroup">
            <button role="radio" aria-checked={mode === 'video'} onClick={() => setMode('video')}>Видео</button>
            <button role="radio" aria-checked={mode === 'audio'} onClick={() => setMode('audio')}>Только звук</button>
          </div>
          <div className="chips">
            {catalog.video_tags.map((t) => (
              <button key={t.id} className="chip" aria-pressed={tag === t.id} onClick={() => setTag(t.id)}>{t.name}</button>
            ))}
          </div>
          {tag === 'cover' && <p className="small warn-text">Кавер — до 30 секунд. Может быть удалён по запросу правообладателя.</p>}
          <p className="small muted">Не сворачивай приложение и не блокируй экран во время записи.</p>
          <button className="rec-btn" onClick={start} disabled={!ready} aria-label={ready ? 'Начать запись' : 'Включаем камеру'}><span /></button>
        </div>
      )}

      {phase === 'recording' && (
        <div className="record-panel">
          <button className="rec-btn stop" onClick={stop} aria-label="Стоп"><span /></button>
        </div>
      )}
    </main>
  )
}

function useObjectUrl(blob: Blob | null) {
  const [url, setUrl] = useState('')
  useEffect(() => {
    if (!blob) return setUrl('')
    const u = URL.createObjectURL(blob)
    setUrl(u)
    return () => URL.revokeObjectURL(u)
  }, [blob])
  return url
}
