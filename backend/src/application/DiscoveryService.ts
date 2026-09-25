import { searchResponseSchema, type SearchRequest } from '@gobuy/shared'
import type { LLMProvider } from '../adapters/llm/LLMProvider.js'
import type { MarketplaceAdapter } from '../adapters/marketplace/MarketplaceAdapter.js'

export class DiscoveryService {
  constructor(private readonly llm: LLMProvider, private readonly marketplace: MarketplaceAdapter) {}
  async search(request: SearchRequest) {
    const intent = await this.llm.interpret(request)
    const proposals = await this.marketplace.search(intent)
    return searchResponseSchema.parse({
      mode: 'demo', proposals,
      explanation: 'Mock adapters return a selected fixture; text and images are not analyzed. This response contains no authorization verdict.',
    })
  }
}
