// Калибровка задержки «выход → вход» (round-trip latency) тремя методами:
// A — кабель (выход соединён со входом), B — микрофон слушает динамик, C — человек тапает в такт.
// Математика — в dsp.ts, хранение — в calibrationStore.ts.

import { musicAudio } from '../components/MediaHelp'
import type { Method } from './calibrationStore'
import { analyzeMarks, makeChirp, maxWindowRms, rms, robust, toDb, type MarkResult } from './dsp'
import { PcmRecorder } from './pcm'

// ---------- Устройства ----------

type SinkContext = AudioContext & { setSinkId?: (id: string) => Promise<void> }

// Выбор выхода есть только там, где AudioContext умеет setSinkId (Chrome, Edge). Safari и Firefox — нет.
export const sinkSupported = () => typeof AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype

// openContext — общий AudioContext для метки, записи и воспроизведения: одни часы, нет дрейфа между входом и выходом.
// Создавать только по нажатию (требование iPhone).
export async function openContext(outputId: string): Promise<{ ctx: AudioContext; warnings: string[] }> {
  const ctx = new AudioContext({ latencyHint: 'interactive' }) as SinkContext
  await ctx.resume()
  const warnings: string[] = []
  if (outputId && outputId !== 'default' && ctx.setSinkId) {
    try {
      await ctx.setSinkId(outputId)
    } catch {
      warnings.push('Не получилось включить выбранный выход — звук идёт в устройство по умолчанию')
    }
  }
  return { ctx, warnings }
}

// openMic — микрофон без обработки браузера. Если выбранного микрофона больше нет — берём системный.
export async function openMic(inputId: string): Promise<{ stream: MediaStream; warnings: string[] }> {
  const base: MediaTrackConstraints = { ...musicAudio, channelCount: 1 }
  const warnings: string[] = []
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: inputId && inputId !== 'default' ? { ...base, deviceId: { exact: inputId } } : base,
    })
  } catch (e) {
    if (!(e instanceof DOMException) || (e.name !== 'OverconstrainedError' && e.name !== 'NotFoundError') || inputId === 'default') throw e
    warnings.push('Выбранный микрофон не найден — используем микрофон по умолчанию')
    stream = await navigator.mediaDevices.getUserMedia({ audio: base })
  }
  // Некоторые устройства игнорируют флаги: проверяем, что обработка действительно выключена.
  const s = stream.getAudioTracks()[0]?.getSettings() ?? {}
  const on = [s.echoCancellation && 'эхоподавление', s.noiseSuppression && 'шумоподавление', s.autoGainControl && 'автогромкость'].filter(Boolean)
  if (on.length) warnings.push(`Браузер не выключил ${on.join(', ')}. Замер может быть неточным, а звук партии — хуже`)
  return { stream, warnings }
}

// listDevices — входы и выходы. На iPhone и до разрешения названия скрыты, поэтому вызывать после openMic.
export async function listDevices() {
  const all = await navigator.mediaDevices.enumerateDevices()
  const pick = (kind: MediaDeviceKind) =>
    all.filter((d) => d.kind === kind && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications')
      .map((d, i) => ({ id: d.deviceId, label: d.label || `${kind === 'audioinput' ? 'Микрофон' : 'Выход'} ${i + 1}` }))
  // Chrome показывает системное устройство отдельной записью «default» с настоящим названием внутри.
  const def = (kind: MediaDeviceKind) => all.find((d) => d.kind === kind && d.deviceId === 'default')?.label ?? ''
  return { inputs: pick('audioinput'), outputs: pick('audiooutput'), defaultInput: def('audioinput'), defaultOutput: def('audiooutput') }
}

export type Devices = Awaited<ReturnType<typeof listDevices>>

// routeLabels — названия выбранных входа и выхода (для подсказки про Bluetooth).
export function routeLabels(d: Devices | null, inputId: string, outputId: string) {
  if (!d) return { input: '', output: '' }
  return {
    input: inputId === 'default' ? d.defaultInput : d.inputs.find((x) => x.id === inputId)?.label ?? '',
    output: outputId === 'default' ? d.defaultOutput : d.outputs.find((x) => x.id === outputId)?.label ?? '',
  }
}

// Заявленные браузером задержки — только для справки и проверки здравого смысла, не как результат.
export const declaredLatency = (ctx: AudioContext) => ({
  baseMs: (ctx.baseLatency || 0) * 1000,
  outputMs: (ctx.outputLatency || 0) * 1000,
  rate: ctx.sampleRate,
})

// ---------- Уровень входа ----------

export function levelMeter(ctx: AudioContext, stream: MediaStream) {
  const src = ctx.createMediaStreamSource(stream)
  const an = ctx.createAnalyser()
  an.fftSize = 2048
  src.connect(an) // в destination не подключаем — иначе будет обратная связь
  const buf = new Float32Array(an.fftSize)
  return {
    db() {
      an.getFloatTimeDomainData(buf)
      return toDb(rms(buf))
    },
    dispose() {
      src.disconnect()
    },
  }
}

// ---------- Вспомогательное ----------

export class Interrupted extends Error {
  constructor() {
    super('Измерение прервано: приложение ушло в фон или экран погас. Запусти ещё раз и не сворачивай приложение')
  }
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new Interrupted())
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(t)
      reject(new Interrupted())
    }, { once: true })
  })
}

// keepAwake — не даём экрану погаснуть во время замера и записи (если браузер умеет Wake Lock).
export async function keepAwake(): Promise<() => void> {
  try {
    const lock = await navigator.wakeLock?.request('screen')
    return () => {
      lock?.release().catch(() => {})
    }
  } catch {
    return () => {}
  }
}

// abortOnHide — AbortSignal, который срабатывает, когда вкладка уходит в фон.
export function abortOnHide() {
  const ac = new AbortController()
  const onHide = () => document.visibilityState === 'hidden' && ac.abort()
  document.addEventListener('visibilitychange', onHide)
  return { signal: ac.signal, dispose: () => document.removeEventListener('visibilitychange', onHide) }
}

function playBuffer(ctx: AudioContext, buf: AudioBuffer, at: number, volume: number) {
  const src = ctx.createBufferSource()
  src.buffer = buf
  const g = ctx.createGain()
  g.gain.value = volume
  src.connect(g).connect(ctx.destination)
  src.start(at)
  return src
}

function toBuffer(ctx: AudioContext, data: Float32Array) {
  const b = ctx.createBuffer(1, data.length, ctx.sampleRate)
  b.copyToChannel(data as Float32Array<ArrayBuffer>, 0)
  return b
}

// ---------- Методы A и B ----------

const INTERVAL = 0.7 // между метками, с
const PRE = 2048 // запас окна до времени метки, сэмплов
// Окно поиска заканчивается до следующей метки, иначе её пик спорит с текущим. Поэтому при интервале 0,7 с
// самая большая измеримая задержка ~600 мс — с запасом для любых проводных и большинства Bluetooth-наушников.
const MAX_RTL_MS = 600

export const methodDefaults: Record<'A' | 'B', { marks: number; threshold: number; volume: number }> = {
  A: { marks: 6, threshold: 0.3, volume: 0.5 },
  B: { marks: 10, threshold: 0.15, volume: 0.7 },
}

export type Precheck = { ok: boolean; noiseDb: number; markDb: number; snrDb: number; message: string }

// precheck — 1,5 с тишины (уровень шума) и одна пробная метка (слышна ли она на входе).
export async function precheck(ctx: AudioContext, stream: MediaStream, method: 'A' | 'B', volume: number, signal?: AbortSignal): Promise<Precheck> {
  const rate = ctx.sampleRate
  const chirp = makeChirp(rate)
  const rec = await PcmRecorder.create(ctx, stream)
  let markAt = 0
  try {
    await rec.started()
    markAt = ctx.currentTime + 1.6
    playBuffer(ctx, toBuffer(ctx, chirp), markAt, volume)
    await sleep((markAt - ctx.currentTime + 0.8) * 1000, signal)
  } catch (e) {
    await rec.stop()
    throw e
  }
  const { startFrame, samples } = await rec.stop()

  // Шум — от 0,2 с после начала записи до 0,1 с до метки; метка — самые громкие 40 мс за 0,7 с после её времени.
  const mark = Math.round(markAt * rate) - startFrame
  const noiseFrom = Math.round(0.2 * rate)
  const noise = rms(samples, noiseFrom, Math.max(noiseFrom + 1, mark - Math.round(0.1 * rate)))
  const level = maxWindowRms(samples, mark, mark + Math.round(0.7 * rate), chirp.length)
  const noiseDb = toDb(noise)
  const markDb = toDb(level)
  const snrDb = markDb - noiseDb
  let message = ''
  if (method === 'B' && noise > 0.03) message = 'Слишком шумно. Найди тихое место и выключи музыку рядом'
  else if (snrDb < 15) message = method === 'A'
    ? 'На входе тишина. Проверь кабель: он должен быть в линейном входе (не микрофонном), и громкость выхода'
    : 'Метку почти не слышно. Сделай громче звук телефона или поднеси микрофон ближе к динамику'
  return { ok: !message, noiseDb, markDb, snrDb, message }
}

export type Outcome = {
  method: Method
  rtlMs: number
  spreadMs: number
  madMs: number
  valid: number
  total: number
  status: 'good' | 'unreliable' | 'error'
  reasons: string[]
  warnings: string[]
}

// measureMarks — N меток по 0,7 с, задержка каждой через корреляцию, итог — медиана без выбросов.
export async function measureMarks(ctx: AudioContext, stream: MediaStream, method: 'A' | 'B',
  opts: { volume: number; onProgress?: (done: number, total: number) => void; signal?: AbortSignal }): Promise<Outcome> {
  const rate = ctx.sampleRate
  const { marks: n, threshold } = methodDefaults[method]
  const chirp = makeChirp(rate)
  const buf = toBuffer(ctx, chirp)
  const rec = await PcmRecorder.create(ctx, stream)
  const sources: AudioBufferSourceNode[] = []
  const times: number[] = []
  let timer = 0
  try {
    await rec.started()
    const t0 = ctx.currentTime + 0.5 // запас, чтобы все метки запланировались точно
    for (let i = 0; i < n; i++) {
      const t = t0 + i * INTERVAL
      times.push(t)
      sources.push(playBuffer(ctx, buf, t, opts.volume))
    }
    timer = window.setInterval(() => opts.onProgress?.(times.filter((t) => t <= ctx.currentTime).length, n), 100)
    await sleep((times[n - 1] - ctx.currentTime + 1) * 1000, opts.signal)
  } catch (e) {
    for (const s of sources) s.stop()
    await rec.stop()
    throw e
  } finally {
    clearInterval(timer)
  }
  opts.onProgress?.(n, n)
  const { startFrame, samples } = await rec.stop()
  const results = analyzeMarks(samples, startFrame, times.map((t) => Math.round(t * rate)), {
    rate, template: chirp, threshold, minRatio: 3, maxRtlMs: MAX_RTL_MS, preSamples: PRE, windowSamples: Math.round(INTERVAL * rate),
  })
  return summarize(method, results, declaredLatency(ctx))
}

const failText: Record<Exclude<MarkResult, { ok: true }>['reason'], Record<'A' | 'B', string>> = {
  not_found: { A: 'Метка не найдена — проверь кабель и громкость', B: 'Слишком тихо — метку не слышно' },
  ambiguous: { A: 'Помехи на входе — метка неоднозначна', B: 'Слишком шумно или сильное эхо' },
  out_of_range: { A: 'Задержка больше 600 мс', B: 'Задержка больше 600 мс — похоже на Bluetooth' },
  no_data: { A: 'Запись прервалась', B: 'Запись прервалась' },
}

function summarize(method: 'A' | 'B', results: MarkResult[], declared: ReturnType<typeof declaredLatency>): Outcome {
  const total = results.length
  const ok = results.flatMap((r) => (r.ok ? [r.rtlMs] : []))
  const reasons: string[] = []
  const warnings: string[] = []
  const fails = results.flatMap((r) => (r.ok ? [] : [r.reason]))
  const topFail = fails.sort((a, b) => fails.filter((x) => x === b).length - fails.filter((x) => x === a).length)[0]

  if (ok.length < 3) {
    return {
      method, rtlMs: NaN, spreadMs: NaN, madMs: NaN, valid: ok.length, total, status: 'error',
      reasons: [topFail ? failText[topFail][method] : 'Метки не найдены'], warnings,
    }
  }
  const r = robust(ok)
  const valid = r.kept.length
  if (valid / total < 0.6) reasons.push(`Принято ${valid} замеров из ${total}${topFail ? '. ' + failText[topFail][method] : ''}`)
  if (r.stdev > 3) reasons.push(`Результат скачет: разброс ${r.stdev.toFixed(1)} мс`)
  if (r.median > 300) warnings.push('Задержка больше 300 мс — так бывает у Bluetooth-наушников. Проводные дадут точнее')
  const declaredMs = declared.baseMs + declared.outputMs
  if (declaredMs > 5 && r.median < declaredMs * 0.5) {
    warnings.push(`Намерили меньше, чем заявляет браузер (${declaredMs.toFixed(0)} мс) — возможна ошибка, повтори замер`)
  }
  return {
    method, rtlMs: r.median, spreadMs: r.stdev, madMs: r.mad, valid, total,
    status: reasons.length ? 'unreliable' : 'good', reasons, warnings,
  }
}

// ---------- Метод C: тап ----------

const TAP_CLICKS = 20
const TAP_INTERVAL = 0.6
const TAP_SKIP = 4 // первые нажатия — пока человек входит в ритм

// Время нажатия (event.timeStamp, шкала performance.now) переводим в часы AudioContext через пару
// performance.now() ↔ ctx.currentTime. currentTime обновляется скачками раз в аудиобуфер и всегда немного
// отстаёт, поэтому пару снимаем много раз и берём наибольшую разность — она ближе всего к настоящей.
// getOutputTimestamp() не используем намеренно: он даёт время уже в динамике и убрал бы из результата
// задержку выхода, а нам нужно именно полное смещение «запланировано → человек сыграл».
// Ограничение: в результат входит реакция человека и задержка сенсорного экрана — это «эффективное смещение».
export class TapSession {
  readonly clicks: number[] = []
  private taps: number[] = []
  private offset = -Infinity
  private raf = 0
  private ctx: AudioContext

  constructor(ctx: AudioContext) {
    this.ctx = ctx
  }

  start(volume = 0.8) {
    const ctx = this.ctx
    const len = Math.round(0.005 * ctx.sampleRate) // импульс 5 мс
    const data = new Float32Array(len)
    for (let i = 0; i < len; i++) data[i] = Math.sin((2 * Math.PI * 2000 * i) / ctx.sampleRate) * (1 - i / len)
    const buf = toBuffer(ctx, data)
    const t0 = ctx.currentTime + 1
    for (let i = 0; i < TAP_CLICKS; i++) {
      const t = t0 + i * TAP_INTERVAL
      this.clicks.push(t)
      playBuffer(ctx, buf, t, volume)
    }
    const sync = () => {
      this.offset = Math.max(this.offset, this.ctx.currentTime - performance.now() / 1000)
      this.raf = requestAnimationFrame(sync)
    }
    sync()
    return { total: TAP_CLICKS, endsAt: this.clicks[TAP_CLICKS - 1] + 0.8 }
  }

  tap(timeStamp: number) {
    this.taps.push(timeStamp / 1000 + this.offset)
    return this.taps.length
  }

  // Сколько щелчков уже прозвучало.
  played() {
    return this.clicks.filter((t) => t <= this.ctx.currentTime).length
  }

  stop() {
    cancelAnimationFrame(this.raf)
  }

  result(): Outcome {
    this.stop()
    const offsets = this.taps.slice(TAP_SKIP).map((t) => {
      const nearest = this.clicks.reduce((a, b) => (Math.abs(b - t) < Math.abs(a - t) ? b : a))
      return (t - nearest) * 1000
    })
    const total = TAP_CLICKS - TAP_SKIP
    const base = { method: 'C' as const, total, warnings: ['Это эффективное смещение: в него входит твоя реакция. Кабель или микрофон точнее'] }
    if (offsets.length < 10) {
      return { ...base, rtlMs: NaN, spreadMs: NaN, madMs: NaN, valid: offsets.length, status: 'error', reasons: ['Мало нажатий — нажимай на каждый щелчок до конца'] }
    }
    const r = robust(offsets)
    const reasons: string[] = []
    if (r.kept.length / total < 0.6) reasons.push(`Принято ${r.kept.length} нажатий из ${total}`)
    if (r.stdev > 25) reasons.push(`Нажатия неровные: разброс ${r.stdev.toFixed(0)} мс`)
    return { ...base, rtlMs: r.median, spreadMs: r.stdev, madMs: r.mad, valid: r.kept.length, status: reasons.length ? 'unreliable' : 'good', reasons }
  }
}
