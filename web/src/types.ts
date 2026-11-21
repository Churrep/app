export type Instrument = { id: string; is_main: boolean }

export type Onboarding = { complete: boolean; next_step?: string }

export type Theme = 'dark' | 'light'

export type Me = {
  id: string
  phone?: string
  telegram_username?: string
  name: string
  birth_date?: string
  age?: number
  district: string
  photo_url: string
  instruments: Instrument[]
  level?: number
  level_description?: string
  genres: string[]
  goals: string[]
  looking_for?: string
  looking_for_instrument?: string
  show_age: boolean
  show_district: boolean
  theme: Theme
  consent_at?: string
  onboarding: Onboarding
  created_at: string
}

export type PublicUser = {
  id: string
  name: string
  age?: number
  district?: string
  photo_url: string
  instruments: Instrument[]
  level: number
  level_description: string
  genres: string[]
  goals: string[]
  looking_for: string
  looking_for_instrument?: string
}

export type Item = { id: string; name: string }

export type Catalog = {
  instruments: Item[]
  genres: Item[]
  goals: Item[]
  looking_for: Item[]
  levels: { value: number; description: string }[]
  city: string
  max_genres: number
  video_tags: Item[]
}

export type Video = {
  id: string
  type: 'video' | 'audio'
  tag: string
  caption: string
  duration_ms: number
  media_url: string
  poster_url: string
  peaks: number[]
  is_pinned: boolean
  status: 'processing' | 'ready' | 'failed'
  error?: string
  recorded_at: string
  created_at: string
}

export type Author = {
  id: string
  name: string
  photo_url: string
  main_instrument: string
  level: number
  genres: string[]
  district?: string
  looking_for: string
}

export type FeedItem = { video: Video; author: Author; liked: boolean } // liked — я лайкнул эту запись

export type Band = { id: string; name: string; genres: string[]; role: string }

export type Spot = {
  id: string
  band: { id: string; name: string }
  instrument_id: string
  song_title: string
  backing_url: string
  backing_peaks: number[]
  backing_duration_ms: number
  bpm: number
  key: string
  genre_id: string
  description: string
  deadline: string | null
  status: 'processing' | 'open' | 'expired' | 'closed' | 'failed'
  error?: string
  created_at: string
  responses_count: number
  is_member: boolean
  my_response: { id: string; status: SpotResponse['status'] } | null
  stems?: SpotStem[] // отдельные дорожки, только в карточке места
}

export type SpotStem = {
  id: string
  position: number
  instrument_id: string
  url: string
  peaks: number[]
  duration_ms: number
}

export type SpotResponse = {
  id: string
  spot_id: string
  track_url: string
  mix_url: string
  track_peaks: number[]
  track_duration_ms: number
  offset_ms: number
  start_ms: number
  gain_backing: number
  gain_track: number
  status: 'processing' | 'sent' | 'invited' | 'rejected' | 'failed'
  error?: string
  created_at: string
  author?: Author
  spot?: Spot
}

export type MePatch = Partial<{
  name: string
  birth_date: string
  consent: boolean
  district: string
  instruments: Instrument[]
  level: number
  genres: string[]
  goals: string[]
  looking_for: string
  looking_for_instrument: string
  show_age: boolean
  show_district: boolean
  theme: Theme
}>

export const nameOf = (items: Item[], id?: string) => items.find((i) => i.id === id)?.name ?? id ?? ''

export const fmtDuration = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export const fmtDate = (iso: string) =>
  new Date(iso.length === 10 ? iso + 'T00:00:00' : iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })

// Совпадение — оба отправили друг другу «Хочу поиграть». Отдельного ID нет: в профиль ведёт other.id.
export type Match = { other: Author; created_at: string }

// Входящее предложение «Хочу поиграть».
export type IncomingInvite = {
  author: Author
  invited_at: string
  preview: { type: 'video' | 'audio'; poster_url: string; peaks: number[] } | null
}

export type InviteResult = { mutual: boolean }

// Отношение с другим музыкантом: я предложил, мне предложили, взаимно.
export type Relation = { invited: boolean; invited_me: boolean; mutual: boolean }

export const fmtAgo = (iso: string) => {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000)
  if (m < 1) return 'только что'
  if (m < 60) return `${m} мин назад`
  if (m < 24 * 60) return `${Math.round(m / 60)} ч назад`
  return fmtDate(iso)
}
