import type { CandidateItem, SearchIntent } from '@gobuy/shared'
import type { SearchProvider } from './SearchProvider.js'
import { recordSourceEvidence } from '../verification/evidence.js'

export class MockSneakerProvider implements SearchProvider {
  readonly name = 'GoBuy sneaker demo'
  readonly mode = 'mock' as const
  unavailable(intent: SearchIntent) { return /jordan|sneaker|shoe/i.test(intent.product ?? intent.keywords.join(' ')) ? undefined : 'Sneaker demo only.' }
  async search(_intent: SearchIntent): Promise<CandidateItem[]> {
    // Fixed inventory. Never create a lower price to fit a user's budget.
    return [242, 265].map((price, index) => recordSourceEvidence({ id: `sneaker:${index}`, title: 'Jordan 1 Chicago',
      price, currency: 'USD', source: this.name, domain: 'example.com', mode: this.mode, kind: 'product',
      productUrl: `https://example.com/sneaker-demo/${index}`, fetchedAt: new Date().toISOString(),
      model: 'Jordan 1', stockStatus: 'IN_STOCK', productRating: 4.7, productReviewCount: 100, purchaseCount: 400,
      costs: { currency: 'USD', shipping: 0, requiredFees: 0 },
      seller: { name: `Synthetic sneaker seller ${index + 1}`, rating: 98, ratingScale: 'percent', reviewCount: 500 },
      signals: {}, description: 'Synthetic demo inventory. No real seller or authenticity verification.',
    }))
  }
}
