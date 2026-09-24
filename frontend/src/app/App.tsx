import { Navigate, Route, Routes } from 'react-router-dom'
import { NaWorkspacePage } from '../features/na/NaWorkspacePage'
export default function App() {
  return <Routes><Route path="/na" element={<NaWorkspacePage/>}/><Route path="*" element={<Navigate to="/na" replace/>}/></Routes>
}
