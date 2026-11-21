import { type ReactNode } from 'react'
import { Navigate, Route, Routes } from 'react-router'
import { OfflineBanner } from './components/OfflineBanner'
import { TabsLayout } from './components/TabsLayout'
import { Feed } from './screens/Feed'
import { Invites, Matches } from './screens/Matches'
import { Record } from './screens/Record'
import { RecordTrack } from './screens/RecordTrack'
import { NewSpot, SpotScreen, Tracks } from './screens/Tracks'
import { EditProfile } from './screens/EditProfile'
import { Login } from './screens/Login'
import { MeScreen } from './screens/Me'
import { Onboarding } from './screens/Onboarding'
import { Privacy } from './screens/Privacy'
import { Settings } from './screens/Settings'
import { UserProfile } from './screens/UserProfile'
import { SessionProvider, useSession } from './session'

function GuestOnly({ children }: { children: ReactNode }) {
  const { me } = useSession()
  if (me) return <Navigate to={me.onboarding.complete ? '/feed' : '/onboarding'} replace />
  return children
}

function RequireAuth({ children }: { children: ReactNode }) {
  const { me } = useSession()
  if (!me) return <Navigate to="/login" replace />
  return children
}

function RequireOnboarded({ children }: { children: ReactNode }) {
  const { me } = useSession()
  if (!me) return <Navigate to="/login" replace />
  if (!me.onboarding.complete) return <Navigate to="/onboarding" replace />
  return children
}

export default function App() {
  return (
    <>
      <OfflineBanner />
      <SessionProvider>
        <Routes>
          <Route path="/login" element={<GuestOnly><Login /></GuestOnly>} />
          <Route path="/onboarding" element={<RequireAuth><Onboarding /></RequireAuth>} />
          <Route path="/privacy" element={<Privacy />} />
          <Route element={<RequireOnboarded><TabsLayout /></RequireOnboarded>}>
            <Route path="/feed" element={<Feed />} />
            <Route path="/tracks" element={<Tracks />} />
            <Route path="/matches" element={<Matches />} />
            <Route path="/me" element={<MeScreen />} />
          </Route>
          <Route path="/me/edit" element={<RequireOnboarded><EditProfile /></RequireOnboarded>} />
          <Route path="/me/settings" element={<RequireOnboarded><Settings /></RequireOnboarded>} />
          <Route path="/users/:id" element={<RequireOnboarded><UserProfile /></RequireOnboarded>} />
          <Route path="/invites" element={<RequireOnboarded><Invites /></RequireOnboarded>} />
          <Route path="/likes" element={<Navigate to="/invites" replace />} />
          <Route path="/record" element={<RequireOnboarded><Record /></RequireOnboarded>} />
          <Route path="/tracks/new" element={<RequireOnboarded><NewSpot /></RequireOnboarded>} />
          <Route path="/tracks/:id" element={<RequireOnboarded><SpotScreen /></RequireOnboarded>} />
          <Route path="/tracks/:id/record" element={<RequireOnboarded><RecordTrack /></RequireOnboarded>} />
          <Route path="*" element={<Navigate to="/feed" replace />} />
        </Routes>
      </SessionProvider>
    </>
  )
}
