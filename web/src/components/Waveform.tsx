import { useEffect, useRef } from 'react'

// Волна звука по пикам 0..1. progress — доля проигранного, onSeek — перемотка тапом.
export function Waveform({ peaks, progress = 0, height = 56, onSeek, muted }: {
  peaks: number[]
  progress?: number
  height?: number
  onSeek?: (fraction: number) => void
  muted?: boolean
}) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const draw = () => {
      const dpr = window.devicePixelRatio || 1
      const w = canvas.clientWidth
      canvas.width = w * dpr
      canvas.height = height * dpr
      const g = canvas.getContext('2d')!
      g.scale(dpr, dpr)
      const css = getComputedStyle(canvas)
      const played = css.getPropertyValue('--accent').trim() || '#ff6b3d'
      const rest = css.getPropertyValue('--line').trim() || '#444'
      const bar = 3
      const gap = 2
      const n = Math.max(1, Math.floor(w / (bar + gap)))
      for (let i = 0; i < n; i++) {
        const p = peaks.length ? peaks[Math.floor((i / n) * peaks.length)] ?? 0 : 0
        const h = Math.max(2, p * (height - 4))
        g.fillStyle = !muted && i / n < progress ? played : rest
        g.fillRect(i * (bar + gap), (height - h) / 2, bar, h)
      }
    }
    draw()
    const ro = new ResizeObserver(draw)
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [peaks, progress, height, muted])

  return (
    <canvas
      ref={ref}
      className="waveform"
      style={{ height, cursor: onSeek ? 'pointer' : undefined }}
      onClick={(e) => {
        if (!onSeek) return
        const r = e.currentTarget.getBoundingClientRect()
        onSeek(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)))
      }}
      aria-hidden
    />
  )
}

export function computePeaks(data: Float32Array, bins: number): number[] {
  const out = new Array(bins).fill(0)
  if (!data.length) return out
  let max = 0
  for (let i = 0; i < data.length; i++) {
    const b = Math.floor((i / data.length) * bins)
    const v = Math.abs(data[i])
    if (v > out[b]) out[b] = v
    if (v > max) max = v
  }
  return max ? out.map((v) => v / max) : out
}
