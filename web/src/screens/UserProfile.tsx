import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { api, ApiError, errorText } from '../api'
import { MatchOverlay } from '../components/LikeBits'
import { Header } from '../components/Header'
import { ProfileView } from '../components/ProfileView'
import { Empty, ErrorState, Loading } from '../components/States'
import { useMe } from '../session'
import { refreshIncoming } from '../lib/incoming'
import type { InviteResult, PublicUser, Relation } from '../types'
import { instrumentName, useVideos, VideoGrid } from '../components/VideoBits'

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
        <ProfileView user={user} catalog={catalog} />
        <UserVideos user={user} />
        <InviteAction user={user} />
      </>
    )

  return (
    <main className="screen">
      <Header back />
      <div className="screen-body">{body}</div>
    </main>
  )
}

// Записи — внизу профиля. По нажатию открываются как лента, начиная с выбранной (визитка — первой).
function UserVideos({ user }: { user: PublicUser }) {
  const { catalog } = useMe()
  const navigate = useNavigate()
  const { items } = useVideos(`/users/${encodeURIComponent(user.id)}/videos`)
  const inst = instrumentName(catalog, user.instruments.find((i) => i.is_main)?.id ?? '')
  return (
    <section className="stack">
      <h3 className="section-title">Записи</h3>
      {items && items.length === 0 && <p className="muted">Пока нет записей</p>}
      {items && items.length > 0 && (
        <VideoGrid items={items} name={user.name} instrument={inst} onOpen={(v) => navigate(`/users/${user.id}/videos/${v.id}`)} />
      )}
    </section>
  )
}

// InviteAction — «Хочу поиграть» в профиле музыканта. Отдельно от лайков записей.
function InviteAction({ user }: { user: PublicUser }) {
  const { me } = useMe()
  const [rel, setRel] = useState<Relation | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [matched, setMatched] = useState(false)

  useEffect(() => {
    api<Relation>(`/users/${user.id}/relation`).then(setRel).catch(() => setRel(null))
  }, [user.id])

  if (user.id === me.id || !rel) return null

  async function invite() {
    setBusy(true)
    setError('')
    try {
      const r = await api<InviteResult>('/invites', { method: 'POST', body: { to_user_id: user.id } })
      setRel({ ...rel!, invited: true, mutual: r.mutual })
      if (r.mutual) setMatched(true)
      refreshIncoming()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  async function withdraw() {
    setBusy(true)
    setError('')
    try {
      await api(`/invites/${user.id}`, { method: 'DELETE' })
      setRel({ ...rel!, invited: false, mutual: false })
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="bottom-actions">
      {error && <p className="error-text" role="alert">{error}</p>}
      {rel.mutual ? (
        <p className="note center">Вы оба хотите поиграть вместе.</p>
      ) : rel.invited ? (
        <>
          <p className="small muted center">Предложение отправлено. Если {user.name} ответит тем же — появится совпадение.</p>
          <button className="btn btn-secondary" disabled={busy} onClick={withdraw}>Отменить предложение</button>
        </>
      ) : rel.invited_me ? (
        <>
          <p className="small center accent-text">{user.name} хочет с тобой поиграть.</p>
          <button className="btn btn-primary" disabled={busy} onClick={invite}>Ответить взаимностью</button>
        </>
      ) : (
        <button className="btn btn-primary" disabled={busy} onClick={invite}>Хочу поиграть</button>
      )}
      {matched && <MatchOverlay other={user} onClose={() => setMatched(false)} />}
    </div>
  )
}
