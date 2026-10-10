import { useEffect, useRef, useState } from 'react'
import { Transaction } from '@solana/web3.js'
import { base58Encode, mandateQueryResponseSchema, maxAllowedDebit, TENSOR_MARKETPLACE_PROGRAM_ID,
  type DiscoveryReply, type NFTCandidate, type NftPurchaseResult, type SerializedNftPurchaseAuthorization } from '@gobuy/shared'
import { nftPurchaseApi } from '../../../services/api/nftPurchase'
import { mandateApi } from '../../../services/api/mandate'
import { phantomProvider } from '../../../services/solana/phantom'
import { signDevnetTransaction } from '../../../services/solana/walletSafety'
import { devnetConnection, requireDevnet } from '../../../services/solana/network'
import { explorerTx, explorerAccount } from '../../../services/solana/links'
import { genuineDeliveryVerified, genuineListingAvailable } from '../genuinePurchase'
import { authorizationRetrySafe, matchesPurchaseContinuation, type PurchaseContinuation } from '../authorizationRecovery'

export function GenuineNftPurchase({ discovery, candidate, owner, ready, disabled, storageScope, onPending, onResult }:
  { discovery: DiscoveryReply; candidate: NFTCandidate; owner: string; ready: boolean; disabled: boolean; storageScope: string;
    onPending(): void; onResult(result: NftPurchaseResult): void }) {
  const [authorization, setAuthorization] = useState<SerializedNftPurchaseAuthorization | null>(null)
  const [live, setLive] = useState(false), [loaded, setLoaded] = useState(false), [busy, setBusy] = useState(false)
  const [message, setMessage] = useState(''), [pendingAuth, setPendingAuth] = useState(false)
  const wallet = useRef(owner), lock = useRef(false)
  wallet.current = owner
  const authKey = storageScope + ':nft-authorization:' + owner
  const continuationKey = authKey + ':buy'
  const price = BigInt(candidate.listing.priceLamports)
  const ceiling = price > 0n ? maxAllowedDebit(price) : 0n
  const eligible = genuineListingAvailable(discovery, candidate) && price <= BigInt(discovery.intent.maximumLamports)
  const continuation = { discoveryId: discovery.id, candidateId: candidate.id, owner,
    maximumLamports: discovery.intent.maximumLamports, ceiling: ceiling.toString() }
  async function refresh() {
    const current = owner
    const [config, auth] = await Promise.all([nftPurchaseApi.config(), nftPurchaseApi.authorization(current)])
    if (wallet.current !== current) return
    setLive(config.liveExecutionEnabled); setAuthorization(auth); setLoaded(true)
    if (auth) { localStorage.removeItem(authKey); setPendingAuth(false) }
    else {
      const saved = localStorage.getItem(authKey)
      setPendingAuth(!!saved)
      if (saved && !lock.current) {
        const attempt = JSON.parse(saved)
        const connection = devnetConnection(); await requireDevnet(connection)
        if (await authorizationRetrySafe(attempt, connection)) {
          // Read the finalized account again after checking expiry, before unlocking.
          const latest = await nftPurchaseApi.authorization(current)
          if (wallet.current !== current || localStorage.getItem(authKey) !== saved) return
          setAuthorization(latest)
          localStorage.removeItem(authKey); setPendingAuth(false)
          setMessage(latest ? 'Đã xác minh uỷ quyền on-chain.' : 'Chưa có uỷ quyền on-chain; có thể ký yêu cầu mới.')
        } else if (!attempt.blockhash) {
          setMessage('Bản ghi cũ cần đối chiếu signature: ' + (attempt.signature || 'không có') + '. Chưa đủ bằng chứng để ký lại.')
        }
      }
    }
  }
  useEffect(() => {
    setLoaded(false); setAuthorization(null); setPendingAuth(!!localStorage.getItem(authKey)); setMessage('')
    if (!owner || !ready || !eligible) return
    let active = true
    const poll = () => { if (active) void refresh().catch(error => { if (active) setMessage(error.message) }) }
    poll(); const timer = window.setInterval(poll, 8000)
    return () => { active = false; window.clearInterval(timer) }
  }, [owner, ready, eligible, authKey])
  const approved = !!authorization && authorization.version === 1 && authorization.status === 'ACTIVE'
    && authorization.owner === owner && authorization.recipient === owner && authorization.marketplace === TENSOR_MARKETPLACE_PROGRAM_ID
    && authorization.expiresAt > Date.now() / 1000 && BigInt(authorization.remainingLamports) >= ceiling
  async function authorize() {
    if (lock.current || disabled || !ready || pendingAuth || localStorage.getItem(authKey) || authorization || !eligible) return
    lock.current = true; setBusy(true)
    const current = owner
    try {
      const connection = devnetConnection(); await requireDevnet(connection)
      const state = mandateQueryResponseSchema.parse(await mandateApi('?owner=' + encodeURIComponent(current))).mandate
      if (!state || !state.active || state.closed || state.expiresAt <= Date.now() / 1000) throw new Error('Tạo Na Vault còn hiệu lực trong bảng Ngân sách trước khi uỷ quyền mua NFT.')
      const input = { maxTotalDebitSol: Number(ceiling) / 1e9, expiresInHours: 1 }
      const built = await nftPurchaseApi.buildAuthorization(current, input)
      const provider = await phantomProvider()
      if (wallet.current !== current || provider.publicKey?.toBase58() !== current) throw new Error('Ví đã thay đổi. Chưa ký.')
      if (Date.parse(built.expiresAt) <= Date.now()) throw new Error('Yêu cầu ký hết hạn. Chưa gửi.')
      setMessage('Phantom sẽ yêu cầu ký uỷ quyền mua NFT riêng. Sau khi xác minh on-chain, Na sẽ tiếp tục đúng yêu cầu BUY này trong ngân sách đã lưu.')
      const tx = Transaction.from(Uint8Array.from(atob(built.transaction), char => char.charCodeAt(0)))
      const signed = await signDevnetTransaction(provider, tx)
      if (wallet.current !== current || provider.publicKey?.toBase58() !== current) throw new Error('Ví đã thay đổi; chưa gửi.')
      // Persist before POST. A dropped HTTP response must not invite another signature.
      if (!signed.signature) throw new Error('Chưa có chữ ký owner. Không gửi giao dịch.')
      localStorage.setItem(continuationKey, JSON.stringify({ ...continuation, state: 'authorized-request' }))
      localStorage.setItem(authKey, JSON.stringify({ createdAt: Date.now(), signature: base58Encode(signed.signature), blockhash: signed.recentBlockhash })); setPendingAuth(true)
      const result = await nftPurchaseApi.submitAuthorization(current, input, btoa(String.fromCharCode(...signed.serialize())))
      if (wallet.current !== current) return
      setMessage(result.message)
      if (result.status === 'FAILED') { localStorage.removeItem(authKey); localStorage.removeItem(continuationKey); setPendingAuth(false) }
      await refresh()
    } catch (error) { if (wallet.current === current) setMessage(error instanceof Error ? error.message : 'Chưa rõ kết quả uỷ quyền. Kiểm tra lại; không ký lại.') }
    finally { lock.current = false; setBusy(false) }
  }
  async function buy() {
    if (lock.current || disabled || !ready || !eligible || !approved || !live) return
    lock.current = true; setBusy(true)
    try {
      await requireDevnet(devnetConnection())
      if (wallet.current !== owner) throw new Error('Ví đã thay đổi.')
      if (Date.parse(discovery.expiresAt) <= Date.now()) throw new Error('Yêu cầu BUY đã hết hạn. Hãy tạo yêu cầu mới.')
      // Durable before POST: reloads and uncertain responses must never auto-submit again.
      localStorage.setItem(continuationKey, JSON.stringify({ ...continuation, state: 'started' }))
      onPending()
      const result = await nftPurchaseApi.purchase(discovery.id, candidate.id, owner)
      if (wallet.current === owner) onResult(result)
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Chưa rõ kết quả; chỉ kiểm tra đơn ban đầu, không mua lại.') }
    finally { lock.current = false; setBusy(false) }
  }
  useEffect(() => {
    if (!approved || !live || busy || disabled || !ready || !eligible || lock.current
      || Date.parse(discovery.expiresAt) <= Date.now()) return
    const saved = localStorage.getItem(continuationKey)
    if (!saved) return
    try {
      if (matchesPurchaseContinuation(JSON.parse(saved) as PurchaseContinuation, continuation)) void buy()
    } catch { /* Malformed continuation never grants permission to buy. */ }
  }, [approved, live, busy, disabled, ready, eligible, discovery.id, candidate.id, owner])
  if (!eligible) return <p className="candidate-warning">{candidate.sourceNetwork === 'mainnet' ? 'Mainnet chỉ tham khảo.' : 'Chưa có listing Tensor Devnet đủ điều kiện cho yêu cầu BUY. Không mua và không thay bằng NFT DEMO.'}</p>
  return <section aria-label="Mua NFT gốc">
    <p>Mint gốc: {candidate.mint}</p><p>Người bán: {candidate.listing.seller}</p>
    <p>Tổng chi tối đa dự kiến: {Number(ceiling) / 1e9} SOL (giá + dự phòng phí/rent). Không phải báo giá phí chính xác.</p>
    <p>Sau khi uỷ quyền được xác minh on-chain, Na tự tiếp tục yêu cầu BUY này; không tự gửi lại giao dịch mua chưa rõ kết quả.</p>
    {!ready && <p>Kết nối, xác minh liên kết ví và chọn Devnet. Tạo Na Vault trong bảng Ngân sách nếu chưa có.</p>}
    {loaded && !live && <p>Mua NFT đang tắt. Chờ người vận hành hoàn tất upgrade và mở phiên demo.</p>}
    {authorization && !approved && <p>Uỷ quyền hiện tại đã hết hạn, không khớp hoặc không đủ ngân sách. Cần chủ ví xử lý trước; Na không tự tăng hạn mức.</p>}
    {!authorization && <button disabled={disabled || busy || !ready || !loaded || pendingAuth} onClick={() => void authorize()}>
      {pendingAuth ? 'Đang xác minh uỷ quyền — không ký lại' : `Ký uỷ quyền NFT tối đa ${Number(ceiling) / 1e9} SOL · tối đa 1 giờ`}</button>}
    <button disabled={disabled || busy || !ready || !approved || !live} onClick={() => void buy()}>Mua NFT gốc trên Devnet</button>
    <p role="status">{message}</p>
  </section>
}

export function GenuinePurchaseResult({ result }: { result: NftPurchaseResult }) {
  const verified = genuineDeliveryVerified(result)
  return <section className="chat-art" aria-live="polite">
    <strong>{verified ? 'Đã xác minh giao NFT gốc · finalized' : result.status === 'CONFIRMED' ? 'Chưa đủ bằng chứng giao NFT' : result.status}</strong>
    <p>{result.status === 'CONFIRMED' && !verified ? 'Tiếp tục đối soát; không mua lại.' : result.message}</p>
    {result.signature && <a href={explorerTx(result.signature)} target="_blank" rel="noreferrer">Giao dịch Devnet ↗</a>}
    {verified && <><p>Mint: {result.mint} · Đã chuyển tới {result.delivery!.owner}</p>
      <a href={explorerAccount(result.receipt!.address)} target="_blank" rel="noreferrer">Receipt on-chain ↗</a>
      <p>Tổng debit: {Number(result.receipt!.totalDebitLamports) / 1e9} SOL</p></>}
  </section>
}
