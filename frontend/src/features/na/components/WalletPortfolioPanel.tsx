import { useEffect, useState } from 'react'
import { assetPositionSchema, walletAssociationSchema, devnetDeliverySchema, walletHoldingSchema, undeliveredPaymentSchema,
  type UndeliveredPayment, type DevnetDelivery, type WalletHolding, type AssetPosition, type WalletAssociation } from '@gobuy/shared'
import { acquisitionApi } from '../../../services/api/acquisition'
import { explorerAccount, explorerTx } from '../../../services/solana/links'
import { deliveryStatusLabel, deliveryPollingFinished } from '../deliveryStatus'

/** Linked wallets and assets Na has recorded for this account, shown in the "Ví & tài sản" tab. */
export function WalletPortfolioPanel({ revision }: { revision: number }) {
  const [wallets, setWallets] = useState<WalletAssociation[]>([])
  const [assets, setAssets] = useState<AssetPosition[]>([])
  const [deliveries, setDeliveries] = useState<DevnetDelivery[]>([])
  const [holdings, setHoldings] = useState<WalletHolding[]>([])
  const [holdingErrors, setHoldingErrors] = useState<string[]>([])
  const [undelivered, setUndelivered] = useState<UndeliveredPayment[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    let active = true
    setBusy(true)
    setError('')
    const sections = [
      { path: '/wallets', label: 'ví liên kết', apply: (value: unknown) => setWallets(walletAssociationSchema.array().parse(value)) },
      { path: '/portfolio', label: 'tài sản đã mua', apply: (value: unknown) => setAssets(assetPositionSchema.array().parse(value)) },
      { path: '/deliveries', label: 'trạng thái giao tài sản', apply: (value: unknown) => setDeliveries(devnetDeliverySchema.array().parse(value)) },
      { path: '/holdings', label: 'số dư Devnet', apply: (value: unknown) => {
        const snapshot = value as { holdings: unknown; errors: string[] }
        const parsed = walletHoldingSchema.array().parse(snapshot.holdings)
        if (!Array.isArray(snapshot.errors) || !snapshot.errors.every(message => typeof message === 'string')) throw new Error('Invalid holdings errors')
        setHoldings(parsed); setHoldingErrors(snapshot.errors)
      } },
      { path: '/undelivered-payments', label: 'thanh toán chờ giao', apply: (value: unknown) => setUndelivered(undeliveredPaymentSchema.array().parse(value)) },
    ]
    void Promise.allSettled(sections.map(async section => {
      const value = await acquisitionApi(section.path)
      if (active) section.apply(value)
    })).then(results => {
      if (!active) return
      const failed = results.flatMap((result, index) => result.status === 'rejected' ? [sections[index].label] : [])
      setError(failed.length ? `Chưa tải được ${failed.join(', ')}. Bấm Làm mới để thử lại. Các mục khác vẫn được hiển thị.` : '')
      setBusy(false)
    })
    return () => { active = false }
  }, [revision, retry])
  const awaitingDelivery = deliveries.some(delivery => !deliveryPollingFinished(delivery))
  useEffect(() => {
    if (!awaitingDelivery) return
    let active = true, running = false
    const poll = async () => {
      if (!active || running || document.hidden) return
      running = true
      try {
        const rows = devnetDeliverySchema.array().parse(await acquisitionApi('/deliveries'))
        if (active) setDeliveries(rows)
      } catch { /* Preserve the last known status on a failed read. */ }
      finally { running = false }
    }
    const timer = window.setInterval(() => { void poll() }, 8000)
    document.addEventListener('visibilitychange', poll)
    return () => { active = false; window.clearInterval(timer); document.removeEventListener('visibilitychange', poll) }
  }, [awaitingDelivery])
  const tracked = new Set([...assets.map(asset => asset.execution.mint), ...deliveries.flatMap(asset => asset.mint ? [asset.mint] : [])])
  const otherHoldings = holdings.filter(asset => !tracked.has(asset.mint))
  const verifiedCount = new Set([...holdings.map(asset => asset.owner + ':' + asset.mint),
    ...assets.filter(asset => asset.ownership === 'verified').map(asset => asset.walletAddress + ':' + asset.execution.mint),
    ...deliveries.filter(asset => asset.ownership === 'verified').map(asset => asset.owner + ':' + asset.mint)]).size
  return <section className="na-portfolio" aria-label="Ví và tài sản">
    <header className="na-panel-head">
      <div><h3>Ví & tài sản</h3><p>{busy ? 'Đang tải…' : `${verifiedCount} tài sản đã xác minh${error || holdingErrors.length ? ' · dữ liệu chưa đầy đủ' : ' trên Devnet'}`}</p></div>
      <button type="button" className="na-panel-refresh" disabled={busy} onClick={() => setRetry(value => value + 1)} aria-label="Làm mới ví và tài sản">
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M20 12a8 8 0 1 1-2.34-5.66M20 4v4h-4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/></svg>
        <span>Làm mới</span>
      </button>
    </header>
    <div className="na-wallet-note">
      <span className="na-wallet-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" focusable="false"><path d="M3 8a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8Z" fill="none" stroke="currentColor" strokeWidth="1.6"/><path d="M16 12h3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/></svg>
      </span>
      <p><strong>GoBuy Wallet · Sắp tích hợp</strong>Đang chờ nhà cung cấp embedded wallet an toàn. Dùng “Kết nối Phantom” ở trên để kết nối ví có sẵn.</p>
    </div>
    {!busy && !wallets.length && !error && <p className="na-empty">Chưa có ví nào được liên kết. Kết nối Phantom trực tiếp, không cần ký tin nhắn.</p>}
    {wallets.map(wallet => <p className="na-wallet-row" key={wallet.address}>
      <span>Ví đã liên kết</span><code>{wallet.address.slice(0, 6)}…{wallet.address.slice(-4)}</code></p>)}
    {error && <p className="na-panel-error" role="alert">{error}</p>}
    {holdingErrors.map(message => <p className="na-panel-error" role="alert" key={message}>{message}</p>)}
    {undelivered.length > 0 && <p className="na-empty">Có {undelivered.length} khoản thanh toán chưa có giao dịch giao tài sản. Đã chi SOL không đồng nghĩa đã nhận NFT/token.</p>}
    {assets.length === 0 && deliveries.length === 0 && holdings.length === 0 && undelivered.length === 0 && !busy && !error && !holdingErrors.length && <p className="na-empty">Chưa tìm thấy tài sản trong ví Devnet đã liên kết.</p>}
    <div className="na-list">{undelivered.map(payment => <article className="na-asset-item" key={payment.kind + payment.id}>
      <strong>{payment.name} · {payment.kind} demo</strong>
      <p>Đã thanh toán · chưa giao tài sản</p>
      <p>Đã chi: {Number(payment.amountLamports) / 1e9} SOL Devnet</p>
      <p>{payment.reason}</p>
      <a href={explorerTx(payment.paymentSignature)} target="_blank" rel="noreferrer">Giao dịch thanh toán Devnet ↗</a>
    </article>)}</div>
    <div className="na-list">{deliveries.map(asset => <article className="na-asset-item" key={asset.kind + asset.id}>
      <strong>{asset.name} · {asset.simulated ? 'Devnet Demo' : 'NFT Devnet'}</strong>
      <p>{deliveryStatusLabel(asset)}</p>
      {asset.recovery?.nextRetryAt && <p>Tự kiểm tra lại lúc {new Date(asset.recovery.nextRetryAt).toLocaleTimeString('vi-VN')}</p>}
      {asset.recovery?.lastError && <p>Chi tiết: {asset.recovery.lastError}</p>}
      <a href={explorerTx(asset.paymentSignature)} target="_blank" rel="noreferrer">Giao dịch thanh toán Devnet ↗</a>
      <p>{asset.phase === 'COMPLETED' ? 'Đã giao' : 'Số lượng cần giao'}: {asset.quantity} · Số dư hiện tại: {asset.balance ?? 'chưa xác minh'}</p>
      <p>{asset.ownership === 'verified' ? 'Đã kiểm tra tài sản trong ví trên chain.' : asset.ownership === 'not_owned' ? 'Tài sản không còn trong ví.' : 'Chưa xác minh quyền sở hữu.'}</p>
      <p>Ví nhận: <code>{asset.owner}</code></p>
      <p>Tài sản gốc: <code>{asset.sourceMint}</code></p>
      {asset.pricing && <p>Giá tham chiếu: {asset.pricing.referencePrice} {asset.pricing.referenceCurrency}/token · {asset.pricing.source}</p>}
      {asset.simulated && <p>Tài sản thử nghiệm, không đại diện quyền sở hữu NFT Mainnet hoặc RWA thật.</p>}
      {asset.mint && <a href={explorerAccount(asset.mint)} target="_blank" rel="noreferrer">Mint Devnet ↗</a>}{' · '}
      {asset.signature && <a href={explorerTx(asset.signature)} target="_blank" rel="noreferrer">Giao dịch giao tài sản ↗</a>}
      {asset.phase !== 'COMPLETED' && <p>{asset.recovery?.status === 'requires_attention' ? 'Cần xử lý nguyên nhân trước khi tiếp tục giao.' : 'Hệ thống tự kiểm tra và thử lại việc giao tài sản.'} Không thanh toán lại.</p>}
    </article>)}</div>
    <div className="na-list">{otherHoldings.map(asset => <article className="na-asset-item" key={asset.tokenAccount}>
      <strong>Token trong ví Devnet</strong><p>Số dư on-chain: {asset.quantity}</p>
      <p>Ví: <code>{asset.owner}</code></p>
      <a href={explorerAccount(asset.mint)} target="_blank" rel="noreferrer">{asset.mint} ↗</a>
    </article>)}</div>
    <div className="na-list">{assets.map(asset => <article className="na-asset-item" key={asset.id}>
      <strong>{asset.sourceAsset.name} · {asset.execution.simulated ? 'Devnet Simulation' : 'Tensor Devnet'}</strong>
      <p>Đã chi: {Number(asset.acquisitionPriceLamports) / 1e9} SOL thử nghiệm.</p>
      <p>{asset.execution.simulated ? 'Quyền sở hữu bản mô phỏng' : 'Quyền sở hữu NFT Tensor'}: {asset.ownership === 'verified' ? 'đã kiểm tra trên chain' : asset.ownership === 'not_owned' ? 'không còn trong ví này' : 'chưa xác minh được RPC'}.</p>
      <p>{asset.valuation.note} Giá trị ước tính / Lãi lỗ: không áp dụng.</p>
      <p>{asset.execution.simulated
        ? `Tài sản nguồn: ${asset.sourceAsset.sourceNetwork} · ${asset.sourceAsset.mint || 'mock'}. Đây không phải NFT bạn sở hữu từ giao dịch mô phỏng.`
        : `NFT Tensor nguồn: ${asset.sourceAsset.sourceNetwork} · ${asset.sourceAsset.mint}. Đây là listing được mua trên Solana Devnet.`}</p>
      {asset.sourceAsset.marketData?.collectionFloorLamports && <p>Floor collection nguồn (tham khảo): {Number(asset.sourceAsset.marketData.collectionFloorLamports) / 1e9} SOL, không phải giá bán đảm bảo.</p>}
      <a href={explorerTx(asset.execution.transactionHash)} target="_blank" rel="noreferrer">Giao dịch Devnet ↗</a>{' · '}
      <a href={explorerAccount(asset.execution.mint)} target="_blank" rel="noreferrer">{asset.execution.simulated ? 'NFT mô phỏng' : 'NFT mua'} ↗</a>
    </article>)}</div>
  </section>
}
