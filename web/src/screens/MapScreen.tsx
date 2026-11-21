import * as maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Supercluster from 'supercluster'
import { api, errorText } from '../api'
import { ChipPicker } from '../components/Pickers'
import { Empty, ErrorState, Loading } from '../components/States'
import { useMe } from '../session'
import type { Catalog, Venue } from '../types'
import { fmtDate, nameOf } from '../types'

// Воркер MapLibre ищет файл рядом со своим модулем, а после сборки он лежит в другом месте — указываем явно.
maplibregl.setWorkerUrl(workerUrl)

const SARATOV: [number, number] = [46.0342, 51.5331]

// Карта OpenFreeMap (данные OpenStreetMap): бесплатно, без ключа и без лимитов, векторные тайлы для MapLibre.
// Тайл-сервер самого OSM такие приложения блокирует (ошибка 451), у CARTO теперь нужен ключ.
const mapStyle = (dark: boolean) => `https://tiles.openfreemap.org/styles/${dark ? 'dark' : 'liberty'}`

type Filters = { types: string[]; priceMax: number; drums: boolean; backline: boolean; openNow: boolean }
const noFilters: Filters = { types: [], priceMax: 0, drums: false, backline: false, openNow: false }

function distanceKm(a: [number, number], b: [number, number]) {
  const r = Math.PI / 180
  const dLat = (b[1] - a[1]) * r
  const dLon = (b[0] - a[0]) * r
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(dLon / 2) ** 2
  return 12742 * Math.asin(Math.sqrt(h))
}

const fmtKm = (km: number) => (km < 1 ? `${Math.round(km * 1000)} м` : `${km.toFixed(1).replace('.', ',')} км`)

const priceText = (v: Venue) => {
  if (v.price_min === null && v.price_max === null) return v.type === 'free' || v.type === 'open_mic' ? 'Бесплатно' : 'Цена не указана'
  if (!v.price_max) return 'Бесплатно'
  return v.price_min === v.price_max || !v.price_min ? `${v.price_max} ₽/час` : `${v.price_min}–${v.price_max} ₽/час`
}

export default function MapScreen() {
  const { me, catalog } = useMe()
  const [filters, setFilters] = useState(noFilters)
  const [showFilters, setShowFilters] = useState(false)
  const [venues, setVenues] = useState<Venue[] | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [selected, setSelected] = useState<Venue | null>(null)
  const [here, setHere] = useState<[number, number] | null>(null)
  const [geoError, setGeoError] = useState('')
  const [expanded, setExpanded] = useState(false)
  const [suggest, setSuggest] = useState(false)
  // 16–17 лет — геолокацию не запрашиваем.
  const canLocate = me.age !== undefined && me.age >= 18

  const box = useRef<HTMLDivElement>(null)
  const map = useRef<maplibregl.Map | null>(null)
  const markers = useRef<maplibregl.Marker[]>([])
  const hereMarker = useRef<maplibregl.Marker | null>(null)

  const load = useCallback(async () => {
    setError(null)
    const q = new URLSearchParams()
    if (filters.types.length) q.set('type', filters.types.join(','))
    if (filters.priceMax) q.set('price_max', String(filters.priceMax))
    if (filters.drums) q.set('has_drums', '1')
    if (filters.backline) q.set('has_backline', '1')
    if (filters.openNow) q.set('open_now', '1')
    try {
      setVenues((await api<{ items: Venue[] }>('/venues?' + q)).items)
    } catch (e) {
      setError(e)
    }
  }, [filters])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    if (!box.current) return
    const m = new maplibregl.Map({ container: box.current, style: mapStyle(me.theme === 'dark'), center: SARATOV, zoom: 11.5, attributionControl: { compact: true } })
    map.current = m
    return () => m.remove()
  }, [])

  const index = useMemo(() => {
    const sc = new Supercluster<{ id: string }>({ radius: 50, maxZoom: 16 })
    sc.load((venues ?? []).map((v) => ({ type: 'Feature', properties: { id: v.id }, geometry: { type: 'Point', coordinates: [v.lon, v.lat] } })))
    return sc
  }, [venues])

  // Метки и кластеры — HTML-элементами, перерисовываем при движении карты.
  useEffect(() => {
    const m = map.current
    if (!m || !venues) return
    const byId = new Map(venues.map((v) => [v.id, v]))
    const render = () => {
      markers.current.forEach((mk) => mk.remove())
      markers.current = []
      const b = m.getBounds()
      for (const f of index.getClusters([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()], Math.round(m.getZoom()))) {
        const [lon, lat] = f.geometry.coordinates as [number, number]
        const el = document.createElement('button')
        const props = f.properties as { cluster?: boolean; point_count?: number; cluster_id?: number; id?: string }
        if (props.cluster) {
          el.className = 'map-cluster'
          el.textContent = String(props.point_count)
          el.setAttribute('aria-label', `${props.point_count} точек`)
          el.onclick = () => m.easeTo({ center: [lon, lat], zoom: index.getClusterExpansionZoom(props.cluster_id!) })
        } else {
          const v = byId.get(props.id!)!
          el.className = selected?.id === v.id ? 'map-pin active' : 'map-pin'
          el.setAttribute('aria-label', v.name)
          el.onclick = () => select(v)
        }
        markers.current.push(new maplibregl.Marker({ element: el }).setLngLat([lon, lat]).addTo(m))
      }
    }
    render()
    m.on('moveend', render)
    return () => {
      m.off('moveend', render)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, venues, selected])

  function select(v: Venue) {
    setSelected(v)
    map.current?.easeTo({ center: [v.lon, v.lat], zoom: Math.max(map.current.getZoom(), 14) })
  }

  function locate() {
    setGeoError('')
    navigator.geolocation.getCurrentPosition(
      (p) => {
        const pt: [number, number] = [p.coords.longitude, p.coords.latitude]
        setHere(pt)
        const el = document.createElement('div')
        el.className = 'map-here'
        hereMarker.current?.remove()
        hereMarker.current = new maplibregl.Marker({ element: el }).setLngLat(pt).addTo(map.current!)
        map.current?.easeTo({ center: pt, zoom: 13 })
      },
      () => setGeoError('Не получилось определить, где ты. Разреши геолокацию в настройках браузера'),
      { enableHighAccuracy: false, timeout: 10000 },
    )
  }

  const sorted = useMemo(() => {
    const list = [...(venues ?? [])]
    if (here) list.sort((a, b) => distanceKm(here, [a.lon, a.lat]) - distanceKm(here, [b.lon, b.lat]))
    return list
  }, [venues, here])

  const filtered = JSON.stringify(filters) !== JSON.stringify(noFilters)

  return (
    <main className="map-screen">
      <div ref={box} className="map-box" />
      <div className="map-top">
        <button className={filtered ? 'chip map-chip on' : 'chip map-chip'} onClick={() => setShowFilters(true)}>Фильтры{filtered ? ' •' : ''}</button>
        {canLocate && <button className="chip map-chip" onClick={locate}>◎ Я здесь</button>}
      </div>

      <div className={expanded && !selected ? 'map-sheet expanded' : 'map-sheet'}>
        {selected ? (
          <VenueCard venue={selected} catalog={catalog} here={here} onClose={() => setSelected(null)} />
        ) : (
          <>
            <button className="sheet-handle" onClick={() => setExpanded(!expanded)} aria-label={expanded ? 'Свернуть' : 'Развернуть'}>
              <span />
            </button>
            <div className="sheet-head">
              <strong>{venues ? `${venues.length} ${venues.length === 1 ? 'точка' : venues.length < 5 && venues.length > 0 ? 'точки' : 'точек'}` : 'Точки'}</strong>
              <button className="btn-link" onClick={() => setSuggest(true)}>+ Предложить точку</button>
            </div>
            {geoError && <p className="error-text small">{geoError}</p>}
            {error ? <ErrorState error={error} onRetry={load} /> : !venues ? <Loading /> : venues.length === 0 ? (
              <Empty title="Ничего не нашли" text={filtered ? 'Попробуй ослабить фильтры.' : 'Точки скоро появятся.'}>
                {filtered && <button className="btn btn-secondary" onClick={() => setFilters(noFilters)}>Сбросить фильтры</button>}
              </Empty>
            ) : (
              <ul className="venue-list">
                {sorted.map((v) => (
                  <li key={v.id}>
                    <button className="venue-row" onClick={() => select(v)}>
                      <span className="venue-row-main">
                        <strong>{v.name}</strong>
                        <span className="small muted">{nameOf(catalog.venue_types, v.type)} · {priceText(v)}</span>
                      </span>
                      <span className="small muted">{here ? fmtKm(distanceKm(here, [v.lon, v.lat])) : v.district}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>

      {showFilters && <VenueFilters catalog={catalog} value={filters} onApply={(f) => { setFilters(f); setShowFilters(false) }} onClose={() => setShowFilters(false)} />}
      {suggest && <SuggestVenue onClose={() => setSuggest(false)} />}
    </main>
  )
}

const dayNames: [string, string][] = [['mon', 'Пн'], ['tue', 'Вт'], ['wed', 'Ср'], ['thu', 'Чт'], ['fri', 'Пт'], ['sat', 'Сб'], ['sun', 'Вс']]

function VenueCard({ venue: v, catalog, here, onClose }: { venue: Venue; catalog: Catalog; here: [number, number] | null; onClose: () => void }) {
  const [report, setReport] = useState(false)
  const [message, setMessage] = useState('')
  const [sent, setSent] = useState('')
  const [error, setError] = useState('')

  async function sendReport() {
    setError('')
    try {
      const r = await api<{ message: string }>(`/venues/${v.id}/report`, { method: 'POST', body: { message } })
      setSent(r.message)
      setReport(false)
    } catch (e) {
      setError(errorText(e))
    }
  }

  const hasHours = Object.keys(v.opening_hours).length > 0
  return (
    <div className="venue-card">
      <div className="sheet-head">
        <span className="small muted">{nameOf(catalog.venue_types, v.type)}{here ? ` · ${fmtKm(distanceKm(here, [v.lon, v.lat]))}` : ''}</span>
        <button className="icon-btn" onClick={onClose} aria-label="Закрыть">✕</button>
      </div>
      <h2>{v.name}</h2>
      <p>{v.address}{v.district ? `, ${v.district} район` : ''}</p>
      <p className="small">
        {v.open_now === true && <span className="ok-text">Открыто сейчас · </span>}
        {v.open_now === false && <span className="muted">Закрыто · </span>}
        {priceText(v)}{v.rooms_count ? ` · комнат: ${v.rooms_count}` : ''}
      </p>
      <p className="small muted">{v.verified_at ? `Данные проверены ${fmtDate(v.verified_at)}` : 'Не проверено'}</p>

      <div className="row">
        <a className="btn btn-primary" href={`https://yandex.ru/maps/?rtext=~${v.lat},${v.lon}&rtt=auto`} target="_blank" rel="noreferrer">Маршрут</a>
        {v.phones[0] && <a className="btn btn-secondary" href={`tel:${v.phones[0].replace(/[^\d+]/g, '')}`}>Позвонить</a>}
      </div>
      <a className="small" href={`https://2gis.ru/routeSearch/rsType/car/to/${v.lon},${v.lat}`} target="_blank" rel="noreferrer">Открыть в 2ГИС</a>

      {v.photos.length > 0 && (
        <div className="photo-strip">{v.photos.slice(0, 10).map((p) => <img key={p} src={p} alt="" loading="lazy" />)}</div>
      )}

      {v.equipment.length > 0 && (
        <section>
          <h3 className="section-title">Оборудование</h3>
          <ul className="plain-list">{v.equipment.map((e) => <li key={e}>{nameOf(catalog.equipment, e)}</li>)}</ul>
        </section>
      )}

      {hasHours && (
        <section>
          <h3 className="section-title">Часы работы</h3>
          <ul className="plain-list hours">
            {dayNames.map(([d, label]) => <li key={d}><span>{label}</span><span>{v.opening_hours[d]?.join(', ').replace('00:00-24:00', 'круглосуточно') || 'выходной'}</span></li>)}
          </ul>
        </section>
      )}

      {(v.phones.length > 0 || v.telegram || v.website) && (
        <section>
          <h3 className="section-title">Контакты</h3>
          <ul className="plain-list">
            {v.phones.map((p) => <li key={p}><a href={`tel:${p.replace(/[^\d+]/g, '')}`}>{p}</a></li>)}
            {v.telegram && <li><a href={`https://t.me/${v.telegram.replace(/^@/, '')}`} target="_blank" rel="noreferrer">Telegram: {v.telegram}</a></li>}
            {v.website && <li><a href={v.website} target="_blank" rel="noreferrer">{v.website.replace(/^https?:\/\//, '')}</a></li>}
          </ul>
        </section>
      )}

      {sent && <p className="note">{sent}</p>}
      {!report && !sent && <button className="btn btn-ghost" onClick={() => setReport(true)}>Сообщить об ошибке</button>}
      {report && (
        <div className="stack">
          <textarea className="input textarea" value={message} maxLength={1000} placeholder="Например, цена теперь 800 ₽ или точка закрылась" onChange={(e) => setMessage(e.target.value)} />
          {error && <p className="error-text">{error}</p>}
          <button className="btn btn-secondary" disabled={!message.trim()} onClick={sendReport}>Отправить</button>
        </div>
      )}
    </div>
  )
}

function VenueFilters({ catalog, value, onApply, onClose }: { catalog: Catalog; value: Filters; onApply: (f: Filters) => void; onClose: () => void }) {
  const [f, setF] = useState(value)
  const toggle = (k: 'drums' | 'backline' | 'openNow', label: string) => (
    <label className="toggle-row">
      <span>{label}</span>
      <input type="checkbox" role="switch" className="switch" checked={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.checked })} />
    </label>
  )
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Фильтры">
        <h2>Фильтры</h2>
        <div className="field">
          <span className="label">Тип</span>
          <ChipPicker items={catalog.venue_types} value={f.types} onChange={(types) => setF({ ...f, types })} />
        </div>
        <label className="field">
          <span className="label">Цена за час</span>
          <select className="input" value={f.priceMax} onChange={(e) => setF({ ...f, priceMax: Number(e.target.value) })}>
            <option value={0}>Любая</option>
            {[300, 500, 1000, 2000].map((p) => <option key={p} value={p}>до {p} ₽</option>)}
          </select>
        </label>
        {toggle('drums', 'Есть барабаны')}
        {toggle('backline', 'Есть комбики')}
        {toggle('openNow', 'Открыто сейчас')}
        <button className="btn btn-primary" onClick={() => onApply(f)}>Показать</button>
        <button className="btn btn-ghost" onClick={() => onApply(noFilters)}>Сбросить</button>
      </div>
    </div>
  )
}

function SuggestVenue({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('')
  const [address, setAddress] = useState('')
  const [message, setMessage] = useState('')
  const [done, setDone] = useState('')
  const [error, setError] = useState('')
  async function send() {
    setError('')
    try {
      setDone((await api<{ message: string }>('/venues/suggest', { method: 'POST', body: { name, address, message } })).message)
    } catch (e) {
      setError(errorText(e))
    }
  }
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Предложить точку">
        <h2>Предложить точку</h2>
        {done ? (
          <>
            <p className="note">{done}</p>
            <button className="btn btn-secondary" onClick={onClose}>Закрыть</button>
          </>
        ) : (
          <>
            <input className="input" placeholder="Название" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
            <input className="input" placeholder="Адрес" value={address} maxLength={200} onChange={(e) => setAddress(e.target.value)} />
            <textarea className="input textarea" placeholder="Цена, оборудование, контакты — что знаешь" value={message} maxLength={1000} onChange={(e) => setMessage(e.target.value)} />
            {error && <p className="error-text">{error}</p>}
            <button className="btn btn-primary" disabled={!name.trim() || !address.trim()} onClick={send}>Отправить на проверку</button>
          </>
        )}
      </div>
    </div>
  )
}
