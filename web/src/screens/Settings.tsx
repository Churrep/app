import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { errorText } from '../api'
import { Header } from '../components/Header'
import { InstallGuide } from '../components/InstallGuide'
import { useMe } from '../session'
import type { MePatch } from '../types'

export function Settings() {
  const { me, patchMe, logout } = useMe()
  const navigate = useNavigate()
  const [error, setError] = useState('')
  const minor = me.age !== undefined && me.age < 18

  async function update(patch: MePatch) {
    setError('')
    try {
      await patchMe(patch)
    } catch (e) {
      setError(errorText(e))
    }
  }

  return (
    <main className="screen">
      <Header title="Настройки" back />
      <div className="screen-body stack-lg">
        {error && <p className="error-text" role="alert">{error}</p>}

        <section className="card">
          <h3>Тема</h3>
          <div className="segmented" role="radiogroup">
            {(['dark', 'light'] as const).map((t) => (
              <button key={t} role="radio" aria-checked={me.theme === t} onClick={() => update({ theme: t })}>
                {t === 'dark' ? 'Тёмная' : 'Светлая'}
              </button>
            ))}
          </div>
        </section>

        <section className="card">
          <h3>Приватность</h3>
          <Toggle label="Показывать возраст" checked={me.show_age} onChange={(v) => update({ show_age: v })} />
          <Toggle label="Показывать район" checked={me.show_district} onChange={(v) => update({ show_district: v })}
            hint={minor ? 'Пока тебе нет 18, район в профиле скрыт для всех' : undefined} />
        </section>


        <section className="card">
          <h3>Звук</h3>
          <p className="small muted">Задержка между наушниками и микрофоном — чтобы записанная партия совпадала с минусом.</p>
          <Link className="btn btn-secondary" to="/me/settings/audio">Калибровка задержки</Link>
        </section>

        <section className="card">
          <h3>Приложение на экране «Домой»</h3>
          <InstallGuide />
        </section>

        <section className="card">
          <h3>Аккаунт</h3>
          {me.phone && <p className="muted">Телефон: {me.phone}</p>}
          {me.telegram_username && <p className="muted">Telegram: @{me.telegram_username}</p>}
          <button className="btn btn-secondary" onClick={async () => { await logout(); navigate('/login', { replace: true }) }}>
            Выйти
          </button>
        </section>
      </div>
    </main>
  )
}

function Toggle({ label, checked, onChange, hint }: { label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string }) {
  return (
    <label className="toggle-row">
      <span>
        {label}
        {hint && <span className="muted small block">{hint}</span>}
      </span>
      <input type="checkbox" role="switch" className="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  )
}
