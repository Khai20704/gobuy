import type { NFTCandidate, NFTSearchIntent } from '@gobuy/shared'
import { demoArt } from '../nftDemo/catalog.js'
import type { NFTDiscoveryProvider } from './discovery.js'

export class MockNFTProvider implements NFTDiscoveryProvider {
  readonly name = 'Na Mock Gallery'
  async search(_request: NFTSearchIntent): Promise<NFTCandidate[]> {
    return demoArt.map(art => ({ id: art.id, provider: this.name, sourceNetwork: 'mock', mint: null,
      name: art.name, description: art.tags.join(' '), image: `/api/nft-demo/art/${art.id}`, collection: 'Na Mock Gallery', attributes: [],
      listing: { priceLamports: String(art.priceLamports), currency: 'SOL', seller: null, url: '', observedAt: new Date().toISOString() },
      relevance: 0, reasons: [], warnings: ['Tranh mẫu tạo từ code, không phải listing marketplace.'] }))
  }
  async refresh(candidate: NFTCandidate) { return (await this.search({} as NFTSearchIntent)).find(c => c.id === candidate.id) }
}
