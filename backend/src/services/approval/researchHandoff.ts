import type { CommerceDecision, ResearchHandoff } from '@gobuy/shared'

export function createResearchHandoff(decision: CommerceDecision): ResearchHandoff {
  return { decisionId: decision.id, item: decision.item, status: 'REVIEW_REQUIRED', blockers: [
    'Your research approval records a preference; it is not transaction authorization.',
    'The current signed mandate accepts only DEMO_MARKET / DEMO_GALLERY assets denominated in Devnet SOL lamports. This research item is outside that transaction contract.',
    decision.item.mode === 'mock' ? 'Development fixtures cannot be purchased.'
      : 'A supported marketplace transaction adapter and fresh listing verification are required before a separate wallet authorization can be offered.',
  ] }
}
