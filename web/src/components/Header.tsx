import type { ReactNode } from 'react'
import { useNavigate } from 'react-router'
import { BackIcon } from './Icons'

export function Header({ title, back, right }: { title?: string; back?: boolean | (() => void); right?: ReactNode }) {
  const navigate = useNavigate()
  const onBack = typeof back === 'function' ? back : () => navigate(-1)
  return (
    <header className="header">
      {back && (
        <button className="icon-btn" onClick={onBack} aria-label="Назад">
          <BackIcon />
        </button>
      )}
      {title && <h1 className="header-title">{title}</h1>}
      <div className="header-right">{right}</div>
    </header>
  )
}
