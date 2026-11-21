import type { ReactNode } from 'react'
import { ApiError, errorText } from '../api'
import { OfflineIcon } from './Icons'

// Четыре состояния каждого экрана: загрузка, ошибка, нет сети, пусто.

export function FullLoading() {
  return (
    <div className="state state-full" role="status" aria-label="Загрузка">
      <div className="spinner" />
    </div>
  )
}

export function Loading() {
  return (
    <div className="state" role="status" aria-label="Загрузка">
      <div className="spinner" />
    </div>
  )
}

export function ErrorState({ error, onRetry, full }: { error: unknown; onRetry: () => void; full?: boolean }) {
  const offline = error instanceof ApiError && error.offline
  return (
    <div className={full ? 'state state-full' : 'state'}>
      {offline && <OfflineIcon width={40} height={40} className="state-icon" />}
      <h2>{offline ? 'Нет сети' : 'Не получилось загрузить'}</h2>
      <p className="muted">{offline ? 'Проверь интернет и попробуй ещё раз' : errorText(error)}</p>
      <button className="btn btn-secondary" onClick={onRetry}>Попробовать ещё раз</button>
    </div>
  )
}

export function Empty({ title, text, art, children }: { title: string; text?: string; art?: ReactNode; children?: ReactNode }) {
  return (
    <div className="state">
      {art && <div className="state-art">{art}</div>}
      <h2>{title}</h2>
      {text && <p className="muted">{text}</p>}
      {children}
    </div>
  )
}
