import { api } from '../api'
import { isStandalone, platform } from '../install'

export type PushState = 'unsupported' | 'need-install' | 'denied' | 'off' | 'on'

function keyBytes(base64url: string) {
  const pad = '='.repeat((4 - (base64url.length % 4)) % 4)
  const raw = atob((base64url + pad).replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(raw, (c) => c.charCodeAt(0))
}

// Можно ли включить push здесь и сейчас. На iPhone — только из приложения на экране «Домой».
export async function pushState(): Promise<PushState> {
  const p = platform()
  if ((p === 'ios-safari' || p === 'ios-other') && !isStandalone()) return 'need-install'
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'unsupported'
  if (Notification.permission === 'denied') return 'denied'
  try {
    const { enabled } = await api<{ enabled: boolean }>('/push/key')
    const reg = await navigator.serviceWorker.getRegistration()
    const sub = await reg?.pushManager.getSubscription()
    return enabled && sub ? 'on' : 'off'
  } catch {
    return 'unsupported'
  }
}

// Включает push. Вызывать только по нажатию кнопки — иначе браузер не покажет запрос разрешения.
export async function enablePush(): Promise<PushState> {
  if ((await Notification.requestPermission()) !== 'granted') return 'denied'
  const { public_key } = await api<{ public_key: string }>('/push/key')
  const reg = await navigator.serviceWorker.ready
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(public_key) }))
  await api('/push/subscribe', { method: 'POST', body: sub.toJSON() })
  return 'on'
}

export async function disablePush(): Promise<PushState> {
  const reg = await navigator.serviceWorker.getRegistration()
  const sub = await reg?.pushManager.getSubscription()
  if (sub) {
    await api('/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } })
    await sub.unsubscribe()
  }
  return 'off'
}
