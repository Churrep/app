import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { FeedList } from '../components/FeedList'
import { CassetteArt } from '../components/Icons'
import { Empty, ErrorState, Loading } from '../components/States'
import { useMe } from '../session'
import type { Catalog, FeedItem } from '../types'

type Filters = { instrument: string; genre: string; looking_for: string; level_min: number; level_max: number }
const noFilters: Filters = { instrument: '', genre: '', looking_for: '', level_min: 1, level_max: 5 }

function loadFilters(): Filters {
  try {
    return { ...noFilters, ...JSON.parse(localStorage.getItem('feed_filters') ?? '{}') }
  } catch {
    return noFilters
  }
}

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

export function Feed() {
  const { catalog } = useMe()
  const [filters, setFilters] = useState<Filters>(loadFilters)
  const [showFilters, setShowFilters] = useState(false)
  const [items, setItems] = useState<FeedItem[]>([])
  const [cursor, setCursor] = useState('')
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState<unknown>(null)
  const [version, setVersion] = useState(0) // новый список — новая лента с начала
  const loadingMore = useRef(false)
  const state = useRef({ cursor, count: 0 })
  state.current = { cursor, count: items.length }

  const load = useCallback(async () => {
    setStatus('loading')
    try {
      const r = await api<{ items: FeedItem[]; next_cursor: string }>(query(filters, ''))
      setItems(r.items)
      setCursor(r.next_cursor)
      setVersion((v) => v + 1)
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
  const onActive = useCallback((i: number) => {
    const { cursor: c, count } = state.current
    if (!c || loadingMore.current || i < count - 3) return
    loadingMore.current = true
    api<{ items: FeedItem[]; next_cursor: string }>(query(filters, c))
      .then((r) => {
        setItems((prev) => [...prev, ...r.items.filter((it) => !prev.some((p) => p.video.id === it.video.id))])
        setCursor(r.next_cursor)
      })
      .catch(() => {})
      .finally(() => {
        loadingMore.current = false
      })
  }, [filters])

  const filtered = JSON.stringify(filters) !== JSON.stringify(noFilters)

  return (
    <main className="feed">
      <div className="feed-top">
        <span className="feed-title">Лента</span>
        <button className={filtered ? 'pill feed-filter on' : 'pill feed-filter'} onClick={() => setShowFilters(true)}>
          Фильтры{filtered ? ' •' : ''}
        </button>
      </div>

      {status === 'loading' && <Loading />}
      {status === 'error' && <ErrorState error={error} onRetry={load} />}
      {status === 'ready' && items.length === 0 && (
        <Empty art={<CassetteArt />} title={filtered ? 'Никого не нашли' : 'Пока нет видео'}
          text={filtered ? 'Попробуй ослабить фильтры.' : 'Будь первым — запиши, как играешь. Пока нет видео, тебя не видно в ленте.'}>
          {filtered && <button className="btn btn-secondary" onClick={() => setFilters(noFilters)}>Сбросить фильтры</button>}
        </Empty>
      )}
      {status === 'ready' && items.length > 0 && <FeedList key={version} items={items} onActive={onActive} />}

      {showFilters && <FilterSheet catalog={catalog} value={filters} onClose={() => setShowFilters(false)} onApply={(f) => { setFilters(f); setShowFilters(false) }} />}
    </main>
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
