import { useEffect, useState } from 'react'
import { assetPositionSchema, walletAssociationSchema, type AssetPosition, type WalletAssociation } from '@gobuy/shared'
import { acquisitionApi } from '../../../services/api/acquisition'
import { explorerAccount, explorerTx } from '../../../services/solana/links'

export function WalletPortfolioPanel({ revision }: { revision: number }) {
  const [wallets, setWallets] = useState<WalletAssociation[]>([])
  const [assets, setAssets] = useState<AssetPosition[]>([])
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    let active = true
    void Promise.all([acquisitionApi('/wallets'), acquisitionApi('/portfolio')]).then(([wallets, assets]) => {
      if (!active) return
      setWallets(walletAssociationSchema.array().parse(wallets)); setAssets(assetPositionSchema.array().parse(assets)); setError('')
    }).catch(() => { if (active) setError('Chưa tải được ví hoặc tài sản. Quyền sở hữu chưa được xác nhận.') })
    return () => { active = false }
  }, [revision, retry])
  return <details className="chat-request-history asset-portfolio"><summary>Ví &amp; My Assets · {assets.length}</summary>
    <button type="button" disabled>GoBuy Wallet · Sắp tích hợp</button>
    <p>GoBuy Wallet đang chờ nhà cung cấp embedded wallet an toàn. Chưa có chức năng tạo ví hoặc ký. Dùng “Kết nối Phantom” để kết nối ví có sẵn.</p>
    {!wallets.length && <p>Kết nối Phantom trực tiếp, không cần ký tin nhắn. Phantom chỉ yêu cầu ký giao dịch khi bạn chọn mua.</p>}
    {wallets.map(wallet => <p key={wallet.address}>Ví đã liên kết trước đây · {wallet.address.slice(0, 6)}…{wallet.address.slice(-4)}. Cần kết nối lại Phantom để ký giao dịch.</p>)}
    {error && <p role="alert">{error}</p>}
    <button type="button" onClick={() => setRetry(value => value + 1)}>Làm mới quyền sở hữu</button>
    {assets.map(asset => <article key={asset.id}>
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
    </article>)}
  </details>
}
