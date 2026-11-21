import type { SVGProps } from 'react'
import { useNavigate } from 'react-router'
import { useMe } from '../session'
import type { Author } from '../types'
import { Avatar } from './ProfileView'

export const PlayIcon = ({ filled, ...p }: SVGProps<SVGSVGElement> & { filled?: boolean }) => (
  <svg width={30} height={30} viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={2} strokeLinejoin="round" aria-hidden {...p}>
    <path d="M12 21s-7.5-4.6-9.5-9.2C1.2 8.6 3.2 5 6.6 5c2 0 3.6 1.1 5.4 3.2C13.8 6.1 15.4 5 17.4 5c3.4 0 5.4 3.6 4.1 6.8C19.5 16.4 12 21 12 21z" />
  </svg>
)

// Экран совпадения: оба хотят поиграть вместе.
export function MatchOverlay({ other, matchId, onClose }: { other: Pick<Author, 'name' | 'photo_url'>; matchId: string; onClose: () => void }) {
  const { me } = useMe()
  const navigate = useNavigate()
  return (
    <div className="match-overlay" role="dialog" aria-modal="true" aria-label="Совпадение">
      <div className="match-avatars">
        <Avatar name={me.name} url={me.photo_url} size={96} />
        <Avatar name={other.name} url={other.photo_url} size={96} />
      </div>
      <h1 className="title">Совпадение!</h1>
      <p>Ты и {other.name} хотите поиграть вместе.</p>
      <div className="stack match-actions">
        <button className="btn btn-primary" onClick={() => navigate(`/chats/${matchId}`)}>Написать</button>
        <button className="btn btn-secondary" onClick={() => navigate(`/chats/${matchId}?jam=1`)}>Позвать на джем</button>
        <button className="btn btn-ghost" onClick={onClose}>Позже</button>
      </div>
    </div>
  )
}
