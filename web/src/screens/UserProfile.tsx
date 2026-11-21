import { useCallback, useEffect, useState } from 'react'
import { useParams } from 'react-router'
import { api, ApiError, errorText } from '../api'
import { MatchOverlay } from '../components/LikeBits'
import { Header } from '../components/Header'
import { ProfileView } from '../components/ProfileView'
import { Empty, ErrorState, Loading } from '../components/States'
import { useMe } from '../session'
import type { LikeResult, PublicUser, Video } from '../types'
import { AudioCover, instrumentName, useVideos, VideoGrid, VideoModal } from '../components/VideoBits'

export function UserProfile() {
  const { id = '' } = useParams()
  const { catalog } = useMe()
  const [user, setUser] = useState<PublicUser | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setUser(await api<PublicUser>('/users/' + encodeURIComponent(id)))
    } catch (e) {
      setError(e)
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => {
    load()
  }, [load])

  let body
  if (loading) body = <Loading />
  else if (error instanceof ApiError && error.status === 404) body = <Empty title="Профиль не найден" text="Возможно, человек удалил аккаунт." />
  else if (error || !user) body = <ErrorState error={error} onRetry={load} />
  else
    body = (
      <>
        <UserVideos user={user} />
        <ProfileView user={user} catalog={catalog} />
        <LikeAction user={user} />
      </>
    )

  return (
    <main className="screen">
      <Header back />
      <div className="screen-body">{body}</div>
    </main>
  )
}

// Видео-визитка сверху с явной кнопкой Play, ниже — сетка остальных записей.
function UserVideos({ user }: { user: PublicUser }) {
  const { catalog } = useMe()
  const { items } = useVideos(`/users/${encodeURIComponent(user.id)}/videos`)
  const [open, setOpen] = useState<Video | null>(null)
  const inst = instrumentName(catalog, user.instruments.find((i) => i.is_main)?.id ?? '')
  if (!items) return null
  if (items.length === 0) return <p className="note">Пока нет записей</p>
  const pinned = items.find((v) => v.is_pinned)
  const rest = items.filter((v) => v !== pinned)
  return (
    <>
      {pinned && (
        <button className="pinned-video" onClick={() => setOpen(pinned)} aria-label="Смотреть видео-визитку">
          {pinned.type === 'video' ? <img src={pinned.poster_url} alt="" /> : <AudioCover peaks={pinned.peaks} name={user.name} instrument={inst} />}
          <span className="play-overlay">▶</span>
        </button>
      )}
      {rest.length > 0 && <VideoGrid items={rest} name={user.name} instrument={inst} onOpen={setOpen} />}
      {open && <VideoModal video={open} name={user.name} instrument={inst} onClose={() => setOpen(null)} />}
    </>
  )
}

function LikeAction({ user }: { user: PublicUser }) {
  const { me } = useMe()
  const [rel, setRel] = useState<{ liked: boolean; match_id?: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [matched, setMatched] = useState(false)

  useEffect(() => {
    api<{ liked: boolean; match_id?: string }>(`/users/${user.id}/relation`).then(setRel).catch(() => setRel(null))
  }, [user.id])

  if (user.id === me.id || !rel) return null

  async function toggle() {
    setBusy(true)
    setError('')
    try {
      if (rel!.liked) {
        await api(`/likes/${user.id}`, { method: 'DELETE' })
        setRel({ liked: false })
      } else {
        const r = await api<LikeResult>('/likes', { method: 'POST', body: { to_user_id: user.id } })
        setRel({ liked: true, match_id: r.match_id || undefined })
        if (r.matched) setMatched(true)
      }
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="bottom-actions">
      {error && <p className="error-text" role="alert">{error}</p>}
      {rel.match_id ? (
        <p className="note center">Вы оба хотите поиграть вместе.</p>
      ) : rel.liked ? (
        <>
          <p className="small muted center">Ты хочешь поиграть вместе. Если ответят тем же — появится совпадение.</p>
          <button className="btn btn-secondary" disabled={busy} onClick={toggle}>Отменить</button>
        </>
      ) : (
        <button className="btn btn-primary" disabled={busy} onClick={toggle}>Хочу поиграть</button>
      )}
      {matched && <MatchOverlay other={user} onClose={() => setMatched(false)} />}
    </div>
  )
}
