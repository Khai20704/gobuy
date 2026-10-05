import type { CandidateItem, SearchIntent } from '@gobuy/shared'
import type { SearchProvider } from './SearchProvider.js'

export class MockSearchProvider implements SearchProvider {
  readonly name = 'GoBuy DEV fixtures'
  readonly mode = 'mock' as const
  async search(intent: SearchIntent): Promise<CandidateItem[]> {
    const query = intent.product ?? intent.keywords.join(' ')
    const title = /gundam|rx-78/i.test(query) ? 'Gundam RX-78' : /headphone/i.test(query) ? 'Wireless headphones' : /camera/i.test(query) ? 'Camera' : undefined
    if (!title) return []
    const base = title === 'Gundam RX-78' ? 1_000_000 : 100
    return [0.8, 0.84, 0.96].map((fraction, index) => ({
      id: `dev:${index}`, title: `${title} — demo option ${index + 1}`,
      description: 'Synthetic development fixture; no real seller, offer, image, or availability.',
      price: Math.round(base * fraction * 100) / 100, currency: title === 'Gundam RX-78' ? 'VND' : 'USD',
      productUrl: `https://example.com/gobuy-dev/option-${index + 1}`, source: this.name, domain: 'example.com',
      mode: this.mode, kind: intent.collectionSymbol ? 'nft' : 'product', fetchedAt: new Date().toISOString(),
      collectionSymbol: intent.collectionSymbol,
      seller: { name: `Demo seller ${index + 1}`, rating: [4.1, 4.8, 4.6][index], ratingScale: 'five-star',
        reviewCount: [20, 1200, 350][index], verified: index === 1 },
      condition: 'New', signals: { returnsAccepted: index !== 0 },
    }))
  }
}
