import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { api, errorText } from '../api'
import { PlayIcon } from '../components/LikeBits'
import { Avatar } from '../components/ProfileView'
import { Empty, ErrorState, Loading } from '../components/States'
import { AudioCover, instrumentName, liveTake } from '../components/VideoBits'
import { useMe } from '../session'
import type { Catalog, FeedItem } from '../types'
import { nameOf } from '../types'

type Filters = { instrument: string; genre: string; looking_for: string; level_min: number; level_max: number }
const noFilters: Filters = { instrument: '', genre: '', looking_for: '', level_min: 1, level_max: 5 }

function loadFilters(): Filters {
  try {
    return { ...noFilters, ...JSON.parse(localStorage.getItem('feed_filters') ?? '{}') }
  } catch {
    return noFilters
  }
}

export function Feed() {
  const { catalog } = useMe()
  const [filters, setFilters] = useState<Filters>(loadFilters)
  const [showFilters, setShowFilters] = useState(false)
  const [items, setItems] = useState<FeedItem[]>([])
  const [cursor, setCursor] = useState('')
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState<unknown>(null)
  const [active, setActive] = useState(0)
  // Автозапуск звука запрещён: первое видео без звука, после тапа лента играет со звуком.
  const [muted, setMuted] = useState(true)
  // Лайки записей, которые зритель поменял в этой сессии (id записи → лайк). Остальное — из ответа ленты.
  const [likes, setLikes] = useState<Map<string, boolean>>(new Map())
  const [toast, setToast] = useState('')
  const loadingMore = useRef(false)

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(''), 3000)
    return () => clearTimeout(t)
  }, [toast])

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
  const list = useRef<HTMLDivElement>(null)

  const query = (f: Filters, c: string) => {
    const q = new URLSearchParams()
    if (f.instrument) q.set('instrument', f.instrument)
    if (f.genre) q.set('genre', f.genre)
    if (f.looking_for) q.set('looking_for', f.looking_for)
    if (f.level_min > 1) q.set('level_min', String(f.level_min))
    if (f.level_max < 5) q.set('level_max', String(f.level_max))
    if (c) q.set('cursor', c)
    return '/feed?' + q
  }

  const load = useCallback(async () => {
    setStatus('loading')
    try {
      const r = await api<{ items: FeedItem[]; next_cursor: string }>(query(filters, ''))
      setItems(r.items)
      setCursor(r.next_cursor)
      setActive(0)
      list.current?.scrollTo({ top: 0 })
      setStatus('ready')
    } catch (e) {
      setError(e)
      setStatus('error')
    }
  }, [filters])

  useEffect(() => {
    load()
    try {
      localStorage.setItem('feed_filters', JSON.stringify(filters))
    } catch {
      // не страшно
    }
  }, [load])

  // Подгружаем следующую страницу заранее, за 3 видео до конца.
  useEffect(() => {
    if (!cursor || loadingMore.current || active < items.length - 3) return
    loadingMore.current = true
    api<{ items: FeedItem[]; next_cursor: string }>(query(filters, cursor))
      .then((r) => {
        setItems((prev) => [...prev, ...r.items.filter((it) => !prev.some((p) => p.video.id === it.video.id))])
        setCursor(r.next_cursor)
      })
      .catch(() => {})
      .finally(() => {
        loadingMore.current = false
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, cursor, items.length])

  // Какое видео сейчас на экране.
  useEffect(() => {
    const root = list.current
    if (!root) return
    const io = new IntersectionObserver(
      (entries) => entries.forEach((e) => e.isIntersecting && setActive(Number((e.target as HTMLElement).dataset.index))),
      { root, threshold: 0.6 },
    )
    root.querySelectorAll('[data-index]').forEach((el) => io.observe(el))
    return () => io.disconnect()
  }, [items])

  const filtered = JSON.stringify(filters) !== JSON.stringify(noFilters)

  return (
    <main className="feed">
      <div className="feed-top">
        <span className="feed-title">Лента</span>
        <button className={filtered ? 'chip feed-filter on' : 'chip feed-filter'} onClick={() => setShowFilters(true)}>
          Фильтры{filtered ? ' •' : ''}
        </button>
      </div>

      {status === 'loading' && <Loading />}
      {status === 'error' && <ErrorState error={error} onRetry={load} />}
      {status === 'ready' && items.length === 0 && (
        <Empty title={filtered ? 'Никого не нашли' : 'Пока нет видео'}
          text={filtered ? 'Попробуй ослабить фильтры.' : 'Будь первым — запиши, как играешь. Пока нет видео, тебя не видно в ленте.'}>
          {filtered && <button className="btn btn-secondary" onClick={() => setFilters(noFilters)}>Сбросить фильтры</button>}
        </Empty>
      )}

      {status === 'ready' && items.length > 0 && (
        <div className="feed-list" ref={list}>
          {items.map((it, i) => (
            <FeedCard key={it.video.id} item={it} index={i} catalog={catalog} active={i === active}
              preload={i >= active && i <= active + 2} muted={muted} onUnmute={() => setMuted(false)}
              liked={isLiked(it)} onLike={() => setLike(it, true)} onToggleLike={() => setLike(it, !isLiked(it))} />
          ))}
        </div>
      )}

      {toast && <div className="toast" role="status">{toast}</div>}
      {showFilters && <FilterSheet catalog={catalog} value={filters} onClose={() => setShowFilters(false)} onApply={(f) => { setFilters(f); setShowFilters(false) }} />}
    </main>
  )
}

function FeedCard({ item, index, catalog, active, preload, muted, onUnmute, liked, onLike, onToggleLike }: {
  item: FeedItem
  index: number
  catalog: Catalog
  active: boolean
  preload: boolean
  muted: boolean
  onUnmute: () => void
  liked: boolean
  onLike: () => void // двойной тап — только ставит лайк
  onToggleLike: () => void // кнопка — ставит и снимает
}) {
  const { video, author } = item
  const ref = useRef<HTMLMediaElement | null>(null)
  const [paused, setPaused] = useState(false)

  useEffect(() => {
    const m = ref.current
    if (!m) return
    if (active && !paused) m.play().catch(() => {})
    else m.pause()
    if (!active) {
      m.currentTime = 0
      setPaused(false)
    }
  }, [active, paused])

  // Один тап — звук/пауза, двойной — «Хочу поиграть».
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

  const inst = instrumentName(catalog, author.main_instrument)
  return (
    <section className="feed-card" data-index={index}>
      <div className="feed-media" onClick={tap}>
        {video.type === 'video' ? (
          <video ref={(el) => { ref.current = el }} src={video.media_url} poster={video.poster_url} loop playsInline muted={muted}
            preload={preload ? 'auto' : 'metadata'} />
        ) : (
          <>
            <AudioCover peaks={video.peaks} name={author.name} instrument={inst} />
            <audio ref={(el) => { ref.current = el }} src={video.media_url} loop muted={muted} preload={preload ? 'auto' : 'none'} />
          </>
        )}
        {active && muted && <span className="sound-hint">🔇 Нажми, чтобы включить звук</span>}
        {active && !muted && paused && <span className="pause-hint">▶</span>}
        {heart && <span className="heart-burst"><PlayIcon filled width={96} height={96} /></span>}
      </div>

      <div className="feed-overlay">
        <p className="feed-name">{author.name}</p>
        <p className="feed-meta">{inst} · {author.level}/5{author.district ? ` · ${author.district}` : ''}</p>
        {author.genres.length > 0 && <p className="feed-meta">{author.genres.map((g) => nameOf(catalog.genres, g)).join(', ')}</p>}
        {video.caption && <p className="feed-caption">{video.caption}</p>}
        <p className="feed-take">{nameOf(catalog.video_tags, video.tag)} · {liveTake(video.recorded_at)}</p>
      </div>

      <div className="feed-actions">
        <Link to={`/users/${author.id}`} className="feed-avatar" aria-label={`Профиль: ${author.name}`}>
          <Avatar name={author.name} url={author.photo_url} size={48} />
        </Link>
        <button className={liked ? 'feed-like on' : 'feed-like'} onClick={onToggleLike} aria-pressed={liked} aria-label={liked ? 'Убрать лайк записи' : 'Нравится запись'}>
          <PlayIcon filled={liked} />
          <span>{liked ? 'Нравится' : 'Лайк'}</span>
        </button>
      </div>
    </section>
  )
}

function FilterSheet({ catalog, value, onApply, onClose }: { catalog: Catalog; value: Filters; onApply: (f: Filters) => void; onClose: () => void }) {
  const [f, setF] = useState(value)
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Фильтры">
        <h2>Фильтры</h2>
        <label className="field">
          <span className="label">Инструмент</span>
          <select className="input" value={f.instrument} onChange={(e) => setF({ ...f, instrument: e.target.value })}>
            <option value="">Любой</option>
            {catalog.instruments.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
          </select>
        </label>
        <div className="field">
          <span className="label">Уровень: от {f.level_min} до {f.level_max}</span>
          <div className="row">
            <select className="input" value={f.level_min} onChange={(e) => setF({ ...f, level_min: Math.min(Number(e.target.value), f.level_max) })}>
              {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>от {n}</option>)}
            </select>
            <select className="input" value={f.level_max} onChange={(e) => setF({ ...f, level_max: Math.max(Number(e.target.value), f.level_min) })}>
              {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>до {n}</option>)}
            </select>
          </div>
        </div>
        <label className="field">
          <span className="label">Жанр</span>
          <select className="input" value={f.genre} onChange={(e) => setF({ ...f, genre: e.target.value })}>
            <option value="">Любой</option>
            {catalog.genres.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
        </label>
        <div className="field">
          <span className="label">Кто нужен</span>
          <div className="segmented three" role="radiogroup">
            {[['', 'Все'], ['band', 'Ищет группу'], ['musician', 'Ищет музыканта']].map(([id, label]) => (
              <button key={id} role="radio" aria-checked={f.looking_for === id} onClick={() => setF({ ...f, looking_for: id })}>{label}</button>
            ))}
          </div>
        </div>
        <button className="btn btn-primary" onClick={() => onApply(f)}>Показать</button>
        <button className="btn btn-ghost" onClick={() => onApply(noFilters)}>Сбросить</button>
      </div>
    </div>
  )
}
