import type { Catalog, Instrument } from '../types'
import { nameOf } from '../types'

export type ProfileData = {
  name: string
  age?: number
  district?: string
  photo_url: string
  instruments: Instrument[]
  level?: number
  level_description?: string
  genres: string[]
  goals: string[]
  looking_for?: string
  looking_for_instrument?: string
}

export function Avatar({ name, url, size = 88 }: { name: string; url?: string; size?: number }) {
  if (url) return <img className="avatar" src={url} alt="" width={size} height={size} />
  return (
    <div className="avatar avatar-empty" style={{ width: size, height: size, fontSize: size * 0.4 }} aria-hidden>
      {name.trim().charAt(0).toUpperCase() || '?'}
    </div>
  )
}

function years(n: number) {
  const d = n % 10
  const dd = n % 100
  const word = d === 1 && dd !== 11 ? 'год' : d >= 2 && d <= 4 && (dd < 12 || dd > 14) ? 'года' : 'лет'
  return `${n} ${word}`
}

export function lookingForText(catalog: Catalog, p: Pick<ProfileData, 'looking_for' | 'looking_for_instrument'>) {
  switch (p.looking_for) {
    case 'band':
      return 'Группу'
    case 'musician':
      return `Музыканта: ${nameOf(catalog.instruments, p.looking_for_instrument).toLowerCase()}`
    case 'jam':
      return 'Просто джем'
    default:
      return ''
  }
}

export function ProfileView({ user, catalog }: { user: ProfileData; catalog: Catalog }) {
  const main = user.instruments.find((i) => i.is_main)
  const meta = [user.age !== undefined ? years(user.age) : '', user.district ?? ''].filter(Boolean).join(' · ')

  return (
    <div className="profile">
      <div className="profile-head">
        <span className="avatar-ring"><Avatar name={user.name} url={user.photo_url} /></span>
        <div>
          <h1>{user.name}</h1>
          {meta && <p className="muted">{meta}</p>}
          {main && user.level !== undefined && (
            <p className="accent-text">{nameOf(catalog.instruments, main.id).toLowerCase()} · {user.level}/5</p>
          )}
        </div>
      </div>

      <section className="card">
        <h3>Инструменты</h3>
        <div className="chips">
          {user.instruments.map((i) => (
            <span key={i.id} className="chip chip-static">{i.is_main ? '★ ' : ''}{nameOf(catalog.instruments, i.id)}</span>
          ))}
        </div>
        {user.level_description && <p className="muted small">Уровень {user.level}: {user.level_description.toLowerCase()}</p>}
      </section>

      {user.looking_for && (
        <section className="card">
          <h3>Ищет</h3>
          <p>{lookingForText(catalog, user)}</p>
        </section>
      )}

      {user.genres.length > 0 && (
        <section className="card">
          <h3>Жанры</h3>
          <div className="chips">
            {user.genres.map((g) => <span key={g} className="chip chip-static">{nameOf(catalog.genres, g)}</span>)}
          </div>
        </section>
      )}

      {user.goals.length > 0 && (
        <section className="card">
          <h3>Цели</h3>
          <div className="chips">
            {user.goals.map((g) => <span key={g} className="chip chip-static">{nameOf(catalog.goals, g)}</span>)}
          </div>
        </section>
      )}
    </div>
  )
}
