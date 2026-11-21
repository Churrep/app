import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { api, ApiError } from './api'
import { ErrorState, FullLoading } from './components/States'
import type { Catalog, Me, MePatch, Theme } from './types'

type Session = {
  me: Me | null
  catalog: Catalog
  setMe: (me: Me | null) => void
  patchMe: (patch: MePatch) => Promise<Me>
  logout: () => Promise<void>
}

const SessionContext = createContext<Session | null>(null)

export function useSession() {
  const s = useContext(SessionContext)
  if (!s) throw new Error('useSession outside SessionProvider')
  return s
}

// useMe — для экранов за RequireAuth, где пользователь точно есть.
export function useMe() {
  const s = useSession()
  if (!s.me) throw new Error('useMe without user')
  return { ...s, me: s.me }
}

export function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'light' ? '#F6F5F2' : '#0E0E11')
  try {
    localStorage.setItem('theme', theme)
  } catch {
    // приватный режим — не страшно
  }
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<'loading' | 'error' | 'ready'>('loading')
  const [error, setError] = useState<unknown>(null)
  const [me, setMe] = useState<Me | null>(null)
  const [catalog, setCatalog] = useState<Catalog | null>(null)

  const load = useCallback(async () => {
    setStatus('loading')
    try {
      const [cat, user] = await Promise.all([
        api<Catalog>('/catalog'),
        api<Me>('/me').catch((e) => {
          if (e instanceof ApiError && e.status === 401) return null
          throw e
        }),
      ])
      setCatalog(cat)
      setMe(user)
      setStatus('ready')
    } catch (e) {
      setError(e)
      setStatus('error')
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    if (me) applyTheme(me.theme)
  }, [me?.theme])

  const patchMe = useCallback(async (patch: MePatch) => {
    const updated = await api<Me>('/me', { method: 'PATCH', body: patch })
    setMe(updated)
    return updated
  }, [])

  const logout = useCallback(async () => {
    await api('/auth/logout', { method: 'POST' })
    setMe(null)
  }, [])

  if (status === 'loading') return <FullLoading />
  if (status === 'error' || !catalog) return <ErrorState error={error} onRetry={load} full />

  return <SessionContext.Provider value={{ me, catalog, setMe, patchMe, logout }}>{children}</SessionContext.Provider>
}
