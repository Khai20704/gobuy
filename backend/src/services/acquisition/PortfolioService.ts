import { assetPositionSchema, type AssetPosition, type NFTCandidate, type NftDemoReceipt } from '@gobuy/shared'
import { assetStore, type AssetStore } from '../../persistence/AssetStore.js'
import type { ExecutionEngine } from './ExecutionEngine.js'
import { acquisitionLog } from './discovery.js'

export class PortfolioService {
  constructor(private readonly executor: Pick<ExecutionEngine, 'assetOwner'>,
    private readonly positions: AssetStore<AssetPosition> = assetStore('assetPositions')) {}
  async record(userId: string, id: string, walletAddress: string, sourceAsset: NFTCandidate, receipt: NftDemoReceipt) {
    if (receipt.status !== 'CONFIRMED' || !receipt.asset || !receipt.signature || receipt.totalLamports === undefined) return
    const existing = await this.positions.get(userId, id)
    if (existing) return
    const value = assetPositionSchema.parse({ id, userId, walletAddress, assetType: 'NFT', sourceAsset,
      execution: { network: 'devnet', simulated: sourceAsset.provider !== 'tensor', mint: receipt.asset, transactionHash: receipt.signature },
      acquisitionPriceLamports: String(receipt.totalLamports), acquisitionCurrency: 'DEVNET_SOL', acquisitionDate: new Date().toISOString(),
      ownership: 'unknown', ownershipCheckedAt: null,
      valuation: { estimatedMarketValue: null, unrealizedPnL: null, note: sourceAsset.provider === 'tensor'
        ? 'NFT được mua trên Tensor Devnet bằng SOL thử nghiệm; không có giá trị đầu tư.'
        : 'Mô phỏng Devnet không có giá trị đầu tư. Giá listing/floor của tài sản nguồn chỉ để tham khảo.' } })
    await this.positions.put(userId, id, value, true)
    acquisitionLog('portfolio', { outcome: 'recorded' })
  }
  async list(userId: string) {
    const rows = (await this.positions.list(userId)).map(row => assetPositionSchema.parse(row))
    // Ownership is refreshed from chain, never inferred from the database record.
    return Promise.all(rows.map(async row => {
      try {
        const owner = await Promise.race([this.executor.assetOwner(row.execution.mint), new Promise<never>((_, reject) => {
          const timer = setTimeout(() => reject(new Error('RPC timeout')), 8000); timer.unref()
        })])
        return { ...row, ownership: owner === row.walletAddress ? 'verified' as const : 'not_owned' as const, ownershipCheckedAt: new Date().toISOString() }
      } catch { return { ...row, ownership: 'unknown' as const, ownershipCheckedAt: null } }
    }))
  }
}
