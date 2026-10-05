import { acquisitionConfig } from './discovery.js'
import { MockNFTProvider } from './MockNFTProvider.js'
import { TensorDevnetNFTProvider } from './TensorDevnetNFTProvider.js'
import { HeliusMainnetResearchProvider } from './HeliusMainnetResearchProvider.js'
import { HeliusClient, heliusRpcUrl } from '../../nft/helius/HeliusClient.js'
import { HeliusNFTProvider } from '../../nft/helius/HeliusNFTProvider.js'

export function nftProviders(env: NodeJS.ProcessEnv = process.env) {
  const config = acquisitionConfig(env)
  if (config.NFT_DISCOVERY_MODE === 'mock') return [new MockNFTProvider()]
  return [new TensorDevnetNFTProvider(env.HELIUS_API_KEY?.trim() ? heliusRpcUrl(env) : undefined,
    undefined, undefined, new HeliusNFTProvider(new HeliusClient(env))),
    new HeliusMainnetResearchProvider(new HeliusClient(env, fetch, 10000, 'mainnet'))]
}
