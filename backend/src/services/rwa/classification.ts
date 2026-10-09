import { RWARegistry } from './RWARegistry.js'
import { AssetResolver, type AssetResolution } from './AssetResolver.js'

/** Deliberately narrow grammar: no asset names, symbols, addresses or mixed RWA requests. */
export function isGenericNFTRequest(text: string) {
  return /^(?:buy|purchase|find|search for|mua|tim)\s+(?:any\s+)?nfts?\s+(?:under|below|duoi|toi da)\s+\d+(?:[.,]\d+)?\s*sol[.!]?$/i.test(
    text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').trim())
}
export async function classifyAssetIntent(text: string, evidence: (text: string) => boolean,
  load = () => RWARegistry.configured()): Promise<AssetResolution> {
  const start = performance.now()
  if (isGenericNFTRequest(text)) {
    console.info('[IntentLatency]', JSON.stringify({ path: 'generic_nft', registryRead: false, totalMs: performance.now() - start }))
    return { assetType: 'NFT', reason: 'nft_discovery', blocked: false }
  }
  const identifier = text.trim()
  const exactMint = /^(?:[1-9A-HJ-NP-Za-km-z]{32,44}|(?:ethereum|base|arbitrum|bsc|polygon|avalanche|gnosis|mantle|ink):0x[0-9a-fA-F]{40})$/.test(identifier)
  const registry = exactMint ? await RWARegistry.forExactMint(identifier.includes(':') ? identifier.toLowerCase() : identifier) : await load()
  const loaded = performance.now()
  const result = new AssetResolver(registry, evidence).resolve(text)
  console.info('[IntentLatency]', JSON.stringify({ path: 'registry', registryMs: loaded - start,
    processingMs: performance.now() - loaded, totalMs: performance.now() - start }))
  return result
}
