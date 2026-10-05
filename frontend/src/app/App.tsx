import { Navigate, Route, Routes } from 'react-router-dom'
import { NaWorkspacePage } from '../features/na/NaWorkspacePage'
import { AccountProvider, useAccount } from '../features/account/AccountContext'
import { AccountPage } from '../features/account/AccountPage'
function Workspace() {
  const account = useAccount()
  if (account.loading || account.error) return <AccountPage/>
  if (!account.user) return <Navigate to="/login" replace/>
  if (!account.profile?.ready) return <Navigate to="/onboarding" replace/>
  return <NaWorkspacePage key={account.user.uid}/>
}
export default function App() {
  return <AccountProvider><Routes><Route path="/login" element={<AccountPage/>}/><Route path="/onboarding" element={<AccountPage/>}/><Route path="/account" element={<AccountPage edit/>}/><Route path="/na" element={<Workspace/>}/><Route path="*" element={<Navigate to="/na" replace/>}/></Routes></AccountProvider>
}
