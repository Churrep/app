// Камера для записи видео: как можно шире.
// 1) Не просим у камеры 9:16 — иначе браузер срезает края матрицы (3:4). Берём родной формат, сервер сам
//    впишет кадр в 9:16 с размытым фоном.
// 2) Если камера умеет зум меньше 1× (логическая камера со сверхширокой), ставим самый широкий.
// 3) Если есть отдельная сверхширокая камера (так её показывает iPhone), даём её выбрать.

export type Facing = 'user' | 'environment'

// Поля, которых ещё нет в типах TypeScript: resizeMode (Chrome) и зум (Image Capture / PTZ).
type ExtConstraints = MediaTrackConstraints & { resizeMode?: string; zoom?: boolean | number }
type ZoomCaps = { min: number; max: number; step?: number }

export type Camera = { id: string; label: string; ultra: boolean }
export type Zoom = { min: number; max: number; value: number }

const PREFS_KEY = 'camera_prefs_v1'
type CameraPrefs = Partial<Record<Facing, { deviceId?: string; zoom?: number }>>

function loadPrefs(): CameraPrefs {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') as CameraPrefs
  } catch {
    return {}
  }
}

export const cameraPref = (f: Facing) => loadPrefs()[f] ?? {}

export function saveCameraPref(f: Facing, p: { deviceId?: string; zoom?: number }) {
  try {
    const all = loadPrefs()
    all[f] = { ...all[f], ...p }
    localStorage.setItem(PREFS_KEY, JSON.stringify(all))
  } catch {
    // приватный режим
  }
}

const supports = (name: string) => Boolean((navigator.mediaDevices?.getSupportedConstraints?.() as Record<string, boolean> | undefined)?.[name])

// videoConstraints — без обрезки: высота около 1280 по родному формату матрицы, без масштабирования браузером.
export function videoConstraints(facing: Facing, deviceId?: string): MediaTrackConstraints {
  const c: ExtConstraints = { height: { ideal: 1280 }, frameRate: { ideal: 30 } }
  if (supports('resizeMode')) c.resizeMode = 'none'
  // zoom: true — просим доступ к зуму (Chrome спросит «использовать и перемещать камеру»).
  if (supports('zoom')) c.zoom = true
  if (deviceId) c.deviceId = { exact: deviceId }
  else c.facingMode = facing
  return c
}

const FRONT = /front|передн|user|facetime|фронт/i
const BACK = /back|rear|задн|environment|основн/i
const ULTRA = /ultra|сверхшир|ультрашир|0[.,]5|wide.?angle/i

// listCameras — камеры нужной стороны. Названия есть только после разрешения на камеру.
// Если по названиям сторону не понять (веб-камеры компьютера), возвращаем все.
export async function listCameras(facing: Facing): Promise<Camera[]> {
  const all = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput' && d.deviceId)
  const side = all.filter((d) => (facing === 'user' ? FRONT : BACK).test(d.label))
  const known = all.some((d) => FRONT.test(d.label) || BACK.test(d.label))
  return (known ? side : all).map((d, i) => ({ id: d.deviceId, label: d.label || `Камера ${i + 1}`, ultra: ULTRA.test(d.label) }))
}

// setupZoom — диапазон зума и самый широкий (или сохранённый) по умолчанию. null — камера зум не даёт.
export async function setupZoom(track: MediaStreamTrack, saved?: number): Promise<Zoom | null> {
  const caps = (track.getCapabilities?.() as { zoom?: ZoomCaps } | undefined)?.zoom
  if (!caps || !(caps.max > caps.min)) return null
  const value = saved !== undefined && saved >= caps.min && saved <= caps.max ? saved : caps.min
  try {
    await track.applyConstraints({ advanced: [{ zoom: value } as MediaTrackConstraintSet] })
  } catch {
    return null
  }
  return { min: caps.min, max: caps.max, value }
}

export async function setZoom(track: MediaStreamTrack, value: number) {
  await track.applyConstraints({ advanced: [{ zoom: value } as MediaTrackConstraintSet] })
}

// zoomStops — кнопки зума: самый широкий, 1× и 2×, если они в диапазоне.
export function zoomStops(z: Zoom) {
  const stops = [z.min, 1, 2].filter((v) => v >= z.min && v <= z.max)
  // Сами значения не округляем (0,54 → 0,5 вышло бы за диапазон), убираем только одинаковые на вид.
  return stops.filter((v, i) => stops.findIndex((x) => fmtZoom(x) === fmtZoom(v)) === i)
}

export const fmtZoom = (v: number) => `${String(Math.round(v * 10) / 10).replace('.', ',')}×`
