import { useState, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router'
import { errorText } from '../api'
import { AvatarPicker } from '../components/AvatarPicker'
import { InstallGuide } from '../components/InstallGuide'
import { BackIcon } from '../components/Icons'
import { ChipPicker, InstrumentPicker, LevelPicker, LookingForPicker } from '../components/Pickers'
import { useMe } from '../session'
import type { Instrument, MePatch } from '../types'
import { nameOf } from '../types'

// Порядок экранов. Первые шесть обязательны (их проверяет сервер), установка — нет.
// Репертуар и первое видео появятся вместе с этими функциями.
const STEPS = ['birth_date', 'name', 'instruments', 'level', 'genres', 'looking_for', 'install'] as const
type Step = (typeof STEPS)[number]

function firstStep(next?: string, complete?: boolean): number {
  if (complete) return STEPS.indexOf('install')
  const i = STEPS.indexOf(next as Step)
  return i >= 0 ? i : 0
}

function maxBirthDate() {
  const d = new Date()
  d.setFullYear(d.getFullYear() - 16)
  return d.toISOString().slice(0, 10)
}

function ageOn(birth: string) {
  const b = new Date(birth + 'T00:00:00')
  const now = new Date()
  let age = now.getFullYear() - b.getFullYear()
  if (now.getMonth() < b.getMonth() || (now.getMonth() === b.getMonth() && now.getDate() < b.getDate())) age--
  return age
}

export function Onboarding() {
  const { me, catalog, patchMe, logout } = useMe()
  const navigate = useNavigate()
  const [index, setIndex] = useState(() => firstStep(me.onboarding.next_step, me.onboarding.complete))
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  // Локальные значения полей; сохраняются на сервер при «Дальше».
  const [birth, setBirth] = useState(me.birth_date ?? '')
  const [consent, setConsent] = useState(Boolean(me.consent_at))
  const [name, setName] = useState(me.name)
  const [instruments, setInstruments] = useState<Instrument[]>(me.instruments)
  const [level, setLevel] = useState(me.level)
  const [genres, setGenres] = useState(me.genres)
  const [goals, setGoals] = useState(me.goals)
  const [lookingFor, setLookingFor] = useState(me.looking_for ?? '')
  const [lfInstrument, setLfInstrument] = useState(me.looking_for_instrument ?? '')

  const step = STEPS[index]
  const go = (i: number) => {
    setError('')
    setIndex(i)
  }

  async function save(patch: MePatch) {
    setBusy(true)
    setError('')
    try {
      await patchMe(patch)
      go(index + 1)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  const main = instruments.find((i) => i.is_main)
  let content: ReactNode
  let canNext = true
  let onNext = () => {}
  let nextLabel = 'Дальше'

  switch (step) {
    case 'birth_date': {
      const locked = Boolean(me.birth_date)
      const tooYoung = birth !== '' && ageOn(birth) < 16
      canNext = birth !== '' && consent && !tooYoung
      onNext = () => (locked && me.consent_at ? go(index + 1) : save({ birth_date: birth, consent: true }))
      content = (
        <Question title="Когда у тебя день рождения?" hint="Приложение для музыкантов от 16 лет. Дату потом не поменять.">
          <input className="input" type="date" value={birth} max={maxBirthDate()} min="1925-01-01" disabled={locked}
            onChange={(e) => setBirth(e.target.value)} aria-label="Дата рождения" />
          {tooYoung && <p className="error-text">Приложение доступно с 16 лет</p>}
          <label className="checkbox">
            <input type="checkbox" checked={consent} disabled={Boolean(me.consent_at)} onChange={(e) => setConsent(e.target.checked)} />
            <span>Соглашаюсь на <Link to="/privacy">обработку персональных данных</Link></span>
          </label>
        </Question>
      )
      break
    }
    case 'name':
      canNext = name.trim().length > 0
      onNext = () => save({ name: name.trim() })
      content = (
        <Question title="Как тебя зовут?" hint="Так тебя увидят другие музыканты. Фото можно добавить позже.">
          <input className="input" value={name} maxLength={40} autoComplete="given-name" placeholder="Имя"
            onChange={(e) => setName(e.target.value)} autoFocus aria-label="Имя" />
          <AvatarPicker />
        </Question>
      )
      break
    case 'instruments':
      canNext = instruments.length > 0
      onNext = () => save({ instruments })
      content = (
        <Question title="На чём играешь?" hint="Можно несколько. Первый выбранный — основной, его можно поменять.">
          <InstrumentPicker catalog={catalog} value={instruments} onChange={setInstruments} />
        </Question>
      )
      break
    case 'level':
      canNext = level !== undefined
      onNext = () => save({ level })
      content = (
        <Question title={`Как ты играешь${main ? ': ' + nameOf(catalog.instruments, main.id).toLowerCase() : ''}?`} hint="Честно — так проще найти своих.">
          <LevelPicker catalog={catalog} value={level} onChange={setLevel} />
        </Question>
      )
      break
    case 'genres':
      canNext = genres.length > 0
      onNext = () => save({ genres, goals })
      content = (
        <Question title="Что играешь?" hint={`Жанры, до ${catalog.max_genres}: выбрано ${genres.length}`}>
          <ChipPicker items={catalog.genres} value={genres} onChange={setGenres} max={catalog.max_genres} />
          <div className="field">
            <span className="label">Зачем играешь? Можно пропустить</span>
            <ChipPicker items={catalog.goals} value={goals} onChange={setGoals} />
          </div>
        </Question>
      )
      break
    case 'looking_for':
      canNext = lookingFor !== '' && (lookingFor !== 'musician' || lfInstrument !== '')
      onNext = () => save({ looking_for: lookingFor, looking_for_instrument: lfInstrument })
      content = (
        <Question title="Что ищешь?">
          <LookingForPicker catalog={catalog} value={lookingFor} instrument={lfInstrument}
            onChange={(lf, inst) => { setLookingFor(lf); setLfInstrument(inst) }} />
        </Question>
      )
      break
    case 'install':
      nextLabel = 'Готово'
      onNext = () => navigate('/feed', { replace: true })
      content = (
        <Question title="Поставь приложение на экран" hint="Его можно будет открывать с главного экрана.">
          <InstallGuide />
        </Question>
      )
      break
  }

  return (
    <main className="screen">
      <header className="header">
        {index > 0 && step !== 'install' ? (
          <button className="icon-btn" onClick={() => go(index - 1)} aria-label="Назад"><BackIcon /></button>
        ) : (
          <span className="icon-btn-space" />
        )}
        <div className="progress" role="progressbar" aria-valuemin={1} aria-valuemax={STEPS.length} aria-valuenow={index + 1}>
          <div style={{ width: `${((index + 1) / STEPS.length) * 100}%` }} />
        </div>
        {index === 0 ? (
          <button className="btn-link" onClick={() => logout()}>Выйти</button>
        ) : (
          <span className="icon-btn-space" />
        )}
      </header>

      <div className="screen-body">{content}</div>

      <div className="bottom-actions">
        {error && <p className="error-text" role="alert">{error}</p>}
        {step === 'install' && (
          <button className="btn btn-ghost" onClick={onNext}>Позже</button>
        )}
        <button className="btn btn-primary" disabled={!canNext || busy} onClick={onNext}>
          {busy ? 'Сохраняем…' : nextLabel}
        </button>
      </div>
    </main>
  )
}

function Question({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <div className="stack">
      <h1 className="title">{title}</h1>
      {hint && <p className="muted">{hint}</p>}
      {children}
    </div>
  )
}
