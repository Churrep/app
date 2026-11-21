import { useSyncExternalStore } from 'react'
import { api } from '../api'

// Сколько человек ждут ответа в «Тебя лайкнули». Общий счётчик для метки на вкладке «Совпадения» и списка входящих лайков.
let count = 0
let initialized = false
const listeners = new Set<() => void>()
const newLikeListeners = new Set<() => void>()

export async function refreshIncoming() {
  try {
    const r = await api<{ count: number }>('/likes/incoming/count')
    const grew = initialized && r.count > count
    count = r.count
    initialized = true
    listeners.forEach((l) => l())
    if (grew) newLikeListeners.forEach((l) => l())
  } catch {
    // нет сети — покажем старое значение
  }
}

export function useIncomingCount() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => {
        listeners.delete(l)
      }
    },
    () => count,
  )
}

export function onNewLike(l: () => void) {
  newLikeListeners.add(l)
  return () => {
    newLikeListeners.delete(l)
  }
}
