import { type SyntheticEvent, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { api, errorText } from '../api'
import { useMe } from '../session'
import type { Catalog, FeedItem } from '../types'
import { nameOf } from '../types'
import { PlayIcon } from './LikeBits'
import { Avatar } from './ProfileView'
import { AudioCover, instrumentName, liveTake } from './VideoBits'
import { Waveform } from './Waveform'

// FeedList — вертикальная лента записей с прокруткой по одной. Общая для «Ленты» и записей в профиле.
// Сама следит, какая запись на экране, звуком и лайками записей.
export function FeedList({ items, startIndex = 0, onActive, profileLink = true }: {
  items: FeedItem[]
  startIndex?: number
  onActive?: (index: number) => void // для подгрузки следующей страницы
  profileLink?: boolean // аватар ведёт в профиль (в самом профиле не нужно)
}) {
  const { catalog } = useMe()
  const [active, setActive] = useState(startIndex)
  // Автозапуск звука запрещён: первое видео без звука, после тапа лента играет со звуком.
  const [muted, setMuted] = useState(true)
  // Лайки, которые зритель поменял здесь (id записи → лайк). Остальное — из ответа сервера.
  const [likes, setLikes] = useState<Map<string, boolean>>(new Map())
  const [toast, setToast] = useState('')
  const list = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(''), 3000)
    return () => clearTimeout(t)
  }, [toast])

  // Открыли с конкретной записи — сразу прокручиваем к ней.
  useEffect(() => {
    const el = list.current?.querySelector(`[data-index="${startIndex}"]`)
    el?.scrollIntoView({ block: 'start' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Какая запись сейчас на экране.
  useEffect(() => {
    const root = list.current
    if (!root) return
    const io = new IntersectionObserver(
      (entries) => entries.forEach((e) => {
        if (!e.isIntersecting) return
        const i = Number((e.target as HTMLElement).dataset.index)
        setActive(i)
        onActive?.(i)
      }),
      { root, threshold: 0.6 },
    )
    root.querySelectorAll('[data-index]').forEach((el) => io.observe(el))
    return () => io.disconnect()
  }, [items, onActive])

  const isLiked = (it: FeedItem) => likes.get(it.video.id) ?? it.liked

  // Лайк ставится записи и на знакомства не влияет. «Хочу поиграть» — в профиле музыканта.
  async function setLike(it: FeedItem, on: boolean) {
    if (isLiked(it) === on) return
    const prev = isLiked(it)
    setLikes((m) => new Map(m).set(it.video.id, on))
    try {
      await api(`/videos/${it.video.id}/like`, { method: on ? 'POST' : 'DELETE' })
    } catch (e) {
      setLikes((m) => new Map(m).set(it.video.id, prev))
      setToast(errorText(e))
    }
  }

  return (
    <>
      <div className="feed-list" ref={list}>
        {items.map((it, i) => (
          <FeedCard key={it.video.id} item={it} index={i} catalog={catalog} active={i === active}
            preload={i >= active && i <= active + 2} muted={muted} onUnmute={() => setMuted(false)} profileLink={profileLink}
            liked={isLiked(it)} onLike={() => setLike(it, true)} onToggleLike={() => setLike(it, !isLiked(it))} />
        ))}
      </div>
      {toast && <div className="toast" role="status">{toast}</div>}
    </>
  )
}

function FeedCard({ item, index, catalog, active, preload, muted, onUnmute, profileLink, liked, onLike, onToggleLike }: {
  item: FeedItem
  index: number
  catalog: Catalog
  active: boolean
  preload: boolean
  muted: boolean
  onUnmute: () => void
  profileLink: boolean
  liked: boolean
  onLike: () => void // двойной тап — только ставит лайк
  onToggleLike: () => void // кнопка — ставит и снимает
}) {
  const { video, author } = item
  const ref = useRef<HTMLMediaElement | null>(null)
  const [paused, setPaused] = useState(false)
  const [progress, setProgress] = useState(0)

  useEffect(() => {
    const m = ref.current
    if (!m) return
    if (active && !paused) m.play().catch(() => {})
    else m.pause()
    if (!active) {
      m.currentTime = 0
      setPaused(false)
      setProgress(0)
    }
  }, [active, paused])

  // Один тап — звук/пауза, двойной — лайк записи.
  const lastTap = useRef(0)
  const single = useRef(0)
  const [heart, setHeart] = useState(false)
  function tap() {
    const now = Date.now()
    if (now - lastTap.current < 300) {
      clearTimeout(single.current)
      lastTap.current = 0
      setHeart(true)
      setTimeout(() => setHeart(false), 700)
      onLike()
      return
    }
    lastTap.current = now
    single.current = window.setTimeout(() => {
      if (muted) onUnmute()
      else setPaused((p) => !p)
    }, 300)
  }

  const media = {
    ref: (el: HTMLMediaElement | null) => { ref.current = el },
    src: video.media_url, loop: true, muted,
    onTimeUpdate: (e: SyntheticEvent<HTMLMediaElement>) => {
      const m = e.currentTarget
      if (m.duration) setProgress(m.currentTime / m.duration)
    },
  }
  const inst = instrumentName(catalog, author.main_instrument)
  const avatar = <Avatar name={author.name} url={author.photo_url} size={48} />
  return (
    <section className="feed-card" data-index={index}>
      <div className="feed-media" onClick={tap}>
        {video.type === 'video' ? (
          <video {...media} poster={video.poster_url} playsInline preload={preload ? 'auto' : 'metadata'} />
        ) : (
          <>
            <AudioCover peaks={video.peaks} name={author.name} instrument={inst} />
            <audio {...media} preload={preload ? 'auto' : 'none'} />
          </>
        )}
        {active && muted && <span className="sound-hint">🔈 Нажми, чтобы включить звук</span>}
        {active && !muted && paused && <span className="pause-hint">▶</span>}
        {heart && <span className="heart-burst"><PlayIcon filled width={96} height={96} /></span>}
      </div>

      <div className="feed-overlay">
        <div className="feed-author">
          <p className="feed-name">{author.name}</p>
          <p className="feed-meta">{inst} · {author.level}/5{author.district ? ` · ${author.district}` : ''}</p>
          {author.genres.length > 0 && <p className="feed-meta">{author.genres.map((g) => nameOf(catalog.genres, g)).join(', ')}</p>}
          {video.caption && <p className="feed-caption">{video.caption}</p>}
          <p className="feed-take">{nameOf(catalog.video_tags, video.tag)} · {liveTake(video.recorded_at)}</p>
        </div>
        {video.peaks.length > 0 && (
          <div className="feed-wave">
            <Waveform peaks={video.peaks} height={36} progress={progress}
              onSeek={(f) => { const m = ref.current; if (m?.duration) m.currentTime = f * m.duration }} />
          </div>
        )}
      </div>

      <div className="feed-actions">
        {profileLink
          ? <Link to={`/users/${author.id}`} className="feed-avatar" aria-label={`Профиль: ${author.name}`}>{avatar}</Link>
          : <span className="feed-avatar">{avatar}</span>}
        <button className={liked ? 'feed-like on' : 'feed-like'} onClick={onToggleLike} aria-pressed={liked} aria-label={liked ? 'Убрать лайк записи' : 'Нравится запись'}>
          <PlayIcon filled={liked} />
          <span>{liked ? 'Нравится' : 'Лайк'}</span>
        </button>
      </div>
    </section>
  )
}
