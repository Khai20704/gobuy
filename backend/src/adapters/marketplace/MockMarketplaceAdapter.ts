import { randomUUID } from 'node:crypto'
import type { CommerceProposal } from '@gobuy/shared'
import type { DiscoveryIntent } from '../llm/LLMProvider.js'
import type { MarketplaceAdapter } from './MarketplaceAdapter.js'

export class MockMarketplaceAdapter implements MarketplaceAdapter {
  async search({ scenario }: DiscoveryIntent): Promise<CommerceProposal[]> {
    const rwa = scenario === 'rwa'
    return [{
      id: randomUUID(), assetType: rwa ? 'RWA' : 'NFT',
      title: rwa ? 'Studio space / read-only sample' : 'Quiet forms / Study 08',
      amount: scenario === 'outside' ? '280000000' : '170000000',
      currency: 'DEVNET_SOL_LAMPORTS', decimals: 9,
      marketplace: scenario === 'wrong-market' ? 'DEMO_GALLERY' : 'DEMO_MARKET',
      assetId: rwa ? 'demo:rwa:studio-01' : 'demo:nft:quiet-forms-08',
      sellerEvidence: {
        source: 'mock-adapter', claimedVerified: scenario !== 'unverified',
        reference: 'fixture:seller:studio-08',
        disclaimer: 'Adapter-supplied demo claim. Neither the hash nor the program verifies the seller, price, ownership or real-world facts.',
      },
      metadata: {
        imageUrl: rwa ? '/demo/rwa.svg' : '/demo/artwork.svg',
        description: 'Illustrative fixture only. No marketplace listing or purchase transaction.',
        demo: true,
      },
      expiresAt: Math.floor(Date.now() / 1000) + 600,
    }]
  }
}
