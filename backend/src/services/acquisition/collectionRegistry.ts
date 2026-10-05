// Identity hints only, never NFT inventories or market data. Each hit is checked with Helius at runtime.
// Source: https://www.nfw.fun/docs (Accepted collections), cross-checked against the truncated addresses
// that page prints for each entry.
// Independently checked with Helius Mainnet getAsset + getAssetsByGroup on 2026-10-04:
//   y00ts  -> getAsset(4mKS…Vzy2) is V1_NFT; getAssetsByGroup returns 20 assets.
//   DeGods -> getAsset(6Xxj…JzNr) is V1_NFT named "DeGods" (symbol DGOD); getAssetsByGroup returns 20 assets.
// Aliases must be written in the resolver's normalized form (lowercase, spaces replaced by underscores).
export const collectionRegistry = [{
  name: 'y00ts', aliases: ['y00ts', 'yoots'], network: 'mainnet' as const,
  collectionId: '4mKSoDDqApmF1DqXvVTSL6tu2zixrSSNjqMxUnwvVzy2',
  source: 'https://www.nfw.fun/docs',
}, {
  name: 'DeGods', aliases: ['degods', 'degod', 'deadgods'], network: 'mainnet' as const,
  collectionId: '6XxjKYFbcndh2gDcsUrmZgVEsoDxXMnfsaGY6fpTJzNr',
  source: 'https://www.nfw.fun/docs',
}]
