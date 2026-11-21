// Хранение калибровок задержки в браузере (это настройка устройства, а не аккаунта).
// У каждого «маршрута» — вход, выход, частота дискретизации и метод — свой результат и своя ручная подстройка:
// кабель, микрофон и тап измеряют разные вещи, а другие наушники — это другая задержка.

export type Method = 'A' | 'B' | 'C'

export const methodName: Record<Method, string> = { A: 'Кабель', B: 'Микрофон', C: 'Тап' }

export type CalibrationRecord = {
  method: Method
  rtlMs: number // задержка (для тапа — эффективное смещение)
  spreadMs: number // стандартное отклонение по принятым замерам
  valid: number
  total: number
  date: string
  version: number
  reliable: boolean
  stale?: boolean // устройства поменялись после калибровки
}

export type Prefs = { method: Method; inputId: string; outputId: string }

export const ALGO_VERSION = 1
const KEY = 'audio_calibration_v1'
const SIG_KEY = 'audio_devices_sig'

type Data = {
  prefs: Prefs
  results: Record<string, CalibrationRecord>
  adjust: Record<string, number> // ручная подстройка, мс, добавляется к калибровке
}

const empty = (): Data => ({ prefs: { method: 'B', inputId: 'default', outputId: 'default' }, results: {}, adjust: {} })

function load(): Data {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return empty()
    const d = JSON.parse(raw) as Partial<Data>
    return { ...empty(), ...d, prefs: { ...empty().prefs, ...d.prefs } }
  } catch {
    return empty()
  }
}

function save(d: Data) {
  try {
    localStorage.setItem(KEY, JSON.stringify(d))
  } catch {
    // приватный режим — калибровка живёт до перезагрузки
  }
}

// Вход и выход берём из выбранных в настройках ('default' — системные), а не из getSettings():
// так ключ одинаковый на экране калибровки и на экране записи. Тап (C) не слушает микрофон — вход не важен.
export const routeKey = (inputId: string, outputId: string, rate: number, method: Method) =>
  `${method === 'C' ? '*' : inputId || 'default'}|${outputId || 'default'}|${rate}|${method}`

const routePrefix = (inputId: string, outputId: string, method: Method) =>
  `${method === 'C' ? '*' : inputId || 'default'}|${outputId || 'default'}|`

export const getPrefs = () => load().prefs

export function setPrefs(p: Partial<Prefs>) {
  const d = load()
  d.prefs = { ...d.prefs, ...p }
  save(d)
}

// findResult — результат для маршрута. Без rate (контекст ещё не создан) — самый свежий для этого входа/выхода.
export function findResult(inputId: string, outputId: string, method: Method, rate?: number): { key: string; rec: CalibrationRecord } | null {
  const d = load()
  if (rate) {
    const key = routeKey(inputId, outputId, rate, method)
    return d.results[key] ? { key, rec: d.results[key] } : null
  }
  const prefix = routePrefix(inputId, outputId, method)
  const found = Object.entries(d.results)
    .filter(([k]) => k.startsWith(prefix) && k.endsWith('|' + method))
    .sort((a, b) => b[1].date.localeCompare(a[1].date))[0]
  return found ? { key: found[0], rec: found[1] } : null
}

export function saveResult(key: string, rec: CalibrationRecord) {
  const d = load()
  d.results[key] = { ...rec, stale: false }
  save(d)
}

export const getAdjust = (key: string) => load().adjust[key] ?? 0

export function setAdjust(key: string, ms: number) {
  const d = load()
  d.adjust[key] = Math.round(ms)
  save(d)
}

function markAllStale() {
  const d = load()
  for (const k of Object.keys(d.results)) d.results[k].stale = true
  save(d)
}

// Отпечаток аудиоустройств. Считаем только когда браузер показывает названия (после разрешения на микрофон):
// до разрешения id и названия скрыты, и сравнение дало бы ложное «устарела».
async function deviceSignature(): Promise<string | null> {
  if (!navigator.mediaDevices?.enumerateDevices) return null
  const list = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput' || d.kind === 'audiooutput')
  if (!list.length || list.some((d) => !d.deviceId || !d.label)) return null
  return list.map((d) => `${d.kind}:${d.deviceId}:${d.label}`).sort().join('\n')
}

// checkDevices — сравнивает устройства с прошлым разом; если поменялись — все калибровки «устарели».
// Возвращает true, если пометили.
export async function checkDevices(): Promise<boolean> {
  const sig = await deviceSignature()
  if (!sig) return false
  let prev: string | null = null
  try {
    prev = localStorage.getItem(SIG_KEY)
    localStorage.setItem(SIG_KEY, sig)
  } catch {
    return false
  }
  if (prev !== null && prev !== sig) {
    markAllStale()
    return true
  }
  return false
}

// watchDevices — следит за подключением и отключением устройств, пока экран открыт.
export function watchDevices(onChange: () => void) {
  const md = navigator.mediaDevices
  if (!md) return () => {}
  const handler = () => {
    checkDevices().then((changed) => changed && onChange())
  }
  md.addEventListener('devicechange', handler)
  return () => md.removeEventListener('devicechange', handler)
}

// Беспроводные наушники: задержка большая и меняется при каждом подключении.
export const looksBluetooth = (label = '') => /bluetooth|airpods|buds|hands-?free|wireless|беспровод|\bbt\b/i.test(label)
