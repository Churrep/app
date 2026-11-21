// Запись микрофона через AudioWorklet в сыром PCM.
// В отличие от MediaRecorder, мы знаем номер кадра каждого сэмпла по часам AudioContext,
// поэтому партию можно выровнять с минусом до сэмпла (остаётся только задержка железа — её меряет калибровка).

// Ворклет копирует блоки по 128 сэмплов в чанк и отправляет чанк в главный поток (ArrayBuffer передаётся,
// а не копируется). У каждого чанка — currentFrame его первого сэмпла: так запись связана с часами
// воспроизведения, даже если браузер пропустил блоки (пропуск заполняется тишиной).
const workletCode = `
class PcmRecorder extends AudioWorkletProcessor {
  constructor(options) {
    super()
    this.limit = (options.processorOptions && options.processorOptions.chunk) || 4096
    this.buf = new Float32Array(this.limit)
    this.size = 0
    this.startFrame = -1
    this.framesCaptured = 0
    this.on = true
    this.port.onmessage = (e) => {
      if (e.data === 'stop') {
        this.flush()
        this.on = false
        this.port.postMessage({ done: true, framesCaptured: this.framesCaptured })
      }
    }
  }
  process(inputs) {
    if (!this.on) return false
    const ch = inputs[0] && inputs[0][0]
    if (ch) {
      // Блок не продолжает текущий чанк — отправляем чанк, новый начнётся с этого кадра.
      if (this.size && this.startFrame + this.size !== currentFrame) this.flush()
      if (!this.size) this.startFrame = currentFrame
      if (this.size + ch.length > this.limit) {
        this.flush()
        this.startFrame = currentFrame
      }
      this.buf.set(ch, this.size)
      this.size += ch.length
      this.framesCaptured += ch.length
      if (this.size >= this.limit) this.flush()
    }
    return true
  }
  flush() {
    if (!this.size) return
    const out = this.buf.slice(0, this.size)
    this.port.postMessage({ startFrame: this.startFrame, data: out }, [out.buffer])
    this.size = 0
  }
}
registerProcessor('pcm-recorder', PcmRecorder)
`

const loaded = new WeakSet<BaseAudioContext>()

type Chunk = { startFrame: number; data: Float32Array }

export class PcmRecorder {
  private chunks: Chunk[] = []
  private node: AudioWorkletNode
  private source: MediaStreamAudioSourceNode
  private sink: GainNode
  private done: Promise<void>
  private firstChunk: Promise<void>
  private rate: number

  private constructor(ctx: AudioContext, stream: MediaStream) {
    this.rate = ctx.sampleRate
    this.source = ctx.createMediaStreamSource(stream)
    this.node = new AudioWorkletNode(ctx, 'pcm-recorder', {
      numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit',
      processorOptions: { chunk: 4096 },
    })
    // Узел должен быть подключён к выходу, иначе браузер его не вызывает. Громкость 0 — в наушники не идёт.
    this.sink = ctx.createGain()
    this.sink.gain.value = 0
    this.source.connect(this.node).connect(this.sink).connect(ctx.destination)
    let gotFirst = () => {}
    this.firstChunk = new Promise((r) => (gotFirst = r))
    this.done = new Promise((resolve) => {
      this.node.port.onmessage = (e) => {
        if (e.data.done) return resolve()
        this.chunks.push({ startFrame: e.data.startFrame, data: e.data.data })
        gotFirst()
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

  // started — пришли первые сэмплы с микрофона (вход реально пишется).
  started(timeoutMs = 3000) {
    return Promise.race([
      this.firstChunk,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Микрофон не присылает звук. Проверь, что он не занят другим приложением')), timeoutMs)),
    ])
  }

  // Останавливает запись: номер кадра первого сэмпла, его время (секунды по часам ctx) и все сэмплы.
  // Чанки раскладываются по своим номерам кадров; пропуски — тишина.
  async stop(): Promise<{ startFrame: number; startTime: number; samples: Float32Array }> {
    this.node.port.postMessage('stop')
    await this.done
    this.source.disconnect()
    this.node.disconnect()
    this.sink.disconnect()
    if (!this.chunks.length) return { startFrame: 0, startTime: 0, samples: new Float32Array(0) }
    const first = this.chunks[0].startFrame
    const last = this.chunks[this.chunks.length - 1]
    const samples = new Float32Array(last.startFrame + last.data.length - first)
    for (const c of this.chunks) samples.set(c.data, c.startFrame - first)
    return { startFrame: first, startTime: first / this.rate, samples }
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
  if (!res.ok) throw new Error('Не получилось загрузить звук')
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
