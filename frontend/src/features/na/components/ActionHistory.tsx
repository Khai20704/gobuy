import { useEffect, useState } from 'react'
import { actionLogSchema, type ActionLog } from '@gobuy/shared'
import { explorerTx } from '../../../services/solana/links'
export function ActionHistory() {
  const [rows, setRows] = useState<ActionLog[]>([]), [error, setError] = useState('')
  useEffect(() => { let active = true
    void fetch('/api/research/actions', { credentials: 'same-origin' }).then(async r => {
      if (!r.ok) throw new Error('Action history unavailable.')
      const data = actionLogSchema.array().parse(await r.json()); if (active) setRows(data)
    }).catch(() => { if (active) setError('Action history unavailable. Retry after reconnecting the backend.') })
    return () => { active = false }
  }, [])
  return <section className="settings-page"><h2>Commerce actions</h2><p>Searches and review requests share this browser workspace with your paired extension.</p>
    {error && <p role="alert">{error}</p>}<div className="audit-list">{rows.map(a => <article key={a.id}><strong>{a.status}</strong>
      <p>{new Date(a.timestamp).toLocaleString()} · {a.provider}</p><p>{a.request}</p>{a.asset && <p>{a.asset} · {a.price} {a.currency}</p>}
      <p>{a.reason}</p>{a.signature && <a href={explorerTx(a.signature)} target="_blank" rel="noreferrer">Solana transaction ↗</a>}</article>)}</div></section>
}
