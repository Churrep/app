import { useState } from 'react'
import { useNavigate } from 'react-router'
import { errorText } from '../api'
import { AvatarPicker } from '../components/AvatarPicker'
import { Header } from '../components/Header'
import { ChipPicker, InstrumentPicker, LevelPicker, LookingForPicker } from '../components/Pickers'
import { useMe } from '../session'

export function EditProfile() {
  const { me, catalog, patchMe } = useMe()
  const navigate = useNavigate()
  const [name, setName] = useState(me.name)
  const [district, setDistrict] = useState(me.district)
  const [instruments, setInstruments] = useState(me.instruments)
  const [level, setLevel] = useState(me.level)
  const [genres, setGenres] = useState(me.genres)
  const [goals, setGoals] = useState(me.goals)
  const [lookingFor, setLookingFor] = useState(me.looking_for ?? '')
  const [lfInstrument, setLfInstrument] = useState(me.looking_for_instrument ?? '')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const valid = name.trim() && instruments.length && genres.length && lookingFor && (lookingFor !== 'musician' || lfInstrument)

  async function save() {
    setBusy(true)
    setError('')
    try {
      await patchMe({ name: name.trim(), district: district.trim(), instruments, level, genres, goals, looking_for: lookingFor, looking_for_instrument: lfInstrument })
      navigate('/me', { replace: true })
    } catch (e) {
      setError(errorText(e))
      setBusy(false)
    }
  }

  return (
    <main className="screen">
      <Header title="Профиль" back />
      <div className="screen-body stack-lg">
        <AvatarPicker />
        <label className="field">
          <span className="label">Имя</span>
          <input className="input" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          <span className="label">Район Саратова</span>
          <input className="input" value={district} maxLength={50} placeholder="Например, Кировский" onChange={(e) => setDistrict(e.target.value)} />
        </label>
        {me.birth_date && (
          <div className="field">
            <span className="label">Дата рождения</span>
            <p className="muted">{new Date(me.birth_date + 'T00:00:00').toLocaleDateString('ru-RU')} — поменять нельзя</p>
          </div>
        )}
        <div className="field">
          <span className="label">Инструменты</span>
          <InstrumentPicker catalog={catalog} value={instruments} onChange={setInstruments} />
        </div>
        <div className="field">
          <span className="label">Уровень по основному инструменту</span>
          <LevelPicker catalog={catalog} value={level} onChange={setLevel} />
        </div>
        <div className="field">
          <span className="label">Жанры, до {catalog.max_genres}</span>
          <ChipPicker items={catalog.genres} value={genres} onChange={setGenres} max={catalog.max_genres} />
        </div>
        <div className="field">
          <span className="label">Цели</span>
          <ChipPicker items={catalog.goals} value={goals} onChange={setGoals} />
        </div>
        <div className="field">
          <span className="label">Что ищешь</span>
          <LookingForPicker catalog={catalog} value={lookingFor} instrument={lfInstrument}
            onChange={(lf, inst) => { setLookingFor(lf); setLfInstrument(inst) }} />
        </div>
      </div>
      <div className="bottom-actions">
        {error && <p className="error-text" role="alert">{error}</p>}
        <button className="btn btn-primary" disabled={!valid || busy} onClick={save}>{busy ? 'Сохраняем…' : 'Сохранить'}</button>
      </div>
    </main>
  )
}
