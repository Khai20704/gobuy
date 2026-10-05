import { useState } from 'react'
import { apiUrl } from '../../../services/api/baseUrl'
export function ExtensionPairing() {
  const [code, setCode] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  async function request(revoke = false) {
    setBusy(true); setError('')
    try {
      const response = await fetch(apiUrl('/api/research/' + (revoke ? 'extension-sessions' : 'pair-code')), { method: revoke ? 'DELETE' : 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' }, body: revoke ? undefined : '{}' })
      if (!response.ok) throw new Error('Could not update extension pairing. Check the backend.')
      setCode(revoke ? '' : (await response.json()).code)
    } catch (e) { setError(e instanceof Error ? e.message : 'Pairing unavailable.') } finally { setBusy(false) }
  }
  return <section className="settings-page"><h2>Na Extension</h2><p>Pair the extension with this research workspace. Pairing grants search and review access; Phantom still signs in GoBuy.</p>
    <button className="outline" disabled={busy} onClick={() => void request()}>Generate extension pairing code</button>{' '}
    <button className="outline" disabled={busy} onClick={() => void request(true)}>Revoke extension sessions</button>
    {code && <p>Paste into Na Extension within two minutes: <code>{code}</code></p>}{error && <p role="alert">{error}</p>}
  </section>
}
