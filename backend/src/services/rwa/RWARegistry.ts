import { readFile } from 'node:fs/promises'
import { Connection, PublicKey } from '@solana/web3.js'
import { z } from 'zod'
import { rwaAssetSchema, type RWAAsset, type RWAIntent } from '@gobuy/shared'
import { InputError } from '../../schemas/search.js'
import { mongoDatabase, storageMode } from '../../persistence/mongo.js'
export const RWA_APPROVED_LIST = 'RWA_APPROVED_LIST'
// Full base58 hash of the Solana mainnet-beta genesis block. A truncated value here makes every
// mainnet RPC look like devnet, so `verify` would refuse every approved asset.
export const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'
const approvedListSchema = z.array(rwaAssetSchema).max(500)
export class RWARegistry {
  private readonly assets: RWAAsset[]
  constructor(assets: RWAAsset[], private readonly rpc = new Connection(process.env.RWA_SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com', 'confirmed')) {
    this.assets = approvedListSchema.parse(assets)
    if (new Set(assets.map(asset => asset.mint)).size !== assets.length) throw new Error('Duplicate RWA canonical mint')
    assets.forEach(asset => new PublicKey(asset.mint))
  }
  static async configured() {
    // Mongo is authoritative in production; never fall back to stale file approvals.
    if (storageMode() === 'mongo') {
      const rows = await (await mongoDatabase.get()).collection(RWA_APPROVED_LIST)
        .find({}, { projection: { _id: 0 } }).limit(501).toArray()
      return new RWARegistry(approvedListSchema.parse(rows))
    }
    const path = process.env.RWA_APPROVED_LIST_PATH || process.env.RWA_REGISTRY_PATH
    return new RWARegistry(path ? approvedListSchema.parse(JSON.parse(await readFile(path, 'utf8'))) : [])
  }
  list() { return structuredClone(this.assets) }
  /**
   * Which chain the RWA RPC points at. RWA identity and Jupiter routes are mainnet-only, so this
   * decides between a real quote and an honest DEVNET_EXECUTION_UNAVAILABLE.
   */
  async network(): Promise<'mainnet' | 'devnet' | 'unknown'> {
    try {
      const genesis = await this.rpc.getGenesisHash()
      return genesis === MAINNET_GENESIS ? 'mainnet' : genesis ? 'devnet' : 'unknown'
    } catch { return 'unknown' }
  }
  /** Exact-mint lookup that also returns entries an admin has not approved, for classification only. */
  bySymbol(symbol: string) { return this.assets.filter(asset => asset.symbol.toLowerCase() === symbol.toLowerCase()) }
  /** True only for an exact mint that is approved AND allowed to swap. */
  isApprovedMint(mint: string) { return this.assets.some(asset => asset.mint === mint && asset.verified && asset.allowedForSwap) }
  resolve(intent: RWAIntent): RWAAsset {
    const candidates = this.assets.filter(asset => (!intent.mint || asset.mint === intent.mint)
      && (!intent.symbol || asset.symbol.toLowerCase() === intent.symbol.toLowerCase())
      && (!intent.subtype || asset.category === intent.subtype))
    const allowed = candidates.filter(asset => asset.verified && asset.allowedForSwap)
    if (allowed.length !== 1) throw new InputError(allowed.length > 1
      ? 'Có nhiều RWA đã xác minh; hãy nêu symbol hoặc canonical mint cụ thể.'
      : 'Không có RWA đã xác minh và được phép swap phù hợp qua nguồn đã cấu hình. Không thay thế bằng token ngẫu nhiên.')
    return structuredClone(allowed[0])
  }
  async verify(asset: RWAAsset, wallet?: string) {
    const canonical = this.resolve({ category: 'RWA', mint: asset.mint, symbol: asset.symbol, subtype: asset.category, action: 'SEARCH', currency: 'USDC' })
    if (Date.now() - Date.parse(canonical.updatedAt) > 30 * 86400000 || Date.parse(canonical.updatedAt) > Date.now() + 5000) throw new InputError('Xác minh registry đã cũ; cần đối chiếu lại nguồn issuer.')
    if (canonical.eligibleWallets && (!wallet || !canonical.eligibleWallets.includes(wallet))) throw new InputError('Ví chưa được issuer cho phép giao dịch RWA này.')
    if (await this.rpc.getGenesisHash() !== MAINNET_GENESIS) throw new InputError('RWA phải được xác minh trên mainnet.')
    const result = await this.rpc.getParsedAccountInfo(new PublicKey(asset.mint))
    const value = result.value, data = value?.data
    if (!value || !['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'].includes(value.owner.toBase58())
      || !data || !('parsed' in data) || data.parsed.type !== 'mint'
      || data.parsed.info.decimals !== canonical.decimals || data.parsed.info.isInitialized !== true) {
      throw new InputError('Canonical mint không phải SPL mint hợp lệ hoặc metadata mint không khớp registry.')
    }
    return canonical
  }
}
