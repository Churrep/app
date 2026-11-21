import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import { api, errorText } from '../api'
import { Header } from '../components/Header'
import { BackIcon } from '../components/Icons'
import { MatchOverlay } from '../components/LikeBits'
import { Avatar } from '../components/ProfileView'
import { Empty, ErrorState, Loading } from '../components/States'
import { AudioCover, instrumentName } from '../components/VideoBits'
import { refreshIncoming, useIncomingCount } from '../lib/incoming'
import { disablePush, enablePush, pushState, type PushState } from '../lib/notify'
import { useMe } from '../session'
import type { IncomingLike, LikeResult, Match } from '../types'
import { fmtAgo, nameOf } from '../types'

function useLoad<T>(path: string) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let alive = true
    setError(null)
    api<T>(path).then((d) => alive && setData(d)).catch((e) => alive && setError(e))
    return () => {
      alive = false
    }
  }, [path, tick])
  return { data, error, reload: useCallback(() => setTick((n) => n + 1), []) }
}

// Карточка «Включи уведомления». На iPhone — подсказка поставить приложение на экран.
export function PushCard({ compact }: { compact?: boolean }) {
  const [state, setState] = useState<PushState | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    pushState().then(setState)
  }, [])
  if (!state || state === 'unsupported') return null
  if (compact && state === 'on') return null

  async function toggle() {
    setError('')
    try {
      setState(state === 'on' ? await disablePush() : await enablePush())
    } catch (e) {
      setError(errorText(e))
    }
  }

  return (
    <section className="card">
      <h3>Уведомления</h3>
      {state === 'need-install' && <p className="small">На iPhone уведомления приходят, только если приложение добавлено на экран «Домой». Поставь его через «Поделиться» → «На экран „Домой“» и открой оттуда.</p>}
      {state === 'denied' && <p className="small">Уведомления запрещены в браузере. Разреши их в настройках сайта и обнови страницу.</p>}
      {(state === 'off' || state === 'on') && (
        <>
          <p className="small">{state === 'on' ? 'Включены: сообщим, когда кто-то захочет с тобой поиграть.' : 'Узнавай сразу, когда кто-то хочет с тобой поиграть.'}</p>
          <button className={state === 'on' ? 'btn btn-secondary' : 'btn btn-primary'} onClick={toggle}>
            {state === 'on' ? 'Выключить уведомления' : 'Включить уведомления'}
          </button>
        </>
      )}
      {error && <p className="error-text">{error}</p>}
    </section>
  )
}

export function Chats() {
  const { catalog } = useMe()
  const incoming = useIncomingCount()
  const { data, error, reload } = useLoad<{ items: Match[] }>('/matches')

  return (
    <main className="screen">
      <Header title="Чаты" />
      <div className="screen-body">
        <Link to="/likes" className="card likes-entry">
          <strong>Тебя лайкнули · {incoming}</strong>
          <span className="small muted">{incoming ? 'Посмотри, кто хочет с тобой поиграть' : 'Пока никого — запиши видео, чтобы тебя заметили'}</span>
        </Link>
        <PushCard compact />
        {error ? <ErrorState error={error} onRetry={reload} /> : !data ? <Loading /> : data.items.length === 0 ? (
          <Empty title="Совпадений пока нет" text="Когда кто-то захочет с тобой поиграть и ты ответишь тем же, здесь откроется чат." />
        ) : (
          <ul className="chat-list">
            {data.items.map((m) => (
              <li key={m.id}>
                <Link to={`/chats/${m.id}`} className="chat-row">
                  <Avatar name={m.other.name} url={m.other.photo_url} size={52} />
                  <span className="chat-row-main">
                    <strong>{m.other.name}</strong>
                    <span className="small muted">{instrumentName(catalog, m.other.main_instrument)} · {m.other.level}/5 · совпадение {fmtAgo(m.created_at)}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  )
}

export function Likes() {
  const { catalog } = useMe()
  const navigate = useNavigate()
  const { data, error, reload } = useLoad<{ items: IncomingLike[] }>('/likes/incoming')
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState('')
  const [actionError, setActionError] = useState('')
  const [match, setMatch] = useState<{ id: string; other: IncomingLike['author'] } | null>(null)

  async function act(item: IncomingLike, kind: 'like' | 'dismiss') {
    setBusy(item.author.id)
    setActionError('')
    try {
      if (kind === 'like') {
        const r = await api<LikeResult>('/likes', { method: 'POST', body: { to_user_id: item.author.id } })
        if (r.matched) setMatch({ id: r.match_id, other: item.author })
      } else {
        await api(`/likes/incoming/${item.author.id}/dismiss`, { method: 'POST' })
      }
      setHidden((h) => new Set(h).add(item.author.id))
      refreshIncoming()
    } catch (e) {
      setActionError(errorText(e))
    } finally {
      setBusy('')
    }
  }

  const items = data?.items.filter((i) => !hidden.has(i.author.id)) ?? []
  return (
    <main className="screen">
      <Header title="Тебя лайкнули" back />
      <div className="screen-body">
        {actionError && <p className="error-text">{actionError}</p>}
        {error ? <ErrorState error={error} onRetry={reload} /> : !data ? <Loading /> : items.length === 0 ? (
          <Empty title="Пока никого" text="Когда кто-то нажмёт «Хочу поиграть» на твоём видео, он появится здесь." />
        ) : items.map((it) => {
          const inst = instrumentName(catalog, it.author.main_instrument)
          return (
            <div key={it.author.id} className="card like-card">
              <button className="like-card-body" onClick={() => navigate(`/users/${it.author.id}`)}>
                <span className="like-preview">
                  {it.preview?.type === 'video' && <img src={it.preview.poster_url} alt="" />}
                  {it.preview?.type === 'audio' && <AudioCover peaks={it.preview.peaks} name={it.author.name} instrument={inst} compact />}
                  {!it.preview && <Avatar name={it.author.name} url={it.author.photo_url} size={64} />}
                </span>
                <span className="like-info">
                  <strong>{it.author.name}</strong>
                  <span className="small">{inst} · {it.author.level}/5</span>
                  <span className="small muted">{it.author.genres.map((g) => nameOf(catalog.genres, g)).join(', ')}</span>
                  <span className="small muted">{fmtAgo(it.liked_at)}</span>
                </span>
              </button>
              <div className="row">
                <button className="btn btn-primary" disabled={busy === it.author.id} onClick={() => act(it, 'like')}>Хочу поиграть в ответ</button>
                <button className="btn btn-secondary" disabled={busy === it.author.id} onClick={() => act(it, 'dismiss')}>Не сейчас</button>
              </div>
            </div>
          )
        })}
      </div>
      {match && <MatchOverlay other={match.other} matchId={match.id} onClose={() => setMatch(null)} />}
    </main>
  )
}

// Чат после совпадения. Переписка появится в следующем обновлении — пока муляж без отправки.
export function ChatMock() {
  const { id = '' } = useParams()
  const [params] = useSearchParams()
  const { catalog } = useMe()
  const { data: m, error, reload } = useLoad<Match>(`/matches/${encodeURIComponent(id)}`)

  if (error) return <main className="screen"><Header back /><ErrorState error={error} onRetry={reload} /></main>
  if (!m) return <main className="screen"><Header back /><Loading /></main>

  const draft = params.get('jam') ? `Привет! Давай сыграем вместе? Можно встретиться на репточке — посмотри карту в приложении.` : ''
  return (
    <main className="screen chat-screen">
      <header className="header">
        <button className="icon-btn" onClick={() => history.back()} aria-label="Назад"><BackIcon /></button>
        <Link to={`/users/${m.other.id}`} className="chat-head">
          <Avatar name={m.other.name} url={m.other.photo_url} size={40} />
          <span>
            <strong>{m.other.name}</strong>
            <span className="block small muted">{instrumentName(catalog, m.other.main_instrument)} · {m.other.level}/5</span>
          </span>
        </Link>
      </header>
      <div className="chat-body">
        <p className="chat-system">Совпадение {fmtAgo(m.created_at)}. Вы оба хотите поиграть вместе — обсудите, что сыграть и где встретиться.</p>
        {m.dm_restricted && <p className="chat-system">Личные сообщения с этим человеком недоступны</p>}
      </div>
      <div className="chat-input">
        <textarea className="input" rows={1} disabled defaultValue={draft} placeholder="Сообщение" aria-label="Сообщение" />
        <button className="btn btn-primary" disabled aria-label="Отправить">➤</button>
      </div>
      <p className="small muted chat-note">Отправка сообщений появится в следующем обновлении</p>
    </main>
  )
}
