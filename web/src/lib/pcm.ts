// Запись микрофона через AudioWorklet в сыром PCM.
// В отличие от MediaRecorder, мы знаем точное время первого сэмпла по часам AudioContext,
// поэтому партию можно выровнять с минусом до миллисекунд (остаётся только задержка железа).

const workletCode = `
class PcmRecorder extends AudioWorkletProcessor {
  constructor() {
    super()
    this.chunks = []
    this.size = 0
    this.start = -1
    this.on = true
    this.port.onmessage = (e) => {
      if (e.data === 'stop') {
        this.flush()
        this.on = false
        this.port.postMessage({ done: true })
      }
    }
  }
  process(inputs) {
    if (!this.on) return false
    const ch = inputs[0] && inputs[0][0]
    if (ch) {
      if (this.start < 0) this.start = currentTime
      this.chunks.push(ch.slice(0))
      this.size += ch.length
      if (this.size >= 16384) this.flush()
    }
    return true
  }
  flush() {
    if (!this.size) return
    const out = new Float32Array(this.size)
    let o = 0
    for (const c of this.chunks) { out.set(c, o); o += c.length }
    this.port.postMessage({ start: this.start, data: out }, [out.buffer])
    this.chunks = []
    this.size = 0
  }
}
registerProcessor('pcm-recorder', PcmRecorder)
`

const loaded = new WeakSet<BaseAudioContext>()

export class PcmRecorder {
  private parts: Float32Array[] = []
  private startTime = -1
  private node: AudioWorkletNode
  private source: MediaStreamAudioSourceNode
  private sink: GainNode
  private done: Promise<void>

  private constructor(ctx: AudioContext, stream: MediaStream) {
    this.source = ctx.createMediaStreamSource(stream)
    this.node = new AudioWorkletNode(ctx, 'pcm-recorder', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit' })
    // Узел должен быть подключён к выходу, иначе браузер его не вызывает. Громкость 0 — в наушники не идёт.
    this.sink = ctx.createGain()
    this.sink.gain.value = 0
    this.source.connect(this.node).connect(this.sink).connect(ctx.destination)
    this.done = new Promise((resolve) => {
      this.node.port.onmessage = (e) => {
        if (e.data.done) return resolve()
        if (this.startTime < 0) this.startTime = e.data.start
        this.parts.push(e.data.data)
      }
    })
  }

  static async create(ctx: AudioContext, stream: MediaStream) {
    if (!loaded.has(ctx)) {
      const url = URL.createObjectURL(new Blob([workletCode], { type: 'application/javascript' }))
      await ctx.audioWorklet.addModule(url)
      URL.revokeObjectURL(url)
      loaded.add(ctx)
    }
    return new PcmRecorder(ctx, stream)
  }

  // Останавливает запись: время первого сэмпла (секунды по часам ctx) и все сэмплы.
  async stop(): Promise<{ startTime: number; samples: Float32Array }> {
    this.node.port.postMessage('stop')
    await this.done
    this.source.disconnect()
    this.node.disconnect()
    this.sink.disconnect()
    const total = this.parts.reduce((n, p) => n + p.length, 0)
    const samples = new Float32Array(total)
    let o = 0
    for (const p of this.parts) {
      samples.set(p, o)
      o += p.length
    }
    return { startTime: this.startTime, samples }
  }
}

// Короткий щелчок метронома.
export function click(ctx: AudioContext, at: number, accent: boolean) {
  const osc = ctx.createOscillator()
  const g = ctx.createGain()
  osc.frequency.value = accent ? 1500 : 1000
  g.gain.setValueAtTime(0.0001, at)
  g.gain.exponentialRampToValueAtTime(0.8, at + 0.002)
  g.gain.exponentialRampToValueAtTime(0.0001, at + 0.05)
  osc.connect(g).connect(ctx.destination)
  osc.start(at)
  osc.stop(at + 0.06)
}

export async function loadBuffer(ctx: AudioContext, url: string) {
  const res = await fetch(url, { credentials: 'same-origin' })
  if (!res.ok) throw new Error('Не получилось загрузить минус')
  return ctx.decodeAudioData(await res.arrayBuffer())
}

// WAV 16 бит, моно — сервер сам перекодирует в AAC.
export function encodeWav(samples: Float32Array, rate: number): Blob {
  const buf = new ArrayBuffer(44 + samples.length * 2)
  const v = new DataView(buf)
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)))
  str(0, 'RIFF')
  v.setUint32(4, 36 + samples.length * 2, true)
  str(8, 'WAVE')
  str(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true)
  v.setUint16(22, 1, true)
  v.setUint32(24, rate, true)
  v.setUint32(28, rate * 2, true)
  v.setUint16(32, 2, true)
  v.setUint16(34, 16, true)
  str(36, 'data')
  v.setUint32(40, samples.length * 2, true)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  return new Blob([buf], { type: 'audio/wav' })
}

// Задержка «звук в наушниках → микрофон», сохранённая калибровкой. Это настройка устройства,
// поэтому хранится в браузере.
export function savedLatencyMs(): number | null {
  try {
    const v = localStorage.getItem('latency_ms')
    return v === null ? null : Number(v)
  } catch {
    return null
  }
}

export function saveLatencyMs(ms: number) {
  try {
    localStorage.setItem('latency_ms', String(Math.round(ms)))
  } catch {
    // приватный режим
  }
}

// Калибровка: 6 щелчков, ищем их в записи микрофона, берём медиану задержки.
export async function calibrate(ctx: AudioContext, stream: MediaStream): Promise<number> {
  const rec = await PcmRecorder.create(ctx, stream)
  const t0 = ctx.currentTime + 0.4
  const times = Array.from({ length: 6 }, (_, i) => t0 + i * 0.5)
  times.forEach((t) => click(ctx, t, true))
  await new Promise((r) => setTimeout(r, (times[5] - ctx.currentTime + 0.6) * 1000))
  const { startTime, samples } = await rec.stop()
  const rate = ctx.sampleRate
  const delays: number[] = []
  for (const t of times) {
    const from = Math.max(0, Math.round((t - startTime) * rate))
    const to = Math.min(samples.length, from + Math.round(0.4 * rate))
    let max = 0
    for (let i = from; i < to; i++) max = Math.max(max, Math.abs(samples[i]))
    if (max < 0.02) continue
    for (let i = from; i < to; i++) {
      if (Math.abs(samples[i]) > max * 0.5) {
        delays.push(((i - from) / rate) * 1000)
        break
      }
    }
  }
  if (delays.length < 3) throw new Error('Не услышали щелчки. Поднеси наушник к микрофону или включи динамик погромче')
  delays.sort((a, b) => a - b)
  return delays[Math.floor(delays.length / 2)]
}
