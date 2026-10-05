import type { RWAAsset } from '@gobuy/shared'
import { normalizeIntentText } from '../acquisition/intentLanguage.js'
import { RWARegistry } from './RWARegistry.js'
import { extractRWASymbol, isRWARequest, parseRWAIntent } from './RWAIntent.js'

/**
 * The single source of truth for "is this an RWA or an NFT?".
 *
 * Order of evidence:
 *  1. an EXACT approved mint in RWA_APPROVED_LIST -> RWA
 *  2. an RWA-shaped request (registry symbol present but not approved, or RWA wording) -> RWA/BLOCKED
 *  3. verified NFT evidence (caller-supplied predicate over existing NFT discovery) -> NFT
 *  4. neither -> UNKNOWN
 *
 * A failed RWA lookup NEVER falls back to the NFT flow: that is how a counterfeit "NVDAx" would be
 * silently bought as if it were an NFT.
 */

export type AssetClassification = 'RWA' | 'NFT' | 'UNKNOWN'

export interface AssetResolution {
  assetType: AssetClassification
  reason: string
  symbol?: string
  mint?: string
  approved?: RWAAsset
  /** True when this looks like an RWA request that cannot be tied to an approved mint. */
  blocked: boolean
}

export class AssetResolver {
  constructor(private readonly registry: RWARegistry,
    /** Existing NFT discovery evidence, injected so this resolver never talks to marketplaces itself. */
    private readonly nftEvidence: (text: string) => boolean = () => false) {}

  resolve(text: string): AssetResolution {
    const assets = this.registry.list()
    const symbol = extractRWASymbol(text, assets)
    const rwaFlavoured = isRWARequest(text, assets)
    try {
      const intent = parseRWAIntent(text, assets)
      // An intent that names no symbol and no mint identifies no asset, so it must never resolve to
      // an arbitrary approved one (that is how "Mua NFT dưới 1 SOL" would become an RWA).
      if (!intent.symbol && !intent.mint) throw new Error('no asset identifier')
      const approved = this.registry.resolve(intent)
      return { assetType: 'RWA', reason: 'approved_mint', symbol: approved.symbol, mint: approved.mint, approved, blocked: false }
    } catch {
      // No approved asset matched. Decide whether this was an RWA attempt before considering NFT.
    }
    const sameSymbol = !!symbol && assets.some(asset => asset.symbol.toLowerCase() === symbol.toLowerCase())
    // A symbol-shaped token carrying money (USDC/USD/$/SOL) is an RWA attempt even when it is not in
    // the registry. It must block, never fall through to NFT discovery.
    const symbolWithMoney = !!symbol && /\b(usdc|usd|sol)\b|\$/.test(normalizeIntentText(text))
    if (rwaFlavoured || sameSymbol || symbolWithMoney) {
      // An empty list is an operator problem, not a counterfeit: say so instead of implying the
      // requested asset failed an authenticity check it was never able to run.
      return { assetType: 'RWA', symbol, blocked: true,
        reason: assets.length === 0 ? 'registry_empty'
          : sameSymbol ? 'symbol_not_approved' : symbolWithMoney ? 'unapproved_symbol' : 'rwa_not_in_registry' }
    }
    // The word "NFT" is unambiguous; everything else needs real NFT discovery evidence.
    if (this.nftEvidence(text) || /\bnft\b/.test(normalizeIntentText(text))) {
      return { assetType: 'NFT', reason: 'nft_discovery', symbol, blocked: false }
    }
    return { assetType: 'UNKNOWN', reason: symbol ? 'unresolved_asset' : 'no_asset', symbol, blocked: false }
  }
}
