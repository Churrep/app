import { useSyncExternalStore } from 'react'

// beforeinstallprompt приходит рано, до монтирования экранов, поэтому ловим его при загрузке модуля.
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

let deferred: BeforeInstallPromptEvent | null = null
let installed = false
let version = 0
const listeners = new Set<() => void>()

function notify() {
  version++
  listeners.forEach((l) => l())
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault()
  deferred = e as BeforeInstallPromptEvent
  notify()
})

window.addEventListener('appinstalled', () => {
  installed = true
  deferred = null
  notify()
})

export function isStandalone() {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  )
}

export type Platform = 'ios-safari' | 'ios-other' | 'android' | 'other'

export function platform(): Platform {
  const ua = navigator.userAgent
  const ios = /iphone|ipad|ipod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  if (ios) return /crios|fxios|edgios|yabrowser|opios/i.test(ua) ? 'ios-other' : 'ios-safari'
  if (/android/i.test(ua)) return 'android'
  return 'other'
}

function subscribe(l: () => void) {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

export function useInstall() {
  useSyncExternalStore(subscribe, () => version)
  return {
    canPrompt: deferred !== null,
    installed: installed || isStandalone(),
    async prompt() {
      if (!deferred) return
      const event = deferred
      deferred = null
      await event.prompt()
      const choice = await event.userChoice
      if (choice.outcome === 'accepted') installed = true
      notify()
    },
  }
}
