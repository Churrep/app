import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { api } from '../api'
import { FeedList } from '../components/FeedList'
import { BackIcon } from '../components/Icons'
import { ErrorState, Loading } from '../components/States'
import type { Author, FeedItem, PublicUser, Video } from '../types'

// UserFeed — записи одного музыканта, листаются как лента, начиная с выбранной.
export function UserFeed() {
  const { id = '', videoId = '' } = useParams()
  const navigate = useNavigate()
  const [data, setData] = useState<{ items: FeedItem[]; start: number } | null>(null)
  const [error, setError] = useState<unknown>(null)

  useEffect(() => {
    let alive = true
    const uid = encodeURIComponent(id)
    Promise.all([api<PublicUser>(`/users/${uid}`), api<{ items: (Video & { liked: boolean })[] }>(`/users/${uid}/videos`)])
      .then(([user, r]) => {
        if (!alive) return
        const author: Author = {
          id: user.id, name: user.name, photo_url: user.photo_url, level: user.level, genres: user.genres,
          main_instrument: user.instruments.find((i) => i.is_main)?.id ?? '', district: user.district, looking_for: user.looking_for,
        }
        const items = r.items.filter((v) => v.status === 'ready').map((v) => ({ video: v, author, liked: v.liked }))
        setData({ items, start: Math.max(0, items.findIndex((it) => it.video.id === videoId)) })
      })
      .catch((e) => alive && setError(e))
    return () => {
      alive = false
    }
  }, [id, videoId])

  return (
    <main className="feed feed-full">
      <div className="feed-top">
        <button className="icon-btn light" onClick={() => navigate(-1)} aria-label="Назад к профилю"><BackIcon /></button>
        <span className="feed-title">{data?.items[0]?.author.name ?? ''}</span>
        <span className="icon-btn-space" />
      </div>
      {error ? <ErrorState error={error} onRetry={() => location.reload()} /> : !data ? <Loading /> : (
        <FeedList items={data.items} startIndex={data.start} profileLink={false} />
      )}
    </main>
  )
}
