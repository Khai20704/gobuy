import type { NFTCandidate, NftDemoReceipt } from '@gobuy/shared'
import { assertNFTExecutionNetwork } from './executionNetwork.js'
import { NftDemoService } from '../nftDemo/NftDemoService.js'
import { acquisitionConfig } from './discovery.js'

export interface ExecutionEngine {
  prepare(id: string, candidate: NFTCandidate, maximumLamports: number, owner: string, userId: string): ReturnType<NftDemoService['prepareRepresentation']>
  submit(id: string, signed: string, userId: string): Promise<NftDemoReceipt>
  status(id: string, userId: string): Promise<NftDemoReceipt>
  assetOwner(asset: string): Promise<string>
}
export class DevnetSimulationExecutor implements ExecutionEngine {
  constructor(private readonly service = new NftDemoService()) { acquisitionConfig() }
  prepare(id: string, candidate: NFTCandidate, maximumLamports: number, owner: string, userId: string) {
    assertNFTExecutionNetwork(candidate)
    return this.service.prepareRepresentation(id, candidate, maximumLamports, owner, userId)
  }
  submit(id: string, signed: string, userId: string) { return this.service.submit(id, signed, userId, true) }
  status(id: string, userId: string) { return this.service.status(id, userId) }
  assetOwner(asset: string) { return this.service.assetOwner(asset) }
}
// Intentionally unconstructable for execution: no mainnet transaction builder or sender exists.
export class MainnetMarketplaceExecutor {
  constructor() { throw new Error('Mainnet acquisition is not implemented and remains disabled.') }
}
