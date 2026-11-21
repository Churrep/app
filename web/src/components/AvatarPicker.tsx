import { useRef, useState } from 'react'
import { api, errorText, upload } from '../api'
import { useMe } from '../session'
import type { Me } from '../types'
import { Avatar } from './ProfileView'

// Уменьшаем фото на телефоне до 1024 px, чтобы не грузить мегабайты; квадрат вырежет сервер.
async function shrink(file: File): Promise<Blob> {
  const url = URL.createObjectURL(file)
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    const k = Math.min(1, 1024 / Math.max(img.naturalWidth, img.naturalHeight))
    const c = document.createElement('canvas')
    c.width = Math.round(img.naturalWidth * k)
    c.height = Math.round(img.naturalHeight * k)
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height)
    return await new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('Не получилось прочитать фото'))), 'image/jpeg', 0.9))
  } finally {
    URL.revokeObjectURL(url)
  }
}

export function AvatarPicker() {
  const { me, setMe } = useMe()
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function pick(file?: File) {
    if (!file) return
    setBusy(true)
    setError('')
    try {
      setMe(await upload<Me>('/me/photo', {}, await shrink(file), 'avatar.jpg'))
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
      if (input.current) input.current.value = ''
    }
  }

  async function remove() {
    setBusy(true)
    try {
      setMe(await api<Me>('/me/photo', { method: 'DELETE' }))
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="avatar-picker">
      <button type="button" className="avatar-btn" onClick={() => input.current?.click()} disabled={busy} aria-label="Выбрать фото">
        <Avatar name={me.name || '?'} url={me.photo_url} size={96} />
        <span className="avatar-edit">{busy ? '…' : '📷'}</span>
      </button>
      <div className="stack">
        <button type="button" className="btn btn-secondary" onClick={() => input.current?.click()} disabled={busy}>
          {me.photo_url ? 'Сменить фото' : 'Добавить фото'}
        </button>
        {me.photo_url && <button type="button" className="btn-link" onClick={remove} disabled={busy}>Удалить фото</button>}
        {error && <p className="error-text small">{error}</p>}
      </div>
      <input ref={input} type="file" accept="image/*" hidden onChange={(e) => pick(e.target.files?.[0])} />
    </div>
  )
}
