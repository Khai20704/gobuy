import { autonomousPurchaseResultSchema, type DiscoveryReply, type NFTCandidate } from '@gobuy/shared'

/** No wallet provider is accepted here: the backend's Na Agent is the only spend signer. */
export async function executeAutonomousPurchase(api: (path: string, body?: Record<string, unknown>) => Promise<unknown>,
  discovery: DiscoveryReply, candidate: NFTCandidate, owner: string) {
  if (discovery.intent.action !== 'BUY' || discovery.intent.priceDiscoveryOnly) throw new Error('SEARCH cannot execute a spend.')
  return autonomousPurchaseResultSchema.parse(await api('/autonomous-spend', { discoveryId: discovery.id, candidateId: candidate.id, owner }))
}
