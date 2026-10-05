import { useEffect, useRef, useState } from 'react'
import { Transaction } from '@solana/web3.js'
import { MANDATE_DURATION_PRESETS, createMandateInputSchema, mandateConfigResponseSchema, mandateQueryResponseSchema, mandateSpendsResponseSchema,
  unsignedMandateTransactionSchema, mandateSubmitResponseSchema, mandateSpendResponseSchema, solToLamports,
  type MandateConfigResponse, type SerializedMandateView, type MandateSpendRecord, type MandateOwnerAction, type MandateCategory } from '@gobuy/shared'
import { mandateApi } from '../../../services/api/mandate'
import { acquisitionApi } from '../../../services/api/acquisition'
import { phantomProvider, signPhantomMessage } from '../../../services/solana/phantom'
import { ExpiredDevnetTransactionError, signDevnetTransaction } from '../../../services/solana/walletSafety'
import { prependCreateMandateComputeBudget } from '../../../services/solana/createMandateComputeBudget'
import { devnetConnection, requireDevnet } from '../../../services/solana/network'
import { explorerTx } from '../../../services/solana/links'
import { VaultHistory, VaultIdentifiers, VaultMetrics, VaultProgress, VaultStatusChips } from './VaultOverview'

export function NaVaultPanel({ wallet, devnetReady, onChanged, revision = 0 }: { wallet: string; devnetReady: boolean; onChanged(): void; revision?: number }) {
  const [config, setConfig] = useState<MandateConfigResponse | null>(null)
  const [configError, setConfigError] = useState('')
  const [mandate, setMandate] = useState<SerializedMandateView | null>(null)
  const [spends, setSpends] = useState<MandateSpendRecord[]>([])
  const [budget, setBudget] = useState('1'), [hours, setHours] = useState(24)
  const [category, setCategory] = useState<MandateCategory>('NFT')
  const [message, setMessage] = useState(''), [busy, setBusy] = useState(false), [loaded, setLoaded] = useState(false)
  const [signature, setSignature] = useState<string | null>(null)
  const [amount, setAmount] = useState('0.2'), [reference, setReference] = useState('Demo settlement 1')
  const [switchTarget, setSwitchTarget] = useState<MandateCategory | null>(null)
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
  // After the old mandate is revoked and closed, prefill the category the owner wants to switch to.
  useEffect(() => {
    if (!switchTarget || mandate || !loaded) return
    setCategory(switchTarget); setSwitchTarget(null)
  }, [mandate, loaded, switchTarget])
  async function run(action: MandateOwnerAction | 'spend'): Promise<boolean> {
    if (lock.current || !wallet || !devnetReady) return false
    lock.current = true; setBusy(true); setMessage(''); setSignature(null)
    const owner = wallet
    try {
      const provider = await phantomProvider()
      if (provider.publicKey?.toBase58() !== owner) throw new Error('Ví đang kết nối không khớp chủ mandate.')
      if (action === 'spend') {
        // Authentication only, reused after the first association; never authorizes spending.
        const linked = await acquisitionApi('/wallets') as Array<{ address: string; verified: boolean }>
        if (!linked.some(value => value.address === owner && value.verified)) {
          const challenge = await acquisitionApi('/wallets/challenge', { address: owner }) as { id: string; message: string }
          await acquisitionApi('/wallets/verify', { id: challenge.id, signature: await signPhantomMessage(provider, challenge.message) })
        }
        if (currentWallet.current !== owner || provider.publicKey?.toBase58() !== owner) throw new Error('Ví đã thay đổi; chưa gửi yêu cầu chi tiêu.')
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(reference))
        const assetHash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
        const result = mandateSpendResponseSchema.parse(await mandateApi('/spend', { owner, amountLamports: solToLamports(Number(amount)).toString(),
          category: mandate?.allowedCategory === 'RWA' ? 'RWA' : 'NFT', assetHash, reference }))
        if (currentWallet.current === owner) { setMessage(result.message); setSignature(result.signature) }
      } else {
        const connection = devnetConnection()
        try {
          await requireDevnet(connection)
          for (let attempt = 0; attempt < 2; attempt++) {
            // Rebuild through the backend: it retains the exact message for validation.
            const built = unsignedMandateTransactionSchema.parse(await mandateApi('/transaction', { owner, action,
              ...(action === 'create' ? { create: { budgetSol: Number(budget), expiresInHours: hours, category } } : {}) }))
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
      if (action === 'spend') await refresh(owner)
      else await refresh(owner).catch(() => {
        // Keep the submission result visible if a subsequent history refresh fails.
      }); onChanged()
      return true
    } catch (error) {
      if (currentWallet.current === owner) setMessage(error instanceof Error ? error.message : 'Chưa xác định được kết quả. Kiểm tra lịch sử trước khi thử lại.')
      return false
    } finally { lock.current = false; setBusy(false) }
  }
  // Category switching is not editable on-chain: revoke the budget, close the mandate, sign a new one.
  async function switchCategory(target: MandateCategory) {
    if (!mandate || lock.current) return
    setSwitchTarget(target)
    const done = await run(mandate.active ? 'revoke' : 'withdraw')
    if (!done) setSwitchTarget(null)
  }
  const otherCategory: MandateCategory = mandate?.allowedCategory === 'RWA' ? 'NFT' : 'RWA'
  const canSwitch = !!mandate && mandate.allowedCategory !== 'ANY' && mandate.status !== 'CLOSED'
  const active = mandate?.active && mandate.expiresAt >= Date.now() / 1000
  const disabled = busy || !wallet || !devnetReady || !loaded
  const setupReason = configError || (!config ? 'Đang kiểm tra cấu hình Na Vault…'
    : !config.vaultProgramId ? 'Chưa cấu hình chương trình Na Vault trên Devnet.'
    : !config.autonomousExecutionReady ? 'Na Vault Devnet chưa sẵn sàng nhận ủy quyền. Vui lòng thử lại sau.'
    : !wallet ? 'Kết nối Phantom để tiếp tục.'
    : !devnetReady ? 'Chọn Devnet trong Phantom và xác nhận mạng ở phía trên.'
    : !loaded ? 'Chưa đọc được mandate của ví. Bấm kiểm tra ngân sách để thử lại.' : '')
  const validDraft = createMandateInputSchema.safeParse({ budgetSol: Number(budget), expiresInHours: hours, category }).success
  return <section className="na-vault-panel" aria-label="Na Vault">
    <header className="vault-heading">
      <div><span className="vault-eyebrow">NA VAULT</span><h2>Ngân sách cho Na</h2></div>
      <span className="vault-network">DEVNET</span>
    </header>
    <p className="vault-lead">Hạn mức riêng cho Na. SOL còn lại trong Phantom nằm ngoài quyền chi tiêu của Na.</p>
    {mandate ? <div className="vault-body">
      <VaultStatusChips mandate={mandate}/>
      <VaultProgress mandate={mandate}/>
      <VaultMetrics mandate={mandate}/>
      <div className="vault-actions">
        {mandate.active && <button className="vault-button" disabled={disabled} onClick={() => void run('revoke')}>Thu hồi và trả SOL còn lại</button>}
        {!active && <button className="vault-button" disabled={disabled} onClick={() => void run('withdraw')}>Rút số dư, rent và đóng mandate</button>}
      </div>
      {canSwitch && <section className="vault-section vault-switch">
        <h3 className="vault-switch-title">Đổi sang {otherCategory}</h3>
        <p className="vault-note">Danh mục <strong>{mandate.allowedCategory}</strong> đã ghi on-chain khi ký nên không sửa tại chỗ được. Cách đổi (2 bước): thu hồi ngân sách — SOL còn lại trả về ví — rồi đóng mandate, sau đó ký mandate mới với danh mục {otherCategory}. Na không mua chéo danh mục.</p>
        <button className="vault-button" disabled={disabled} onClick={() => void switchCategory(otherCategory)}>{active ? `Thu hồi để đổi sang ${otherCategory}` : `Đóng mandate để ký ${otherCategory}`}</button>
      </section>}
      {active && <details className="vault-section"><summary>Demo chi tiêu từ vault (không mua tài sản)</summary>
        <p className="vault-note">Agent ký giao dịch và trả phí; vault chuyển SOL. Dùng cùng mã và số tiền để kiểm tra lại mà không chi trùng.</p>
        <div className="vault-form-row">
          <label className="vault-field">Số SOL <input type="number" min="0.000000001" step="0.01" value={amount} onChange={e => setAmount(e.target.value)}/></label>
          <label className="vault-field">Mã khoản chi <input maxLength={120} value={reference} onChange={e => setReference(e.target.value)}/></label>
        </div>
        <button className="vault-button vault-button-primary" disabled={disabled || !config?.autonomousExecutionReady} onClick={() => void run('spend')}>Chuyển SOL demo</button>
      </details>}
      <p className="vault-note">Muốn đổi hạn mức? Thu hồi và đóng mandate hiện tại, rồi ký tạo ngân sách mới.</p>
      <details className="vault-section"><summary>Chi tiết kỹ thuật</summary><VaultIdentifiers mandate={mandate}/></details>
    </div> : <fieldset className="vault-setup" disabled={busy}>
      <legend>Thiết lập ngân sách</legend>
      <label className="vault-field">Ngân sách SOL <input type="number" min="0.000000001" step="0.1" value={budget} onChange={e => setBudget(e.target.value)}/></label>
      <div className="vault-form-row">
        <label className="vault-field">Thời hạn <select value={hours} onChange={e => setHours(Number(e.target.value))}>{(config?.durations ?? MANDATE_DURATION_PRESETS).map(item => <option key={item.id} value={item.hours}>{item.label}</option>)}</select></label>
        <label className="vault-field">Danh mục <select value={category} onChange={e => setCategory(e.target.value as MandateCategory)}><option>NFT</option><option>RWA</option><option value="ANY">Tất cả</option></select></label>
      </div>
      <p className="vault-note">Phantom hiển thị ngân sách cộng rent tài khoản và phí mạng. Danh mục là ràng buộc on-chain: mandate NFT chỉ mua NFT, mandate RWA chỉ mua RWA.</p>
      {setupReason && <div className="vault-setup-note"><strong>Chưa thể gửi ủy quyền</strong><p>{setupReason} Bạn vẫn có thể chỉnh các ô để chuẩn bị; chưa có SOL nào được chuyển.</p></div>}
      {configError && <button type="button" className="vault-button" onClick={() => void loadConfig()}>Thử tải lại Na Vault</button>}
      {!setupReason && !validDraft && <p className="vault-note">Kiểm tra ngân sách SOL, thời hạn và danh mục hợp lệ.</p>}
      <button className="vault-button vault-button-primary" disabled={disabled || !!setupReason || !validDraft} onClick={() => void run('create')}>{busy ? 'Đang xử lý…' : `Ủy quyền ${budget || '0'} SOL bằng Phantom`}</button>
    </fieldset>}
    <details className="vault-section vault-explainer"><summary>Ngân sách này hoạt động thế nào?</summary><p className="vault-note">Bạn ký một giao dịch để tạo và nạp vault. Agent có thể thực hiện nhiều khoản chi trong hạn mức on-chain. Demo hiện chuyển SOL, chưa tự mua NFT/RWA; giao dịch marketplace vẫn cần chữ ký riêng.</p></details>
    {wallet && config?.vaultProgramId && <div className="vault-actions"><button className="vault-button" disabled={busy} onClick={() => void refresh().catch(error => setMessage(error.message))}>Kiểm tra ngân sách và lịch sử</button></div>}
    {message && <p className="vault-status" role="status">{message}</p>}
    {signature && <div className="vault-signature"><code>{signature}</code><a href={explorerTx(signature)} target="_blank" rel="noreferrer">Xem giao dịch Devnet ↗</a></div>}
    {!!spends.length && <section className="vault-history-section">
      <h3>Lịch sử chuyển SOL từ vault</h3>
      <VaultHistory spends={spends}/>
    </section>}
  </section>
}
