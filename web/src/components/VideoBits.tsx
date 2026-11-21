import { useEffect, useRef, useState } from 'react'
import { api, errorText } from '../api'
import type { Catalog, Video } from '../types'
import { nameOf } from '../types'
import { Waveform } from './Waveform'

// Обложка для записи «только звук»: волна на цветном фоне, инструмент, имя.
export function AudioCover({ peaks, name, instrument, compact }: { peaks: number[]; name: string; instrument: string; compact?: boolean }) {
  const hue = [...name].reduce((h, c) => (h + c.charCodeAt(0) * 7) % 360, 0)
  return (
    <div className={compact ? 'audio-cover compact' : 'audio-cover'} style={{ background: `linear-gradient(160deg, hsl(${hue} 55% 32%), hsl(${(hue + 40) % 360} 60% 18%))` }}>
      {!compact && <span className="audio-cover-title">{instrument}</span>}
      <Waveform peaks={peaks} height={compact ? 36 : 96} muted />
      {!compact && <span className="audio-cover-name">{name}</span>}
    </div>
  )
}

export const liveTake = (iso: string) =>
  'живой дубль · ' + new Date(iso).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

export function VideoGrid({ items, name, instrument, onOpen }: { items: Video[]; name: string; instrument: string; onOpen: (v: Video) => void }) {
  return (
    <div className="video-grid">
      {items.map((v) => (
        <button key={v.id} className="video-thumb" onClick={() => onOpen(v)} aria-label={v.caption || 'Запись'}>
          {v.status === 'ready' && v.type === 'video' && <img src={v.poster_url} alt="" loading="lazy" />}
          {v.status === 'ready' && v.type === 'audio' && <AudioCover peaks={v.peaks} name={name} instrument={instrument} compact />}
          {v.status === 'processing' && <span className="thumb-state">Обрабатываем…</span>}
          {v.status === 'failed' && <span className="thumb-state error-text">Ошибка</span>}
          {v.is_pinned && <span className="thumb-badge">Визитка</span>}
        </button>
      ))}
    </div>
  )
}

// Просмотр своей записи: сделать визиткой, поменять подпись, удалить. Чужие записи листаются лентой (UserFeed).
export function VideoModal({ video, name, instrument, onClose, onChanged }: {
  video: Video
  name: string
  instrument: string
  onClose: () => void
  onChanged: () => void
}) {
  const [caption, setCaption] = useState(video.caption)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const media = useRef<HTMLMediaElement | null>(null)

  useEffect(() => () => media.current?.pause(), [])

  async function act(fn: () => Promise<unknown>) {
    setBusy(true)
    setError('')
    try {
      await fn()
      onChanged()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal" role="dialog" aria-modal="true">
      <div className="modal-head">
        <button className="icon-btn light" onClick={onClose} aria-label="Закрыть">✕</button>
      </div>
      <div className="modal-body">
        {video.status === 'ready' && video.type === 'video' && (
          <video ref={(el) => { media.current = el }} className="modal-video" src={video.media_url} poster={video.poster_url} controls playsInline autoPlay />
        )}
        {video.status === 'ready' && video.type === 'audio' && (
          <>
            <AudioCover peaks={video.peaks} name={name} instrument={instrument} />
            <audio ref={(el) => { media.current = el }} src={video.media_url} controls autoPlay className="review-audio" />
          </>
        )}
        {video.status === 'processing' && <p className="note">Обрабатываем запись. Обычно это занимает до двух минут.</p>}
        {video.status === 'failed' && <p className="note error-text">{video.error || 'Не получилось обработать запись'}</p>}
        {video.status === 'ready' && <p className="small muted">{liveTake(video.recorded_at)}</p>}

        <div className="stack">
            {video.status === 'ready' && (
              <>
                <label className="field">
                  <span className="label">Подпись</span>
                  <input className="input" value={caption} maxLength={100} onChange={(e) => setCaption(e.target.value)} />
                </label>
                {caption !== video.caption && (
                  <button className="btn btn-secondary" disabled={busy}
                    onClick={() => act(() => api(`/videos/${video.id}`, { method: 'PATCH', body: { caption } }))}>Сохранить подпись</button>
                )}
                <button className="btn btn-secondary" disabled={busy}
                  onClick={() => act(() => api(`/videos/${video.id}`, { method: 'PATCH', body: { is_pinned: !video.is_pinned } }))}>
                  {video.is_pinned ? 'Убрать из визитки' : 'Сделать видео-визиткой'}
                </button>
              </>
            )}
            <button className="btn btn-ghost danger" disabled={busy}
              onClick={() => confirm('Удалить запись?') && act(async () => { await api(`/videos/${video.id}`, { method: 'DELETE' }); onClose() })}>
              Удалить
            </button>
            {error && <p className="error-text" role="alert">{error}</p>}
        </div>
      </div>
    </div>
  )
}

// Свои/чужие записи с автообновлением, пока что-то обрабатывается.
export function useVideos(path: string) {
  const [items, setItems] = useState<Video[] | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    let alive = true
    api<{ items: Video[] }>(path)
      .then((r) => alive && (setItems(r.items), setError(null)))
      .catch((e) => alive && setError(e))
    return () => {
      alive = false
    }
  }, [path, tick])

  const processing = items?.some((v) => v.status === 'processing')
  useEffect(() => {
    if (!processing) return
    const t = setTimeout(() => setTick((n) => n + 1), 4000)
    return () => clearTimeout(t)
  }, [processing, items])

  return { items, error, reload: () => setTick((n) => n + 1) }
}

export const instrumentName = (catalog: Catalog, id: string) => nameOf(catalog.instruments, id).toLowerCase()
