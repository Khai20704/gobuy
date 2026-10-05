import { HeliusClient, heliusRpcUrl } from '../backend/dist/nft/helius/HeliusClient.js'
import { HeliusNFTProvider } from '../backend/dist/nft/helius/HeliusNFTProvider.js'
import { scanTensorDevnetListings } from '@gobuy/tensor-adapter'
import { NFTIntentParser, DiscoveryEngine, acquisitionConfig } from '../backend/dist/services/acquisition/discovery.js'
import { nftProviders } from '../backend/dist/services/acquisition/providers.js'
const client = new HeliusClient(), assets = new HeliusNFTProvider(client)
const scan = await scanTensorDevnetListings(heliusRpcUrl(), 1000000000n, 50, AbortSignal.timeout(45000))
console.log(JSON.stringify({ stage: 'scan', count: scan.listings.length }))
for (const listing of scan.listings) {
  try {
    const asset = await assets.getAsset(listing.mint)
    console.log(JSON.stringify({ stage: 'asset', mint: listing.mint, name: asset.name, description: asset.description,
      owner: asset.owner, seller: listing.seller, attributes: asset.attributes }))
    await assets.verifyOwner(listing.mint, listing.listState)
    console.log(JSON.stringify({ stage: 'verified', mint: listing.mint }))
  } catch (error) { console.log(JSON.stringify({ stage: 'verify-failed', mint: listing.mint, code: error.code ?? error.name })) }
}
for (const text of ['Find me an ocean-themed NFT under 1 SOL.', 'Find any NFT under 1 SOL']) {
  const intent = await new NFTIntentParser().parse(text)
  const start = Date.now()
  const reply = await new DiscoveryEngine(nftProviders(), acquisitionConfig().NFT_PROVIDER_TIMEOUT_MS).search(intent)
  console.log(JSON.stringify({ stage: 'search', text, elapsedMs: Date.now() - start, status: reply.status,
    candidates: reply.candidates.map(c => ({ mint: c.mint, name: c.name })), sources: reply.sources, warnings: reply.warnings }))
}
