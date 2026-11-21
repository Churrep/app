import { useState } from 'react'
import { Link, useLocation } from 'react-router'
import { Header } from '../components/Header'
import { GearIcon } from '../components/Icons'
import { ProfileView } from '../components/ProfileView'
import { instrumentName, useVideos, VideoGrid, VideoModal } from '../components/VideoBits'
import { useMe } from '../session'
import type { Video } from '../types'

export function MeScreen() {
  const { me, catalog } = useMe()
  const { state } = useLocation()
  const { items, reload } = useVideos('/me/videos')
  const [open, setOpen] = useState<Video | null>(null)
  const main = me.instruments.find((i) => i.is_main)?.id ?? ''

  return (
    <main className="screen">
      <Header title="Я" right={<Link to="/me/settings" className="icon-btn" aria-label="Настройки"><GearIcon /></Link>} />
      <div className="screen-body">
        {(state as { uploaded?: boolean } | null)?.uploaded && (
          <p className="note">Запись загружена. Обработаем её за пару минут, и она появится в ленте.</p>
        )}
        <ProfileView user={me} catalog={catalog} />
        <Link to="/me/edit" className="btn btn-secondary">Редактировать профиль</Link>

        <section className="stack">
          <h3 className="section-title">Мои записи</h3>
          {items && items.length === 0 && <p className="muted">Пока нет записей — тебя не видно в ленте. Нажми «+ Записать».</p>}
          {items && items.length > 0 && (
            <VideoGrid items={items} name={me.name} instrument={instrumentName(catalog, main)} onOpen={setOpen} />
          )}
        </section>
      </div>
      {open && (
        <VideoModal video={items?.find((v) => v.id === open.id) ?? open} name={me.name} instrument={instrumentName(catalog, main)} own
          onClose={() => setOpen(null)} onChanged={reload} />
      )}
    </main>
  )
}
