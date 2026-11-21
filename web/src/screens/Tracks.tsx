import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import { api, errorText, upload } from '../api'
import { AudioPlayer } from '../components/AudioPlayer'
import { Header } from '../components/Header'
import { ChipPicker } from '../components/Pickers'
import { Avatar } from '../components/ProfileView'
import { Empty, ErrorState, Loading } from '../components/States'
import { useMe } from '../session'
import type { Band, Catalog, Spot, SpotResponse } from '../types'
import { fmtDate, nameOf } from '../types'

function useLoad<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!path) return
    let alive = true
    setError(null)
    api<T>(path).then((d) => alive && setData(d)).catch((e) => alive && setError(e))
    return () => {
      alive = false
    }
  }, [path, tick])
  return { data, error, reload: useCallback(() => setTick((n) => n + 1), []) }
}

const plural = (n: number, one: string, few: string, many: string) => {
  const d = n % 10
  const dd = n % 100
  return `${n} ${d === 1 && dd !== 11 ? one : d >= 2 && d <= 4 && (dd < 12 || dd > 14) ? few : many}`
}

const spotStatus: Record<Spot['status'], string> = {
  processing: 'Обрабатываем минус…',
  open: '',
  expired: 'Срок вышел',
  closed: 'Место закрыто',
  failed: 'Минус не обработался',
}

export const responseText: Record<SpotResponse['status'], string> = {
  processing: 'Сводим твою партию с минусом…',
  sent: 'Отправлено. Группа послушает и ответит',
  invited: 'Группа зовёт на встречу!',
  rejected: 'Группа выбрала другого. Твоя запись осталась в «Откликах»',
  failed: 'Не получилось обработать запись. Запиши ещё раз',
}

export function SpotCard({ spot, catalog }: { spot: Spot; catalog: Catalog }) {
  const meta = [nameOf(catalog.genres, spot.genre_id), `${spot.bpm} BPM`, spot.key].filter(Boolean).join(' · ')
  const counts = [plural(spot.responses_count, 'отклик', 'отклика', 'откликов'), spot.deadline ? `до ${fmtDate(spot.deadline)}` : ''].filter(Boolean).join(' · ')
  return (
    <Link to={`/tracks/${spot.id}`} className="card spot-card">
      <span className="small muted">{spot.band.name}</span>
      <strong className="spot-need">Нужен {nameOf(catalog.instruments, spot.instrument_id).toLowerCase()}</strong>
      {spot.song_title && <span>«{spot.song_title}»</span>}
      <span className="small muted">{meta}</span>
      <span className="small">{spotStatus[spot.status] || counts}</span>
      {spot.my_response && <span className="small accent-text">{responseText[spot.my_response.status]}</span>}
    </Link>
  )
}

type Tab = 'open' | 'responses' | 'mine'

export function Tracks() {
  const [params, setParams] = useSearchParams()
  const tab = (params.get('tab') as Tab) || 'open'
  return (
    <main className="screen">
      <Header title="Дорожки" />
      <div className="segmented three" role="tablist">
        {([['open', 'Места'], ['responses', 'Отклики'], ['mine', 'Мои места']] as const).map(([id, label]) => (
          <button key={id} role="tab" aria-checked={tab === id} onClick={() => setParams({ tab: id }, { replace: true })}>{label}</button>
        ))}
      </div>
      <div className="screen-body">
        {tab === 'open' && <OpenSpots />}
        {tab === 'responses' && <MyResponses />}
        {tab === 'mine' && <MySpots />}
      </div>
    </main>
  )
}

function OpenSpots() {
  const { catalog, me } = useMe()
  const [only, setOnly] = useState('')
  const { data, error, reload } = useLoad<{ items: Spot[] }>('/spots' + (only ? `?instrument=${only}` : ''))
  const filters = [{ id: '', name: 'Все' }, ...me.instruments.map((i) => ({ id: i.id, name: nameOf(catalog.instruments, i.id) }))]
  return (
    <div className="stack">
      <div className="chips">
        {filters.map((f) => <button key={f.id} className="chip" aria-pressed={only === f.id} onClick={() => setOnly(f.id)}>{f.name}</button>)}
      </div>
      {error ? <ErrorState error={error} onRetry={reload} /> : !data ? <Loading /> : data.items.length === 0 ? (
        <Empty title="Пока нет мест" text="Здесь появятся песни групп, которым не хватает музыканта. Сначала — под твои инструменты." />
      ) : data.items.map((s) => <SpotCard key={s.id} spot={s} catalog={catalog} />)}
    </div>
  )
}

function MyResponses() {
  const { catalog } = useMe()
  const { data, error, reload } = useLoad<{ items: SpotResponse[] }>('/me/responses')
  if (error) return <ErrorState error={error} onRetry={reload} />
  if (!data) return <Loading />
  if (!data.items.length) return <Empty title="Откликов пока нет" text="Найди место во вкладке «Места» и запиши свою партию поверх минуса." />
  return (
    <div className="stack">
      {data.items.map((r) => (
        <div key={r.id} className="card">
          {r.spot && <SpotCard spot={r.spot} catalog={catalog} />}
          <p className={r.status === 'invited' ? 'accent-text' : 'muted'}>{r.status === 'failed' && r.error ? r.error : responseText[r.status]}</p>
          {r.status !== 'processing' && r.status !== 'failed' && r.mix_url && (
            <AudioPlayer src={r.mix_url} peaks={r.track_peaks} durationMs={r.track_duration_ms} label="Твоя партия с минусом" />
          )}
        </div>
      ))}
    </div>
  )
}

function MySpots() {
  const { catalog } = useMe()
  const bands = useLoad<{ items: Band[] }>('/me/bands')
  const spots = useLoad<{ items: Spot[] }>('/spots?scope=mine')
  const [creating, setCreating] = useState(false)

  if (bands.error || spots.error) return <ErrorState error={bands.error ?? spots.error} onRetry={() => { bands.reload(); spots.reload() }} />
  if (!bands.data || !spots.data) return <Loading />

  return (
    <div className="stack">
      {bands.data.items.length === 0 && !creating && (
        <Empty title="У тебя нет группы" text="Создай группу, чтобы выложить песню без одной партии и найти музыканта.">
          <button className="btn btn-primary" onClick={() => setCreating(true)}>Создать группу</button>
        </Empty>
      )}
      {creating && <CreateBand onDone={() => { setCreating(false); bands.reload() }} onCancel={() => setCreating(false)} />}
      {bands.data.items.map((b) => (
        <section key={b.id} className="card">
          <h3>{b.name}</h3>
          <Link className="btn btn-primary" to={`/tracks/new?band=${b.id}`}>+ Новое место</Link>
          {spots.data!.items.filter((s) => s.band.id === b.id).map((s) => <SpotCard key={s.id} spot={s} catalog={catalog} />)}
        </section>
      ))}
      {bands.data.items.length > 0 && !creating && <button className="btn btn-ghost" onClick={() => setCreating(true)}>Создать ещё группу</button>}
    </div>
  )
}

function CreateBand({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const { catalog } = useMe()
  const [name, setName] = useState('')
  const [genres, setGenres] = useState<string[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  async function save() {
    setBusy(true)
    setError('')
    try {
      await api('/bands', { method: 'POST', body: { name, genres } })
      onDone()
    } catch (e) {
      setError(errorText(e))
      setBusy(false)
    }
  }
  return (
    <section className="card">
      <h3>Новая группа</h3>
      <input className="input" value={name} maxLength={60} placeholder="Название" onChange={(e) => setName(e.target.value)} autoFocus />
      <ChipPicker items={catalog.genres} value={genres} onChange={setGenres} max={catalog.max_genres} />
      {error && <p className="error-text">{error}</p>}
      <button className="btn btn-primary" disabled={!name.trim() || busy} onClick={save}>Создать</button>
      <button className="btn btn-ghost" onClick={onCancel}>Отмена</button>
    </section>
  )
}

// ---------- Новое место ----------

export function NewSpot() {
  const { catalog } = useMe()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const bandID = params.get('band') ?? ''
  const [file, setFile] = useState<File | null>(null)
  const [fileError, setFileError] = useState('')
  const [instrument, setInstrument] = useState('')
  const [title, setTitle] = useState('')
  const [bpm, setBpm] = useState('')
  const [key, setKey] = useState('')
  const [genre, setGenre] = useState('')
  const [description, setDescription] = useState('')
  const [deadline, setDeadline] = useState('')
  const [own, setOwn] = useState(false)
  const [progress, setProgress] = useState(-1)
  const [error, setError] = useState('')

  async function pick(f: File | undefined) {
    setFileError('')
    setFile(null)
    if (!f) return
    if (f.size > 50 * 1024 * 1024) return setFileError('Файл больше 50 МБ')
    const dur = await new Promise<number>((resolve) => {
      const a = new Audio()
      a.preload = 'metadata'
      a.onloadedmetadata = () => resolve(a.duration)
      a.onerror = () => resolve(NaN)
      a.src = URL.createObjectURL(f)
    })
    if (dur > 5 * 60 + 1) return setFileError('Минус длиннее 5 минут')
    setFile(f)
  }

  const valid = file && instrument && genre && Number(bpm) >= 30 && Number(bpm) <= 300 && own

  async function save() {
    if (!file) return
    setError('')
    setProgress(0)
    try {
      const spot = await upload<Spot>('/spots', {
        band_id: bandID, instrument_id: instrument, song_title: title.trim(), bpm, key: key.trim(), genre_id: genre,
        description: description.trim(), deadline, own_song: String(own),
      }, file, file.name, setProgress)
      navigate(`/tracks/${spot.id}`, { replace: true })
    } catch (e) {
      setError(errorText(e))
      setProgress(-1)
    }
  }

  const today = new Date().toISOString().slice(0, 10)
  return (
    <main className="screen">
      <Header title="Новое место" back />
      <div className="screen-body stack-lg">
        <label className="field">
          <span className="label">Минус: mp3, m4a или wav, до 5 минут и 50 МБ</span>
          <input className="input file-input" type="file" accept=".mp3,.m4a,.wav,audio/mpeg,audio/mp4,audio/wav,audio/x-wav" onChange={(e) => pick(e.target.files?.[0])} />
          {fileError && <span className="error-text">{fileError}</span>}
        </label>
        <div className="field">
          <span className="label">Кого не хватает</span>
          <ChipPicker items={catalog.instruments} value={instrument ? [instrument] : []} onChange={(v) => setInstrument(v[v.length - 1] ?? '')} />
        </div>
        <label className="field">
          <span className="label">Название песни</span>
          <input className="input" value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <div className="row">
          <label className="field">
            <span className="label">Темп, BPM</span>
            <input className="input" inputMode="numeric" value={bpm} onChange={(e) => setBpm(e.target.value.replace(/\D/g, '').slice(0, 3))} placeholder="120" />
          </label>
          <label className="field">
            <span className="label">Тональность</span>
            <input className="input" value={key} maxLength={8} onChange={(e) => setKey(e.target.value)} placeholder="Am" />
          </label>
        </div>
        <label className="field">
          <span className="label">Жанр</span>
          <select className="input" value={genre} onChange={(e) => setGenre(e.target.value)}>
            <option value="">Выбери</option>
            {catalog.genres.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
        </label>
        <label className="field">
          <span className="label">Пара слов о вас, до 300 символов</span>
          <textarea className="input textarea" value={description} maxLength={300} onChange={(e) => setDescription(e.target.value)}
            placeholder="Ищем басиста, репетируем по четвергам" />
        </label>
        <label className="field">
          <span className="label">Принимаем отклики до</span>
          <input className="input" type="date" value={deadline} min={today} onChange={(e) => setDeadline(e.target.value)} />
        </label>
        <label className="checkbox">
          <input type="checkbox" checked={own} onChange={(e) => setOwn(e.target.checked)} />
          <span>Это наша собственная песня. Каверы выкладывать нельзя</span>
        </label>
      </div>
      <div className="bottom-actions">
        {error && <p className="error-text" role="alert">{error}</p>}
        {progress >= 0 && <div className="progress"><div style={{ width: `${progress * 100}%` }} /></div>}
        <button className="btn btn-primary" disabled={!valid || progress >= 0} onClick={save}>
          {progress >= 0 ? `Загружаем… ${Math.round(progress * 100)}%` : 'Опубликовать'}
        </button>
      </div>
    </main>
  )
}

// ---------- Карточка места ----------

export function SpotScreen() {
  const { id = '' } = useParams()
  const { catalog } = useMe()
  const { data: spot, error, reload } = useLoad<Spot>(`/spots/${encodeURIComponent(id)}`)

  // Пока минус или мой отклик обрабатываются — обновляем.
  const waiting = spot?.status === 'processing' || spot?.my_response?.status === 'processing'
  useEffect(() => {
    if (!waiting) return
    const t = setTimeout(reload, 4000)
    return () => clearTimeout(t)
  }, [waiting, spot, reload])

  let body
  if (error) body = <ErrorState error={error} onRetry={reload} />
  else if (!spot) body = <Loading />
  else {
    const canRecord = !spot.is_member && spot.status === 'open' && spot.my_response?.status !== 'invited' && spot.my_response?.status !== 'rejected'
    body = (
      <>
        <p className="muted">{spot.band.name}</p>
        <h1 className="title">Нужен {nameOf(catalog.instruments, spot.instrument_id).toLowerCase()}</h1>
        {spot.song_title && <p>«{spot.song_title}»</p>}
        <p className="muted">{[nameOf(catalog.genres, spot.genre_id), `${spot.bpm} BPM`, spot.key].filter(Boolean).join(' · ')}</p>
        {spot.description && <p>{spot.description}</p>}
        <p className="small">
          {plural(spot.responses_count, 'отклик', 'отклика', 'откликов')}
          {spot.deadline ? ` · до ${fmtDate(spot.deadline)}` : ''}
        </p>
        {spotStatus[spot.status] && <p className="note">{spot.status === 'failed' && spot.error ? spot.error : spotStatus[spot.status]}</p>}
        {spot.backing_url && <AudioPlayer src={spot.backing_url} peaks={spot.backing_peaks} durationMs={spot.backing_duration_ms} label="Минус" />}
        {spot.my_response && <p className="note">{responseText[spot.my_response.status]}</p>}
        {canRecord && (
          <Link className="btn btn-primary" to={`/tracks/${spot.id}/record`}>
            {spot.my_response ? 'Перезаписать партию' : 'Записать свою партию'}
          </Link>
        )}
        {spot.is_member && <BandResponses spot={spot} onChanged={reload} />}
      </>
    )
  }

  return (
    <main className="screen">
      <Header back />
      <div className="screen-body">{body}</div>
    </main>
  )
}

function BandResponses({ spot, onChanged }: { spot: Spot; onChanged: () => void }) {
  const { catalog } = useMe()
  const { data, error, reload } = useLoad<{ items: SpotResponse[] }>(`/spots/${spot.id}/responses`)
  const [solo, setSolo] = useState(false)
  const [busy, setBusy] = useState('')
  const [actionError, setActionError] = useState('')

  async function setStatus(id: string, status: 'invited' | 'rejected') {
    setBusy(id)
    setActionError('')
    try {
      await api(`/responses/${id}`, { method: 'PATCH', body: { status } })
      reload()
    } catch (e) {
      setActionError(errorText(e))
    } finally {
      setBusy('')
    }
  }

  async function close() {
    if (!confirm('Закрыть место? Новые отклики перестанут приниматься.')) return
    try {
      await api(`/spots/${spot.id}/close`, { method: 'POST' })
      onChanged()
    } catch (e) {
      setActionError(errorText(e))
    }
  }

  if (error) return <ErrorState error={error} onRetry={reload} />
  if (!data) return <Loading />
  return (
    <section className="stack">
      <h3 className="section-title">Отклики</h3>
      {data.items.length === 0 && <p className="muted">Пока никто не откликнулся.</p>}
      {data.items.length > 0 && (
        <div className="segmented" role="radiogroup">
          <button role="radio" aria-checked={!solo} onClick={() => setSolo(false)}>С минусом</button>
          <button role="radio" aria-checked={solo} onClick={() => setSolo(true)}>Только партия</button>
        </div>
      )}
      {actionError && <p className="error-text">{actionError}</p>}
      {data.items.map((r) => r.author && (
        <div key={r.id} className="card">
          <Link to={`/users/${r.author.id}`} className="author-row">
            <Avatar name={r.author.name} url={r.author.photo_url} size={44} />
            <span>
              <strong>{r.author.name}</strong>
              <span className="block small muted">
                {nameOf(catalog.instruments, r.author.main_instrument).toLowerCase()} · {r.author.level}/5 · {r.author.genres.map((g) => nameOf(catalog.genres, g)).join(', ')}
              </span>
            </span>
          </Link>
          <AudioPlayer key={solo ? 'solo' : 'mix'} src={solo ? r.track_url : r.mix_url} peaks={r.track_peaks} durationMs={r.track_duration_ms} />
          {r.status === 'sent' ? (
            <div className="row">
              <button className="btn btn-primary" disabled={busy === r.id} onClick={() => setStatus(r.id, 'invited')}>Позвать на встречу</button>
              <button className="btn btn-secondary" disabled={busy === r.id} onClick={() => setStatus(r.id, 'rejected')}>Не подходит</button>
            </div>
          ) : (
            <p className="small muted">{r.status === 'invited' ? 'Вы позвали на встречу' : 'Не подошёл'}</p>
          )}
        </div>
      ))}
      {(spot.status === 'open' || spot.status === 'expired') && <button className="btn btn-ghost" onClick={close}>Закрыть место</button>}
    </section>
  )
}
