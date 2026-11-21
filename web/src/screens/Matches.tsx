import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { api, errorText } from '../api'
import { Header } from '../components/Header'
import { MatchOverlay } from '../components/LikeBits'
import { Avatar } from '../components/ProfileView'
import { Empty, ErrorState, Loading } from '../components/States'
import { AudioCover, instrumentName } from '../components/VideoBits'
import { refreshIncoming, useIncomingCount } from '../lib/incoming'
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

export function Matches() {
  const { catalog } = useMe()
  const incoming = useIncomingCount()
  const { data, error, reload } = useLoad<{ items: Match[] }>('/matches')

  return (
    <main className="screen">
      <Header title="Совпадения" />
      <div className="screen-body">
        <Link to="/likes" className="card likes-entry">
          <strong>Тебя лайкнули · {incoming}</strong>
          <span className="small muted">{incoming ? 'Посмотри, кто хочет с тобой поиграть' : 'Пока никого — запиши видео, чтобы тебя заметили'}</span>
        </Link>
        {error ? <ErrorState error={error} onRetry={reload} /> : !data ? <Loading /> : data.items.length === 0 ? (
          <Empty title="Совпадений пока нет" text="Когда кто-то захочет с тобой поиграть и ты ответишь тем же, здесь появится его профиль." />
        ) : (
          <ul className="match-list">
            {data.items.map((m) => (
              <li key={m.id}>
                <Link to={`/users/${m.other.id}`} className="match-row">
                  <Avatar name={m.other.name} url={m.other.photo_url} size={52} />
                  <span className="match-row-main">
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
  const [match, setMatch] = useState<IncomingLike['author'] | null>(null)

  async function act(item: IncomingLike, kind: 'like' | 'dismiss') {
    setBusy(item.author.id)
    setActionError('')
    try {
      if (kind === 'like') {
        const r = await api<LikeResult>('/likes', { method: 'POST', body: { to_user_id: item.author.id } })
        if (r.matched) setMatch(item.author)
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
      {match && <MatchOverlay other={match} onClose={() => setMatch(null)} />}
    </main>
  )
}
