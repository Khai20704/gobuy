import { useEffect, useState } from 'react'
import { formatAmount, previewRules, recordedRules, type Mandate, type CommerceProposal, type AuditRecord } from '@gobuy/shared'
import { explorerTx } from '../../../services/solana/links'

export function AuthorityPanel({ mandate, proposal, result, onChain, onEdit }: {
  mandate: Mandate; proposal: CommerceProposal | null; result: AuditRecord | null; onChain: boolean; onEdit: () => void
}) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000))
  useEffect(() => { const timer = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000); return () => clearInterval(timer) }, [])
  const checks = result ? recordedRules(result.checks) : proposal ? previewRules(proposal, mandate, mandate.version, now) : []
  return <aside className="authority">
    <div className="authority-title"><span className="shield">◇</span><div><h2>Your authority</h2><p>Defined by you. Enforced by Na.</p></div></div>
    <div className="policy-head"><span>{onChain ? 'DEVNET MANDATE' : 'DEMO MANDATE'}</span><b>v{mandate.version}</b></div>
    <dl>
      <div><dt>Maximum value</dt><dd>{formatAmount(mandate.maxAmount)} <small>Devnet SOL</small></dd></div>
      <div><dt>Asset type</dt><dd>{mandate.assetType}</dd></div>
      <div><dt>Marketplace</dt><dd>{mandate.marketplace}</dd></div>
      <div><dt>Seller evidence claim</dt><dd>{mandate.requireVerifiedSeller ? 'Required' : 'Optional'}</dd></div>
      <div><dt>Autonomy</dt><dd>{mandate.autonomy ? 'Enabled' : 'Disabled'}</dd></div>
    </dl>
    <button className="outline full" onClick={onEdit}>Edit my boundaries <span>↗</span></button>
    <div className="authority-divider"/>
    <div className="policy-head"><span>{result ? 'NA ON-CHAIN VERIFICATION' : 'LOCAL RULE PREVIEW'}</span><span className="tiny-dot"/></div>
    {!checks.length ? <div className="verification-empty"><span>◎</span><h3>Ready when you are.</h3><p>An agent proposes. Na checks the mandate you signed.</p></div> : <>
      <div className="check-list">{checks.map(check => <div key={check.label}>
        <span className={check.passed ? 'check-icon good' : 'check-icon bad'}>{check.passed ? '✓' : '×'}</span>
        <div><strong>{check.label}</strong><small>{check.passed ? 'Rule matched' : 'Rule not matched'}</small></div>
      </div>)}</div>
      {result ? <div className={`verdict ${result.approved ? 'good' : 'bad'}`} role="status">
        <b>{result.approved ? 'APPROVED' : 'REJECTED'}</b><span>Confirmed on Devnet · {result.reasonCode}</span>
        {result.signature && <a href={explorerTx(result.signature)} target="_blank" rel="noreferrer">View transaction ↗</a>}
      </div> : <div className="preview-summary">Preview only · no on-chain verdict. Submit to Na and confirm in Phantom to record a decision.</div>}
    </>}
    <div className="authority-note"><p>Seller evidence and prices are adapter claims. Hashing them does not verify real-world facts. No purchase or token transfer is performed.</p></div>
  </aside>
}
