import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { onIdTokenChanged, signOut, type User } from 'firebase/auth'
import { type AccountProfile } from '@gobuy/shared'
import { loadAccountProfile } from './response'
import { accountAuth, accountFetch, authMessage } from './firebase'

type AccountState = { user: User | null; profile: AccountProfile | null; loading: boolean; error: string; refresh(): Promise<void>; logout(): Promise<void> }
const Context = createContext<AccountState | null>(null)
export function AccountProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [profile, setProfile] = useState<AccountProfile | null>(null)
  const [loading, setLoading] = useState(!!accountAuth)
  const [error, setError] = useState('')
  const epoch = useRef(0)
  async function refresh() {
    const current = accountAuth?.currentUser
    const token = ++epoch.current
    setUser(current ?? null); setProfile(null); setError('')
    if (!current) { setLoading(false); return }
    setLoading(true)
    try {
      const value = await loadAccountProfile(() => accountFetch('/api/account/me'),
        () => token === epoch.current && accountAuth?.currentUser?.uid === current.uid)
      if (token === epoch.current && accountAuth?.currentUser?.uid === current.uid) setProfile(value)
    } catch (error) { if (token === epoch.current) setError(authMessage(error)) }
    finally { if (token === epoch.current) setLoading(false) }
  }
  useEffect(() => {
    if (!accountAuth) return
    const unsubscribe = onIdTokenChanged(accountAuth, () => { void refresh() })
    return () => { epoch.current++; unsubscribe() }
  }, [])
  async function logout() { if (accountAuth) await signOut(accountAuth) }
  return <Context.Provider value={{ user, profile, loading, error, refresh, logout }}>{children}</Context.Provider>
}
export function useAccount() {
  const value = useContext(Context)
  if (!value) throw new Error('AccountProvider missing')
  return value
}
