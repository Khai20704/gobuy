import { useEffect, useRef, useState } from 'react'
import { Transaction } from '@solana/web3.js'
import { MANDATE_DURATION_PRESETS, createMandateInputSchema, mandateConfigResponseSchema, mandateQueryResponseSchema, mandateSpendsResponseSchema,
  unsignedMandateTransactionSchema, mandateSubmitResponseSchema,
  type MandateConfigResponse, type SerializedMandateView, type MandateSpendRecord, type MandateOwnerAction } from '@gobuy/shared'
import { mandateApi } from '../../../services/api/mandate'
import { phantomProvider } from '../../../services/solana/phantom'
import { ExpiredDevnetTransactionError, signDevnetTransaction } from '../../../services/solana/walletSafety'
import { prependCreateMandateComputeBudget } from '../../../services/solana/createMandateComputeBudget'
import { devnetConnection, requireDevnet } from '../../../services/solana/network'
import { explorerTx } from '../../../services/solana/links'
import { VaultHistory, VaultIdentifiers, VaultMetrics, VaultProgress, VaultStatusChips } from './VaultOverview'

/**
 * Na Vault - one shared spending policy for NFT and RWA.
 *
 * The owner signs a single authorization; Na decides from the request whether it is buying an NFT or
 * an RWA. The category is fixed to `ANY` so there is no per-asset-class policy to keep in sync and no
 * revoke/close/re-sign dance when the owner changes what they want to buy.
 */
export function NaVaultPanel({ wallet, devnetReady, onChanged, revision = 0 }: { wallet: string; devnetReady: boolean; onChanged(): void; revision?: number }) {
  const [config, setConfig] = useState<MandateConfigResponse | null>(null)
  const [configError, setConfigError] = useState('')
  const [mandate, setMandate] = useState<SerializedMandateView | null>(null)
  const [spends, setSpends] = useState<MandateSpendRecord[]>([])
  const [budget, setBudget] = useState('1'), [hours, setHours] = useState(24)
  const [message, setMessage] = useState(''), [busy, setBusy] = useState(false), [loaded, setLoaded] = useState(false)
  const [signature, setSignature] = useState<string | null>(null)
  const currentWallet = useRef(wallet), lock = useRef(false)
  currentWallet.current = wallet
  async function refresh(owner = wallet) {
    const result = mandateQueryResponseSchema.parse(await mandateApi('?owner=' + encodeURIComponent(owner)))
    if (currentWallet.current !== owner) return
    setMandate(result.mandate); setLoaded(true)
    const history = mandateSpendsResponseSchema.parse(await mandateApi('/spends?owner=' + encodeURIComponent(owner)))
    if (currentWallet.current === owner) setSpends(history.spends)
  }
  async function loadConfig() {
    setConfigError('')
    try {
      const raw = await mandateApi('/config')
      const value = mandateConfigResponseSchema.parse(raw)
      setConfig(value)
    } catch {
      setConfigError('Không tải được cấu hình Na Vault. Vui lòng kiểm tra backend rồi thử lại.')
    }
  }
  useEffect(() => { void loadConfig() }, [])
  useEffect(() => {
    setMandate(null); setSpends([]); setLoaded(false); setMessage(''); setSignature(null)
    if (!wallet || !config?.vaultProgramId) return
    void refresh(wallet).catch(error => { if (currentWallet.current === wallet) setMessage(error.message) })
    const timer = window.setInterval(() => void refresh(wallet).catch(() => {}), 15000)
    return () => window.clearInterval(timer)
  }, [wallet, config?.vaultProgramId, revision])
  async function run(action: MandateOwnerAction): Promise<boolean> {
    if (lock.current || !wallet || !devnetReady) return false
    lock.current = true; setBusy(true); setMessage(''); setSignature(null)
    const owner = wallet
    try {
      const provider = await phantomProvider()
      if (provider.publicKey?.toBase58() !== owner) throw new Error('Ví đang kết nối không khớp chủ mandate.')
      {
        const connection = devnetConnection()
        try {
          await requireDevnet(connection)
          for (let attempt = 0; attempt < 2; attempt++) {
            // Rebuild through the backend: it retains the exact message for validation.
            const built = unsignedMandateTransactionSchema.parse(await mandateApi('/transaction', { owner, action,
              ...(action === 'create' ? { create: { budgetSol: Number(budget), expiresInHours: hours, category: 'ANY' } } : {}) }))
            if (currentWallet.current !== owner || provider.publicKey?.toBase58() !== owner || built.owner !== owner || built.action !== action) throw new Error('Ví hoặc yêu cầu ký đã thay đổi.')
            const transaction = Transaction.from(Uint8Array.from(atob(built.transaction), char => char.charCodeAt(0)))
            if (action === 'create') prependCreateMandateComputeBudget(transaction)
            try {
              const expired = Date.parse(built.expiresAt) <= Date.now()
              const blockhashValid = !!transaction.recentBlockhash && (await connection.isBlockhashValid(transaction.recentBlockhash, { commitment: 'confirmed' })).value
              if (expired || !blockhashValid) throw new ExpiredDevnetTransactionError('Na Vault transaction expired before signing.')
              if (currentWallet.current !== owner || provider.publicKey?.toBase58() !== owner) throw new Error('Ví đã thay đổi trước khi ký.')
              const signed = await signDevnetTransaction(provider, transaction, connection, undefined, action === 'create')
              if (currentWallet.current !== owner || provider.publicKey?.toBase58() !== owner) throw new Error('Ví đã thay đổi; chưa gửi giao dịch.')
              if (Date.parse(built.expiresAt) <= Date.now() || !signed.recentBlockhash || !(await connection.isBlockhashValid(signed.recentBlockhash, { commitment: 'confirmed' })).value) {
                throw new Error('Giao dịch hết hạn trong khi ký; chưa gửi. Vui lòng thử lại.')
              }
              if (currentWallet.current !== owner || provider.publicKey?.toBase58() !== owner) throw new Error('Ví đã thay đổi; chưa gửi giao dịch.')
              setMessage('Đang gửi giao dịch và chờ xác nhận trên Devnet…')
              // The backend validates the retained message, broadcasts and awaits confirmation.
              const result = mandateSubmitResponseSchema.parse(await mandateApi('/submit', {
                owner, action, transaction: btoa(String.fromCharCode(...signed.serialize())),
              }))
              if (currentWallet.current === owner) {
                setMessage(`${result.status === 'CONFIRMED' ? 'Đã xác nhận trên Devnet. ' : ''}${result.message}`)
                setSignature(result.signature)
                setMandate(result.mandate)
              }
              break
            } catch (error) {
              if (error instanceof ExpiredDevnetTransactionError && attempt === 0) {
                continue
              }
              throw error
            }
          }
        } catch (error) {
          const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
          if (code === -32603) {
            const detail = error && typeof error === 'object' && 'message' in error ? String(error.message) : 'Unexpected error'
            if (currentWallet.current === owner) setMessage(`Phantom signTransaction: ${detail} (code -32603). Chưa gửi giao dịch.`)
            return false
          }
          throw error
        }
      }
      await refresh(owner).catch(() => {
        // Keep the submission result visible if a subsequent history refresh fails.
      }); onChanged()
      return true
    } catch (error) {
      if (currentWallet.current === owner) setMessage(error instanceof Error ? error.message : 'Chưa xác định được kết quả. Kiểm tra lịch sử trước khi thử lại.')
      return false
    } finally { lock.current = false; setBusy(false) }
  }
  const active = mandate?.active && mandate.expiresAt >= Date.now() / 1000
  const disabled = busy || !wallet || !devnetReady || !loaded
  const setupReason = configError || (!config ? 'Đang kiểm tra cấu hình Na Vault…'
    : !config.vaultProgramId ? 'Chưa cấu hình chương trình Na Vault trên Devnet.'
    : !config.autonomousExecutionReady ? 'Na Vault Devnet chưa sẵn sàng nhận ủy quyền. Vui lòng thử lại sau.'
    : !wallet ? 'Kết nối Phantom để tiếp tục.'
    : !devnetReady ? 'Chọn Devnet trong Phantom và xác nhận mạng ở phía trên.'
    : !loaded ? 'Chưa đọc được mandate của ví. Bấm làm mới để thử lại.' : '')
  const validDraft = createMandateInputSchema.safeParse({ budgetSol: Number(budget), expiresInHours: hours, category: 'ANY' }).success
  return <section className="na-vault-panel" aria-label="Na Vault">
    <header className="vault-heading">
      <div><span className="vault-eyebrow">NA VAULT</span><h2>Ngân sách cho Na</h2></div>
      <span className="vault-network">DEVNET</span>
    </header>
    {!mandate && <p className="vault-lead">Ủy quyền một ngân sách chung cho NFT và RWA trên Devnet.</p>}
    {mandate ? <div className="vault-body">
      <VaultStatusChips mandate={mandate}/>
      <VaultProgress mandate={mandate}/>
      <VaultMetrics mandate={mandate}/>
      <div className="vault-actions">
        {mandate.active && <button className="vault-button" disabled={disabled} onClick={() => void run('revoke')}>Thu hồi và trả SOL còn lại</button>}
        {!active && <button className="vault-button" disabled={disabled} onClick={() => void run('withdraw')}>Rút số dư, rent và đóng mandate</button>}
      </div>
      <p className="vault-note">Muốn đổi hạn mức? Thu hồi và đóng mandate hiện tại, rồi ký tạo ngân sách mới. Không cần ký lại khi bạn đổi giữa NFT và RWA.</p>
      <details className="vault-section"><summary>Chi tiết kỹ thuật</summary><VaultIdentifiers mandate={mandate}/></details>
    </div> : <fieldset className="vault-setup" disabled={busy}>
      <legend>Ủy quyền ngân sách</legend>
      <label className="vault-field">Ngân sách SOL <input type="number" min="0.000000001" step="0.1" value={budget} onChange={e => setBudget(e.target.value)}/></label>
      <label className="vault-field">Thời hạn <select value={hours} onChange={e => setHours(Number(e.target.value))}>{(config?.durations ?? MANDATE_DURATION_PRESETS).map(item => <option key={item.id} value={item.hours}>{item.label}</option>)}</select></label>
      <div className="vault-policy-badge">
        <span className="vault-policy-icon" aria-hidden="true">◈</span>
        <div><strong>Chính sách chung · NFT + RWA</strong><p>Na tự quyết định mua NFT hay RWA dựa trên yêu cầu của bạn. Bạn chỉ ký một lần, không chọn danh mục.</p></div>
      </div>
      <p className="vault-note">Phantom hiển thị ngân sách cộng rent tài khoản và phí mạng.</p>
      {setupReason && <div className="vault-setup-note"><strong>Chưa thể gửi ủy quyền</strong><p>{setupReason} Bạn vẫn có thể chỉnh các ô để chuẩn bị; chưa có SOL nào được chuyển.</p></div>}
      {configError && <button type="button" className="vault-button" onClick={() => void loadConfig()}>Thử tải lại Na Vault</button>}
      {!setupReason && !validDraft && <p className="vault-note">Kiểm tra ngân sách SOL và thời hạn hợp lệ.</p>}
      <button className="vault-button vault-button-primary" disabled={disabled || !!setupReason || !validDraft} onClick={() => void run('create')}>{busy ? 'Đang xử lý…' : `Ủy quyền ${budget || '0'} SOL bằng Phantom`}</button>
    </fieldset>}
    <details className="vault-section vault-explainer"><summary>Ngân sách này hoạt động thế nào?</summary><p className="vault-note">Bạn ký một giao dịch để tạo và nạp vault. Na chỉ chi trong hạn mức on-chain. Với NFT demo mới, Na chuyển SOL Devnet rồi tự tạo và giao NFT GoBuy DEMO vào ví đã xác minh. Đây là mô phỏng thanh toán, không mua hoặc chuyển NFT marketplace gốc.</p></details>
    {message && <p className="vault-status" role="status">{message}</p>}
    {signature && <div className="vault-signature"><code>{signature}</code><a href={explorerTx(signature)} target="_blank" rel="noreferrer">Xem giao dịch Devnet ↗</a></div>}
    {!!spends.length && <section className="vault-history-section">
      <h3>Lịch sử chuyển SOL từ vault</h3>
      <VaultHistory spends={spends}/>
    </section>}
  </section>
}
