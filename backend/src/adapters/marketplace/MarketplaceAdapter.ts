import type { CommerceProposal } from '@gobuy/shared'
import type { DiscoveryIntent } from '../llm/LLMProvider.js'
export interface MarketplaceAdapter {
  search(intent: DiscoveryIntent): Promise<CommerceProposal[]>
}
