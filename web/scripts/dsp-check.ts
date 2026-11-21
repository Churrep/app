// Проверка ядра калибровки на искусственном сигнале с известной задержкой.
// Запуск: node scripts/dsp-check.ts (Node 24 сам понимает TypeScript).
import { analyzeMarks, fft, ifft, makeChirp, ncc, robust } from '../src/lib/dsp.ts'

let failed = 0
function check(name: string, ok: boolean, info = '') {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${info ? ' — ' + info : ''}`)
  if (!ok) failed++
}

// Псевдослучайный шум с повторяемым результатом.
let seed = 12345
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1

// 1. FFT туда-обратно возвращает исходный сигнал.
{
  const re = new Float64Array(1024).map(() => rand())
  const orig = re.slice()
  const im = new Float64Array(1024)
  fft(re, im)
  ifft(re, im)
  const err = Math.max(...re.map((v, i) => Math.abs(v - orig[i])))
  check('fft/ifft', err < 1e-9, `ошибка ${err.toExponential(1)}`)
}

// 2. FFT синуса — пик в своём бине.
{
  const n = 256
  const re = new Float64Array(n).map((_, i) => Math.sin((2 * Math.PI * 10 * i) / n))
  const im = new Float64Array(n)
  fft(re, im)
  const mag = Array.from(re, (v, i) => Math.hypot(v, im[i]))
  check('fft: пик синуса в бине 10', mag.indexOf(Math.max(...mag.slice(0, n / 2))) === 10)
}

const rate = 48000
const tpl = makeChirp(rate)

// 3. NCC: метка с задержкой 1000 сэмплов, тихая (×0.05) и с шумом — пик там же, значение не зависит от громкости.
{
  const x = new Float32Array(8000).map(() => rand() * 0.001)
  for (let i = 0; i < tpl.length; i++) x[1000 + i] += tpl[i] * 0.05
  const c = ncc(x, tpl)
  let k = 0
  for (let i = 0; i < c.length; i++) if (Math.abs(c[i]) > Math.abs(c[k])) k = i
  check('ncc: позиция пика', k === 1000, `пик ${k}, значение ${c[k].toFixed(3)}`)
  check('ncc: нормировка', c[k] > 0.9 && c[k] <= 1.0001)
}

// 4. Полный анализ: 10 меток, у каждой своя задержка около 87.3 мс, шум, эхо, перевёрнутая фаза.
{
  const marksAt: number[] = []
  const startFrame = 100000 // запись началась не с нуля — как в настоящем AudioContext
  const total = rate * 9
  const x = new Float32Array(total).map(() => rand() * 0.01)
  const trueMs = 87.3
  for (let i = 0; i < 10; i++) {
    const s = startFrame + Math.round(0.5 * rate) + Math.round(i * 0.7 * rate)
    marksAt.push(s)
    const arrive = (s - startFrame) + (trueMs / 1000) * rate // дробная задержка
    const base = Math.floor(arrive)
    const frac = arrive - base
    for (let j = 0; j < tpl.length; j++) {
      // линейная интерполяция для дробного сдвига, фаза перевёрнута, плюс эхо через 12 мс в 4 раза тише
      const v = -(tpl[j] * (1 - frac) + (tpl[j - 1] ?? 0) * frac) * 0.3
      x[base + j] += v
      x[base + j + Math.round(0.012 * rate)] += v / 4
    }
  }
  const res = analyzeMarks(x, startFrame, marksAt, {
    rate, template: tpl, threshold: 0.15, minRatio: 3, maxRtlMs: 600,
    preSamples: 2048, windowSamples: Math.round(0.7 * rate),
  })
  const ok = res.filter((r) => r.ok)
  const r = robust(ok.map((m) => (m.ok ? m.rtlMs : 0)))
  check('анализ: все метки найдены', ok.length === 10, `${ok.length}/10`)
  check('анализ: задержка ±0.1 мс', Math.abs(r.median - trueMs) < 0.1, `${r.median.toFixed(3)} мс при ${trueMs}`)
  check('анализ: разброс < 0.1 мс', r.stdev < 0.1, `${r.stdev.toFixed(4)} мс`)

  // Те же метки в тишине без сигнала — должны отбраковаться, а не дать случайное число.
  const silent = new Float32Array(total).map(() => rand() * 0.01)
  const bad = analyzeMarks(silent, startFrame, marksAt, {
    rate, template: tpl, threshold: 0.15, minRatio: 3, maxRtlMs: 600,
    preSamples: 2048, windowSamples: Math.round(0.7 * rate),
  })
  check('анализ: в шуме метки не находятся', bad.every((m) => !m.ok), bad.map((m) => (m.ok ? 'ok' : m.reason)).join(','))
}

// 5. Отбраковка выбросов по MAD.
{
  const r = robust([10, 10.2, 9.9, 10.1, 10, 55, 9.8, -30])
  check('robust: выбросы отброшены', r.dropped.length === 2 && Math.abs(r.median - 10) < 0.11, `медиана ${r.median}, отброшено ${r.dropped}`)
}

if (failed) {
  console.log(`\nНе прошло: ${failed}`)
  throw new Error('dsp-check failed')
}
console.log('\nВсё прошло')
