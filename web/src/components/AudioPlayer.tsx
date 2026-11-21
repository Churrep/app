import { useEffect, useRef, useState } from 'react'
import { fmtDuration } from '../types'
import { Waveform } from './Waveform'

// Плеер с волной. Только один плеер на странице играет одновременно.
let current: HTMLAudioElement | null = null

export function AudioPlayer({ src, peaks, durationMs, label }: { src: string; peaks: number[]; durationMs: number; label?: string }) {
  const ref = useRef<HTMLAudioElement>(null)
  const [playing, setPlaying] = useState(false)
  const [pos, setPos] = useState(0)

  useEffect(() => {
    const a = ref.current
    return () => a?.pause()
  }, [])

  function toggle() {
    const a = ref.current
    if (!a) return
    if (a.paused) {
      if (current && current !== a) current.pause()
      current = a
      a.play().catch(() => setPlaying(false))
    } else {
      a.pause()
    }
  }

  const total = durationMs / 1000 || ref.current?.duration || 0
  return (
    <div className="player">
      <button className="play-btn" onClick={toggle} aria-label={playing ? 'Пауза' : 'Слушать'}>
        {playing ? '❚❚' : '▶'}
      </button>
      <div className="player-body">
        {label && <span className="small muted">{label}</span>}
        <Waveform peaks={peaks} progress={total ? pos / total : 0} height={40}
          onSeek={(f) => { if (ref.current && total) ref.current.currentTime = f * total }} />
        <span className="small muted">{fmtDuration(pos * 1000)} / {fmtDuration(total * 1000)}</span>
      </div>
      <audio ref={ref} src={src} preload="none"
        onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)}
        onTimeUpdate={(e) => setPos(e.currentTarget.currentTime)} />
    </div>
  )
}
