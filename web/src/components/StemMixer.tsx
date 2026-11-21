import { useEffect, useRef, useState } from 'react'
import { errorText } from '../api'
import { loadBuffer } from '../lib/pcm'
import { fmtDuration } from '../types'
import { takeOver } from './AudioPlayer'
import { Waveform } from './Waveform'

export type MixerTrack = { id: string; label: string; url: string; peaks: number[]; durationMs: number }

// Микшер дорожек: выбранные дорожки играют одновременно и синхронно (Web Audio, общий старт).
// Дорожку можно включать и выключать на ходу: она остаётся в воспроизведении, меняется только громкость.
export function StemMixer({ tracks, initial }: { tracks: MixerTrack[]; initial: string[] }) {
  const [enabled, setEnabled] = useState<Set<string>>(() => new Set(initial))
  const [playing, setPlaying] = useState(false)
  const [loading, setLoading] = useState(false)
  const [pos, setPos] = useState(0) // секунды
  const [error, setError] = useState('')

  const ctx = useRef<AudioContext | null>(null)
  const buffers = useRef(new Map<string, AudioBuffer>())
  const gains = useRef(new Map<string, GainNode>())
  const sources = useRef<AudioBufferSourceNode[]>([])
  const startedAt = useRef(0) // время контекста, соответствующее началу песни
  const offset = useRef(0) // где стоим на паузе
  const raf = useRef(0)
  const enabledRef = useRef(enabled)
  enabledRef.current = enabled
  const self = useRef({ pause: () => {} })

  const total = Math.max(0, ...tracks.map((t) => (t.durationMs / 1000) || buffers.current.get(t.id)?.duration || 0))

  useEffect(() => () => {
    cancelAnimationFrame(raf.current)
    stopSources()
    ctx.current?.close()
  }, [])

  function stopSources() {
    for (const s of sources.current) {
      s.onended = null
      try {
        s.stop()
      } catch {
        // уже остановлен
      }
    }
    sources.current = []
  }

  function currentPos() {
    return ctx.current && sources.current.length ? ctx.current.currentTime - startedAt.current : offset.current
  }

  function pause() {
    offset.current = Math.min(currentPos(), total)
    cancelAnimationFrame(raf.current)
    stopSources()
    setPlaying(false)
  }
  self.current.pause = pause

  // AudioContext — только по нажатию (требование iPhone). Загружаем все дорожки сразу, чтобы включать их на ходу.
  async function ensureLoaded() {
    if (!ctx.current) ctx.current = new AudioContext()
    await ctx.current.resume()
    const c = ctx.current
    const missing = tracks.filter((t) => !buffers.current.has(t.id))
    if (missing.length) {
      setLoading(true)
      try {
        const loaded = await Promise.all(missing.map((t) => loadBuffer(c, t.url)))
        missing.forEach((t, i) => buffers.current.set(t.id, loaded[i]))
      } finally {
        setLoading(false)
      }
    }
    for (const t of tracks) {
      if (!gains.current.has(t.id)) {
        const g = c.createGain()
        g.connect(c.destination)
        gains.current.set(t.id, g)
      }
    }
    return c
  }

  async function play(from: number) {
    setError('')
    try {
      const c = await ensureLoaded()
      stopSources()
      takeOver(self.current)
      const t0 = c.currentTime + 0.05
      const end = Math.max(...tracks.map((t) => buffers.current.get(t.id)!.duration))
      if (from >= end - 0.05) from = 0
      for (const t of tracks) {
        const buf = buffers.current.get(t.id)!
        const g = gains.current.get(t.id)!
        g.gain.cancelScheduledValues(c.currentTime)
        g.gain.setValueAtTime(enabledRef.current.has(t.id) ? 1 : 0, c.currentTime)
        if (from >= buf.duration) continue
        const src = c.createBufferSource()
        src.buffer = buf
        src.connect(g)
        src.start(t0, from)
        sources.current.push(src)
      }
      startedAt.current = t0 - from
      setPlaying(true)
      const tick = () => {
        const p = c.currentTime - startedAt.current
        if (p >= end) {
          stopSources()
          offset.current = 0
          setPos(0)
          setPlaying(false)
          return
        }
        setPos(Math.max(0, p))
        raf.current = requestAnimationFrame(tick)
      }
      cancelAnimationFrame(raf.current)
      raf.current = requestAnimationFrame(tick)
    } catch (e) {
      setError(errorText(e))
      setPlaying(false)
    }
  }

  function toggle(id: string) {
    const next = new Set(enabled)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setEnabled(next)
    const g = gains.current.get(id)
    if (g && ctx.current) g.gain.setTargetAtTime(next.has(id) ? 1 : 0, ctx.current.currentTime, 0.015)
  }

  function seek(seconds: number) {
    const s = Math.max(0, Math.min(seconds, total))
    offset.current = s
    setPos(s)
    if (playing) play(s)
  }

  return (
    <div className="mixer">
      <div className="mixer-head">
        <button className="play-btn" onClick={() => (playing ? pause() : play(offset.current))}
          disabled={loading || enabled.size === 0} aria-label={playing ? 'Пауза' : 'Слушать выбранные дорожки'}>
          {loading ? '…' : playing ? '❚❚' : '▶'}
        </button>
        <div className="player-body">
          <span className="small muted">
            {loading ? 'Загружаем дорожки…' : enabled.size === 0 ? 'Выбери хотя бы одну дорожку' : `Играют вместе: ${enabled.size}`}
          </span>
          <span className="small muted">{fmtDuration(pos * 1000)} / {fmtDuration(total * 1000)}</span>
        </div>
      </div>
      {tracks.map((t) => {
        const on = enabled.has(t.id)
        const dur = t.durationMs / 1000 || buffers.current.get(t.id)?.duration || total
        return (
          <div key={t.id} className={'mixer-track' + (on ? '' : ' off')}>
            <button className="chip mixer-toggle" aria-pressed={on} onClick={() => toggle(t.id)}>
              {on ? '✓ ' : ''}{t.label}
            </button>
            <Waveform peaks={t.peaks} height={28} muted={!on} progress={dur ? Math.min(1, pos / dur) : 0} onSeek={(f) => seek(f * dur)} />
          </div>
        )
      })}
      {error && <p className="error-text">{error}</p>}
    </div>
  )
}
