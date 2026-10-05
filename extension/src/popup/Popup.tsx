import { createRoot } from 'react-dom/client'
import { Chat } from '../Chat'
export function Popup() { return <Chat/> }
createRoot(document.getElementById('root')!).render(<Popup/>)
