import { formatSol, type MandateSpendRecord, type SerializedMandateView } from '@gobuy/shared'
import { explorerTx } from '../../../services/solana/links'

/**
 * Presentational pieces of the Na Vault panel. They render a mandate and its spend history and
 * hold no state: every value shown comes from the chain through the mandate API.
 */

const percent = (part: bigint, whole: bigint) => whole <= 0n ? 0 : Math.min(100, Math.round(Number(part * 1000n / whole) / 10))

/** Spent-versus-limit bar. The remaining budget is the number the owner actually manages. */
export function VaultProgress({ mandate }: { mandate: SerializedMandateView }) {
  const spent = BigInt(mandate.spentLamports), max = BigInt(mandate.maxBudgetLamports)
  const used = percent(spent, max)
  return <div className="vault-progress">
    <div className="vault-progress-head"><span>Đã dùng {used}%</span><span>{formatSol(spent)} / {formatSol(max)} SOL</span></div>
    <div className="vault-progress-track" role="img" aria-label={`Đã dùng ${used}% hạn mức`}>
      <span className="vault-progress-fill" style={{ width: `${used}%` }}/>
    </div>
  </div>
}

export function VaultStatusChips({ mandate }: { mandate: SerializedMandateView }) {
  const expired = mandate.active && mandate.expiresAt * 1000 < Date.now()
  const status = expired ? 'EXPIRED' : mandate.status
  return <div className="vault-chips">
    <span className={`vault-chip vault-chip-${status.toLowerCase()}`}>{status}</span>
    <span className="vault-chip">{mandate.allowedCategory}</span>
    <span className="vault-chip vault-chip-plain">Hết hạn {new Date(mandate.expiresAt * 1000).toLocaleString('vi-VN')}</span>
  </div>
}

/** The numbers an owner checks before signing anything else. */
export function VaultMetrics({ mandate }: { mandate: SerializedMandateView }) {
  const rows: Array<[string, string, boolean?]> = [
    ['Còn lại trong hạn mức', `${formatSol(BigInt(mandate.remainingLamports))} SOL`, true],
    ['Đã ủy quyền', `${formatSol(BigInt(mandate.maxBudgetLamports))} SOL`],
    ['Đã chi', `${formatSol(BigInt(mandate.spentLamports))} SOL`],
    ['Số dư vault (gồm rent)', `${formatSol(BigInt(mandate.vaultLamports), 6)} SOL`],
  ]
  return <dl className="vault-metrics">
    {rows.map(([label, value, strong]) => <div className="vault-metric" key={label}>
      <dt>{label}</dt><dd className={strong ? 'vault-metric-strong' : undefined}>{value}</dd>
    </div>)}
  </dl>
}

/** Read-only technical identifiers, kept out of the way until asked for. */
export function VaultIdentifiers({ mandate }: { mandate: SerializedMandateView }) {
  const rows: Array<[string, string]> = [
    ['Mandate PDA', mandate.address], ['Vault PDA', mandate.vault],
    ['Executor', mandate.executor], ['Recipient', mandate.recipient],
  ]
  return <dl className="vault-identifiers">
    {rows.map(([label, value]) => <div className="vault-identifier" key={label}>
      <dt>{label}</dt><dd>{value}</dd>
    </div>)}
  </dl>
}

/** One confirmed vault spend, read back from the program's receipt account. */
export function VaultHistory({ spends }: { spends: MandateSpendRecord[] }) {
  if (!spends.length) return <p className="vault-empty">Chưa có khoản chi nào từ vault này.</p>
  return <ol className="vault-history">
    {spends.map(record => <li className="vault-history-item" key={record.address}>
      <div className="vault-history-head">
        <strong title={record.reference ?? record.assetHash}>{record.reference ?? record.assetHash.slice(0, 12) + '…'}</strong>
        <span className="vault-chip">{record.category}</span>
      </div>
      <div className="vault-history-amount">{formatSol(BigInt(record.amountLamports))} SOL</div>
      <p className="vault-history-meta">
        Hạn mức đã chi {formatSol(BigInt(record.spentBeforeLamports))} → {formatSol(BigInt(record.spentAfterLamports))} SOL
        · còn {formatSol(BigInt(record.remainingAfterLamports))} SOL
      </p>
      <div className="vault-history-foot">
        <span>{new Date(record.timestamp * 1000).toLocaleString('vi-VN')}</span>
        {record.signature && <a href={explorerTx(record.signature)} target="_blank" rel="noreferrer">Giao dịch Devnet ↗</a>}
      </div>
    </li>)}
  </ol>
}
