import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router'
import { api, ApiError, errorText } from '../api'
import { useSession } from '../session'
import type { Me } from '../types'

type AuthResult = { user: Me; is_new: boolean }

// Цифры после +7, максимум 10.
function cleanPhone(raw: string) {
  let d = raw.replace(/\D/g, '')
  if (d.length === 11 && (d[0] === '7' || d[0] === '8')) d = d.slice(1)
  return d.slice(0, 10)
}

function formatPhone(d: string) {
  const parts = [d.slice(0, 3), d.slice(3, 6), d.slice(6, 8), d.slice(8, 10)]
  let s = parts[0]
  if (d.length > 3) s = `(${parts[0]}) ${parts[1]}`
  if (d.length > 6) s += `-${parts[2]}`
  if (d.length > 8) s += `-${parts[3]}`
  return s
}

function useCountdown() {
  const [left, setLeft] = useState(0)
  useEffect(() => {
    if (left <= 0) return
    const t = setTimeout(() => setLeft(left - 1), 1000)
    return () => clearTimeout(t)
  }, [left])
  return [left, setLeft] as const
}

export function Login() {
  const { setMe } = useSession()
  const navigate = useNavigate()
  const [phase, setPhase] = useState<'phone' | 'code'>('phone')
  const [phone, setPhone] = useState('')
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [left, setLeft] = useCountdown()

  function done(res: AuthResult) {
    setMe(res.user)
    navigate(res.user.onboarding.complete ? '/feed' : '/onboarding', { replace: true })
  }

  async function requestCode(e?: FormEvent) {
    e?.preventDefault()
    if (phone.length !== 10 || busy) return
    setBusy(true)
    setError('')
    try {
      const res = await api<{ retry_after: number }>('/auth/otp', { method: 'POST', body: { phone: '+7' + phone } })
      setLeft(res.retry_after)
      setCode('')
      setPhase('code')
    } catch (err) {
      setError(errorText(err))
      // Код уже отправлен недавно — можно сразу его ввести.
      if (err instanceof ApiError && err.code === 'too_soon') setPhase('code')
    } finally {
      setBusy(false)
    }
  }

  async function verify(value: string) {
    if (value.length !== 6 || busy) return
    setBusy(true)
    setError('')
    try {
      done(await api<AuthResult>('/auth/verify', { method: 'POST', body: { phone: '+7' + phone, code: value } }))
    } catch (err) {
      setError(errorText(err))
      setCode('')
      setBusy(false)
    }
  }

  return (
    <main className="screen">
      <div className="screen-body center-body">
        <img src="/logo.svg" alt="" width={72} height={72} className="logo" />
        <h1 className="title">Найди, с кем играть в Саратове</h1>

        {phase === 'phone' ? (
          <form onSubmit={requestCode} className="stack">
            <label className="field">
              <span className="label">Номер телефона</span>
              <div className="phone-input">
                <span>+7</span>
                <input
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel-national"
                  placeholder="(900) 000-00-00"
                  value={formatPhone(phone)}
                  onChange={(e) => setPhone(cleanPhone(e.target.value))}
                  autoFocus
                />
              </div>
            </label>
            {error && <p className="error-text" role="alert">{error}</p>}
            <button className="btn btn-primary" disabled={phone.length !== 10 || busy}>
              {busy ? 'Отправляем…' : 'Получить код'}
            </button>
          </form>
        ) : (
          <div className="stack">
            <p className="muted">Отправили СМС на +7 {formatPhone(phone)}</p>
            <label className="field">
              <span className="label">Код из СМС</span>
              <input
                className="input code-input"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={code}
                onChange={(e) => {
                  const v = e.target.value.replace(/\D/g, '').slice(0, 6)
                  setCode(v)
                  verify(v)
                }}
                autoFocus
              />
            </label>
            {error && <p className="error-text" role="alert">{error}</p>}
            <button className="btn btn-secondary" disabled={left > 0 || busy} onClick={() => requestCode()}>
              {left > 0 ? `Новый код через ${left} сек` : 'Отправить код ещё раз'}
            </button>
            <button className="btn btn-ghost" onClick={() => { setPhase('phone'); setError('') }}>
              Изменить номер
            </button>
          </div>
        )}

        <TelegramLogin onDone={done} onError={setError} />
      </div>
    </main>
  )
}

declare global {
  interface Window {
    onTelegramAuth?: (user: Record<string, string | number>) => void
  }
}

// Кнопка Telegram Login. Показывается, только если задан VITE_TELEGRAM_BOT (имя бота без @).
function TelegramLogin({ onDone, onError }: { onDone: (r: AuthResult) => void; onError: (msg: string) => void }) {
  const bot = import.meta.env.VITE_TELEGRAM_BOT as string | undefined
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!bot || !ref.current) return
    window.onTelegramAuth = async (user) => {
      try {
        onDone(await api<AuthResult>('/auth/telegram', { method: 'POST', body: user }))
      } catch (err) {
        onError(errorText(err))
      }
    }
    const s = document.createElement('script')
    s.src = 'https://telegram.org/js/telegram-widget.js?22'
    s.async = true
    s.dataset.telegramLogin = bot
    s.dataset.size = 'large'
    s.dataset.radius = '12'
    s.dataset.onauth = 'onTelegramAuth(user)'
    s.dataset.requestAccess = 'write'
    const box = ref.current
    box.appendChild(s)
    return () => {
      box.innerHTML = ''
      delete window.onTelegramAuth
    }
  }, [bot])

  if (!bot) return null
  return (
    <div className="stack">
      <div className="divider">или</div>
      <div ref={ref} className="telegram-box" />
    </div>
  )
}
