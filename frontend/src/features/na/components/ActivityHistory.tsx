import type { AuditRecord } from '@gobuy/shared'
import { explorerAccount, explorerTx } from '../../../services/solana/links'
export type DemoAudit = { id: string; hash: string; version: number; reason: string; time: string }
export function ActivityHistory({ records, demos, busy, onRefresh }: {
  records: AuditRecord[]; demos: DemoAudit[]; busy: boolean; onRefresh: () => Promise<void>
}) {
  return <div className="settings-page">
    <span className="eyeline">A CLEAR RECORD</span><h1>Every decision.<br/><em>In the open.</em></h1>
    <p className="muted">Confirmed Devnet records are loaded for the connected wallet. Showing the latest 30 records.</p>
    <button className="outline" disabled={busy} onClick={() => void onRefresh()}>Refresh on-chain activity ↻</button>
    {!records.length && <p className="empty-history">No confirmed on-chain decisions loaded.</p>}
    <div className="audit-list">{records.map(record => <article key={record.address}>
      <strong className={record.approved ? 'good' : 'bad'}>{record.approved ? 'APPROVED' : 'REJECTED'} · {record.reasonCode}</strong>
      <p>Submitted mandate v{record.mandateVersion} · evaluated against v{record.currentVersion}<br/>{new Date(record.timestamp * 1000).toLocaleString()}</p>
      <label>Proposal ID<code>{record.proposalId}</code></label>
      <label>Proposal hash<code>{record.proposalHash}</code></label>
      {record.signature ? <label>Transaction<a href={explorerTx(record.signature)} target="_blank" rel="noreferrer"><code>{record.signature} ↗</code></a></label> : <p>Transaction signature unavailable from RPC history.</p>}
      <a href={explorerAccount(record.address)} target="_blank" rel="noreferrer">ActionRecord on Solana Explorer ↗</a>
    </article>)}</div>
    {!!demos.length && <><h3>Demo previews · this session only</h3><p className="muted">These are local previews with no authority, transaction or on-chain approval.</p>
      <div className="audit-list">{demos.map(item => <article key={item.id}><strong>DEMO PREVIEW · {item.reason}</strong><p>Demo mandate v{item.version} · {item.time}</p><code>{item.hash}</code></article>)}</div></>}
  </div>
}
