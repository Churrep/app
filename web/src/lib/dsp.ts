// Обработка сигнала для калибровки задержки: FFT, нормированная кросс-корреляция, поиск пика,
// устойчивая статистика. Только чистые функции без Web Audio — их проверяет scripts/dsp-check.ts.

// fft — БПФ radix-2 на месте. Длина — степень двойки.
export function fft(re: Float64Array, im: Float64Array) {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t
      t = im[i]; im[i] = im[j]; im[j] = t
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    const wr = Math.cos(ang)
    const wi = Math.sin(ang)
    const half = len >> 1
    for (let i = 0; i < n; i += len) {
      let cr = 1
      let ci = 0
      for (let k = 0; k < half; k++) {
        const a = i + k
        const b = a + half
        const xr = re[b] * cr - im[b] * ci
        const xi = re[b] * ci + im[b] * cr
        re[b] = re[a] - xr
        im[b] = im[a] - xi
        re[a] += xr
        im[a] += xi
        const ncr = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = ncr
      }
    }
  }
}

// ifft — обратное БПФ через сопряжение.
export function ifft(re: Float64Array, im: Float64Array) {
  for (let i = 0; i < im.length; i++) im[i] = -im[i]
  fft(re, im)
  const n = re.length
  for (let i = 0; i < n; i++) {
    re[i] /= n
    im[i] = -im[i] / n
  }
}

export const nextPow2 = (n: number) => 2 ** Math.ceil(Math.log2(Math.max(2, n)))

// makeChirp — метка: линейный chirp f0→f1 с окном Ханна (без щелчка на краях), пик = amp.
export function makeChirp(rate: number, durSec = 0.04, f0 = 1000, f1 = 8000, amp = 1): Float32Array {
  const n = Math.round(durSec * rate)
  const out = new Float32Array(n)
  const k = (f1 - f0) / durSec
  let max = 0
  for (let i = 0; i < n; i++) {
    const t = i / rate
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1))
    out[i] = w * Math.sin(2 * Math.PI * (f0 * t + 0.5 * k * t * t))
    max = Math.max(max, Math.abs(out[i]))
  }
  for (let i = 0; i < n; i++) out[i] = (out[i] / max) * amp
  return out
}

// ncc — нормированная кросс-корреляция: out[k] = Σ x[k+j]·t[j] / sqrt(Σt² · Σx[k..k+m]²).
// Значение от −1 до 1 и не зависит от громкости. Считается через БПФ.
export function ncc(x: Float32Array, t: Float32Array): Float32Array {
  return xcorr(x, t).norm
}

// xcorr — обычная (raw) и нормированная (norm) кросс-корреляция.
// raw нужна, чтобы отличить метку от её эха: нормировка уравнивает громкость, и эхо выглядит как метка.
export function xcorr(x: Float32Array, t: Float32Array): { raw: Float32Array; norm: Float32Array } {
  const m = t.length
  const lags = x.length - m + 1
  if (lags <= 0 || m === 0) return { raw: new Float32Array(0), norm: new Float32Array(0) }
  const n = nextPow2(x.length + m)
  const xr = new Float64Array(n)
  const xi = new Float64Array(n)
  const tr = new Float64Array(n)
  const ti = new Float64Array(n)
  for (let i = 0; i < x.length; i++) xr[i] = x[i]
  for (let i = 0; i < m; i++) tr[i] = t[i]
  fft(xr, xi)
  fft(tr, ti)
  for (let k = 0; k < n; k++) {
    const re = xr[k] * tr[k] + xi[k] * ti[k]
    const im = xi[k] * tr[k] - xr[k] * ti[k]
    xr[k] = re
    xi[k] = im
  }
  ifft(xr, xi)

  let et = 0
  for (let i = 0; i < m; i++) et += t[i] * t[i]
  const prefix = new Float64Array(x.length + 1)
  for (let i = 0; i < x.length; i++) prefix[i + 1] = prefix[i] + x[i] * x[i]
  const raw = new Float32Array(lags)
  const norm = new Float32Array(lags)
  for (let k = 0; k < lags; k++) {
    const ex = prefix[k + m] - prefix[k]
    raw[k] = xr[k]
    norm[k] = ex > 1e-12 ? xr[k] / Math.sqrt(et * ex) : 0
  }
  return { raw, norm }
}

export type Peak = { pos: number; value: number; second: number; index: number }

// findPeak — главный пик |corr| с уточнением до долей сэмпла (парабола по трём точкам)
// и второй по величине пик вне ±guard сэмплов от главного. Берём модуль: на некоторых
// устройствах вход или выход переворачивает фазу, и пик получается отрицательным.
export function findPeak(corr: Float32Array, guard: number): Peak {
  let k = 0
  let best = -1
  for (let i = 0; i < corr.length; i++) {
    const v = Math.abs(corr[i])
    if (v > best) {
      best = v
      k = i
    }
  }
  let pos = k
  let value = Math.max(0, best)
  if (k > 0 && k < corr.length - 1) {
    const y0 = Math.abs(corr[k - 1])
    const y1 = best
    const y2 = Math.abs(corr[k + 1])
    const den = y0 - 2 * y1 + y2
    if (den < 0) {
      const d = Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / den))
      pos = k + d
      value = y1 - 0.25 * (y0 - y2) * d
    }
  }
  let second = 0
  for (let i = 0; i < corr.length; i++) {
    if (Math.abs(i - k) > guard) second = Math.max(second, Math.abs(corr[i]))
  }
  return { pos, value, second, index: k }
}

export const median = (v: number[]) => {
  if (!v.length) return NaN
  const s = [...v].sort((a, b) => a - b)
  const h = s.length >> 1
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2
}

export type Robust = { median: number; mad: number; stdev: number; kept: number[]; dropped: number[] }

// robust — медиана, отбраковка значений дальше 3·MAD от медианы, повторная медиана.
export function robust(values: number[]): Robust {
  const m0 = median(values)
  const mad0 = median(values.map((v) => Math.abs(v - m0)))
  // MAD = 0 бывает, когда половина замеров совпала до сэмпла: тогда отбрасывать по нему нельзя.
  const limit = mad0 > 0 ? 3 * mad0 : Infinity
  const kept = values.filter((v) => Math.abs(v - m0) <= limit)
  const dropped = values.filter((v) => Math.abs(v - m0) > limit)
  const m = median(kept)
  const mad = median(kept.map((v) => Math.abs(v - m)))
  const mean = kept.reduce((a, b) => a + b, 0) / (kept.length || 1)
  const stdev = kept.length > 1 ? Math.sqrt(kept.reduce((a, b) => a + (b - mean) ** 2, 0) / (kept.length - 1)) : 0
  return { median: m, mad, stdev, kept, dropped }
}

export type MarkResult =
  | { ok: true; rtlMs: number; peak: number; ratio: number }
  | { ok: false; reason: 'not_found' | 'ambiguous' | 'out_of_range' | 'no_data'; peak: number; ratio: number }

export type AnalyzeOptions = {
  rate: number
  template: Float32Array
  threshold: number // минимальный нормированный пик
  minRatio: number // главный пик / второй пик
  maxRtlMs: number
  preSamples: number // запас до времени метки на случай отрицательной ошибки
  windowSamples: number // длина окна поиска
}

// analyzeMarks — задержка каждой метки. samples — запись, первый сэмпл которой имеет номер
// кадра startFrame по часам AudioContext; marks — номера кадров, в которые метки были запланированы.
export function analyzeMarks(samples: Float32Array, startFrame: number, marks: number[], o: AnalyzeOptions): MarkResult[] {
  const guard = Math.round(0.005 * o.rate)
  return marks.map((s): MarkResult => {
    const from = s - o.preSamples - startFrame
    const to = from + o.windowSamples
    if (from < 0 || to > samples.length) return { ok: false, reason: 'no_data', peak: 0, ratio: 0 }
    const { raw, norm } = xcorr(samples.subarray(from, to), o.template)
    // Положение и «главный / второй» — по обычной корреляции (эхо тише метки),
    // качество — по нормированной (не зависит от громкости).
    const p = findPeak(raw, guard)
    const ratio = p.second > 0 ? p.value / p.second : Infinity
    const peak = Math.abs(norm[p.index] ?? 0)
    const rtlMs = ((from + startFrame + p.pos - s) / o.rate) * 1000
    if (peak < o.threshold) return { ok: false, reason: 'not_found', peak, ratio }
    if (ratio < o.minRatio) return { ok: false, reason: 'ambiguous', peak, ratio }
    if (rtlMs < 0 || rtlMs > o.maxRtlMs) return { ok: false, reason: 'out_of_range', peak, ratio }
    return { ok: true, rtlMs, peak, ratio }
  })
}

export const rms = (x: Float32Array, from = 0, to = x.length) => {
  let s = 0
  for (let i = from; i < to; i++) s += x[i] * x[i]
  return to > from ? Math.sqrt(s / (to - from)) : 0
}

// maxWindowRms — самый громкий отрезок длиной win сэмплов (шаг win/4).
export function maxWindowRms(x: Float32Array, from: number, to: number, win: number) {
  let best = 0
  const step = Math.max(1, win >> 2)
  for (let i = Math.max(0, from); i + win <= Math.min(x.length, to); i += step) best = Math.max(best, rms(x, i, i + win))
  return best
}

export const toDb = (v: number) => 20 * Math.log10(Math.max(v, 1e-9))
