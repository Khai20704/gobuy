import { autonomousNFTCandidateSchema, type DiscoveryReply, type NFTCandidate, type NftPurchaseResult } from '@gobuy/shared'

export function genuineListingAvailable(discovery: DiscoveryReply, candidate: NFTCandidate): boolean {
  return discovery.intent.action === 'BUY' && !discovery.intent.priceDiscoveryOnly
    && autonomousNFTCandidateSchema.safeParse(candidate).success
}
export function genuineDeliveryVerified(result: NftPurchaseResult): boolean {
  const { receipt, delivery } = result
  return result.status === 'CONFIRMED' && !!receipt && !!delivery && delivery.commitment === 'finalized'
    && delivery.amount === '1' && receipt.orderId === result.orderId && receipt.mint === result.mint
    && delivery.mint === receipt.mint && delivery.owner === receipt.owner && delivery.signature === result.signature
}
