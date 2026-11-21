import { useEffect, useState } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router'
import { onNewLike, refreshIncoming, useIncomingCount } from '../lib/incoming'
import { ChatsIcon, FeedIcon, MeIcon, TracksIcon } from './Icons'

const tabs = [
  { to: '/feed', label: 'Лента', Icon: FeedIcon },
  { to: '/tracks', label: 'Дорожки', Icon: TracksIcon },
  { to: '/chats', label: 'Чаты', Icon: ChatsIcon },
  { to: '/me', label: 'Я', Icon: MeIcon },
]

export function TabsLayout() {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const showRecord = pathname === '/feed' || pathname === '/me'
  const incoming = useIncomingCount()
  const [toast, setToast] = useState(false)

  // Новые лайки проверяем раз в 30 секунд и при возвращении в приложение.
  useEffect(() => {
    refreshIncoming()
    const t = setInterval(refreshIncoming, 30000)
    const onShow = () => document.visibilityState === 'visible' && refreshIncoming()
    document.addEventListener('visibilitychange', onShow)
    const off = onNewLike(() => setToast(true))
    return () => {
      clearInterval(t)
      document.removeEventListener('visibilitychange', onShow)
      off()
    }
  }, [])

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(false), 5000)
    return () => clearTimeout(t)
  }, [toast])

  return (
    <div className={showRecord ? 'with-tabs has-fab' : 'with-tabs'}>
      <Outlet />
      {showRecord && (
        <button className="fab" onClick={() => navigate('/record')}>
          + Записать
        </button>
      )}
      {toast && (
        <button className="toast toast-action" onClick={() => { setToast(false); navigate('/likes') }}>
          Кто-то хочет с тобой поиграть — посмотреть
        </button>
      )}
      <nav className="tabbar" aria-label="Разделы">
        {tabs.map(({ to, label, Icon }) => (
          <NavLink key={to} to={to} className="tab">
            <span className="tab-icon">
              <Icon />
              {to === '/chats' && incoming > 0 && <span className="tab-badge" aria-label={`новых лайков: ${incoming}`}>{incoming > 99 ? '99+' : incoming}</span>}
            </span>
            <span>{label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  )
}
