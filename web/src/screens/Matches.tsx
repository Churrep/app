import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { api, errorText } from '../api'
import { Header } from '../components/Header'
import { CassetteArt } from '../components/Icons'
import { MatchOverlay } from '../components/LikeBits'
import { Avatar } from '../components/ProfileView'
import { Empty, ErrorState, Loading } from '../components/States'
import { AudioCover, instrumentName } from '../components/VideoBits'
import { refreshIncoming, useIncomingCount } from '../lib/incoming'
import { useMe } from '../session'
import type { Author, IncomingInvite, IncomingLike, InviteResult, Match } from '../types'
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

type Tab = 'matches' | 'invites' | 'likes'

// Совпадения: три отдельных списка — взаимные, входящие «Хочу поиграть» и лайки моих записей.
export function Matches() {
  const [params, setParams] = useSearchParams()
  const tab = (params.get('tab') as Tab) || 'matches'
  const incoming = useIncomingCount()
  const tabs: [Tab, string][] = [['matches', 'Совпадения'], ['invites', `Хотят поиграть${incoming ? ` · ${incoming}` : ''}`], ['likes', 'Лайки']]
  return (
    <main className="screen">
      <Header title="Совпадения" />
      <div className="segmented three" role="tablist">
        {tabs.map(([id, label]) => (
          <button key={id} role="tab" aria-checked={tab === id} onClick={() => setParams({ tab: id }, { replace: true })}>{label}</button>
        ))}
      </div>
      <div className="screen-body">
        {tab === 'matches' && <MatchList />}
        {tab === 'invites' && <Invites />}
        {tab === 'likes' && <Likes />}
      </div>
    </main>
  )
}

function AuthorLine({ author, extra }: { author: Author; extra?: string }) {
  const { catalog } = useMe()
  return (
    <span className="small muted">
      {instrumentName(catalog, author.main_instrument)} · {author.level}/5{extra ? ` · ${extra}` : ''}
    </span>
  )
}

function MatchList() {
  const { data, error, reload } = useLoad<{ items: Match[] }>('/matches')
  if (error) return <ErrorState error={error} onRetry={reload} />
  if (!data) return <Loading />
  if (!data.items.length) {
    return <Empty art={<CassetteArt />} title="Совпадений пока нет" text="Нажми «Хочу поиграть» в профиле музыканта. Когда он ответит тем же, здесь появится его профиль." />
  }
  return (
    <ul className="match-list">
      {data.items.map((m) => (
        <li key={m.other.id}>
          <Link to={`/users/${m.other.id}`} className="card match-row">
            <Avatar name={m.other.name} url={m.other.photo_url} size={52} />
            <span className="match-row-main">
              <strong>{m.other.name}</strong>
              <AuthorLine author={m.other} extra={`совпадение ${fmtAgo(m.created_at)}`} />
            </span>
          </Link>
        </li>
      ))}
    </ul>
  )
}

// Invites — входящие «Хочу поиграть»: можно ответить взаимностью или скрыть («Не сейчас»).
function Invites() {
  const { catalog } = useMe()
  const navigate = useNavigate()
  const { data, error, reload } = useLoad<{ items: IncomingInvite[] }>('/invites/incoming')
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState('')
  const [actionError, setActionError] = useState('')
  const [match, setMatch] = useState<Author | null>(null)

  async function act(item: IncomingInvite, kind: 'invite' | 'dismiss') {
    setBusy(item.author.id)
    setActionError('')
    try {
      if (kind === 'invite') {
        const r = await api<InviteResult>('/invites', { method: 'POST', body: { to_user_id: item.author.id } })
        if (r.mutual) setMatch(item.author)
      } else {
        await api(`/invites/incoming/${item.author.id}/dismiss`, { method: 'POST' })
      }
      setHidden((h) => new Set(h).add(item.author.id))
      refreshIncoming()
    } catch (e) {
      setActionError(errorText(e))
    } finally {
      setBusy('')
    }
  }

  if (error) return <ErrorState error={error} onRetry={reload} />
  if (!data) return <Loading />
  const items = data.items.filter((i) => !hidden.has(i.author.id))
  return (
    <>
      {actionError && <p className="error-text">{actionError}</p>}
      {items.length === 0 ? (
        <Empty art={<CassetteArt />} title="Пока никого" text="Когда кто-то нажмёт «Хочу поиграть» в твоём профиле, он появится здесь. Запиши видео, чтобы тебя заметили." />
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
                <span className="small muted">{fmtAgo(it.invited_at)}</span>
              </span>
            </button>
            <div className="row">
              <button className="btn btn-primary" disabled={busy === it.author.id} onClick={() => act(it, 'invite')}>Хочу поиграть в ответ</button>
              <button className="btn btn-secondary" disabled={busy === it.author.id} onClick={() => act(it, 'dismiss')}>Не сейчас</button>
            </div>
          </div>
        )
      })}
      {match && <MatchOverlay other={match} onClose={() => setMatch(null)} />}
    </>
  )
}

// Likes — кому понравились мои записи. Видно только мне; на знакомства не влияет.
function Likes() {
  const { catalog, me } = useMe()
  const { data, error, reload } = useLoad<{ items: IncomingLike[] }>('/likes/incoming')
  if (error) return <ErrorState error={error} onRetry={reload} />
  if (!data) return <Loading />
  if (!data.items.length) {
    return <Empty art={<CassetteArt />} title="Лайков пока нет" text="Здесь появятся музыканты, которым понравились твои записи." />
  }
  const myInst = instrumentName(catalog, me.instruments.find((i) => i.is_main)?.id ?? '')
  return (
    <ul className="match-list">
      {data.items.map((l) => (
        <li key={l.author.id + l.video.id}>
          <Link to={`/users/${l.author.id}`} className="card match-row">
            <Avatar name={l.author.name} url={l.author.photo_url} size={52} />
            <span className="match-row-main">
              <strong>{l.author.name}</strong>
              <span className="small">Нравится твоя запись · {fmtAgo(l.liked_at)}</span>
              <AuthorLine author={l.author} />
            </span>
            <span className="like-thumb">
              {l.video.type === 'video' ? <img src={l.video.poster_url} alt="" /> : <AudioCover peaks={l.video.peaks} name={me.name} instrument={myInst} compact />}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  )
}
