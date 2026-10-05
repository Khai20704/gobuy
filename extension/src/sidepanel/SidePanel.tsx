import { createRoot } from 'react-dom/client'
import { Chat } from '../Chat'
export function SidePanel() { return <Chat panel/> }
createRoot(document.getElementById('root')!).render(<SidePanel/>)
