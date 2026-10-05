// getGenesisHash returns the full hash, not the truncated CAIP-2 chain reference.
export const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'
export const DEVNET_RPC_URL = 'https://api.devnet.solana.com'
export const NETWORK_BLOCKED = 'Mainnet transactions are disabled in GoBuy development mode. Only Solana Devnet is supported.'
export type SolanaConfig = Readonly<{ network: 'devnet'; rpcUrl: string }>
export function solanaConfig(env: Record<string, string | undefined> = {}): SolanaConfig {
  if (env.DEMO_MODE === 'true' && env.SOLANA_EXECUTION_NETWORK !== 'devnet') throw new Error('GoBuy demo execution must use Solana Devnet.')
  if (env.SOLANA_EXECUTION_NETWORK !== undefined && env.SOLANA_EXECUTION_NETWORK !== 'devnet') throw new Error(NETWORK_BLOCKED)
  if (env.ENABLE_MAINNET_EXECUTION === 'true') throw new Error('Mainnet executor is not implemented; execution remains disabled.')
  const network = env.SOLANA_NETWORK ?? 'devnet'
  const rpcUrl = env.SOLANA_RPC_URL ?? DEVNET_RPC_URL
  if (network !== 'devnet') throw new Error(NETWORK_BLOCKED)
  const url = new URL(rpcUrl)
  if (!['http:', 'https:'].includes(url.protocol) || /mainnet|testnet/i.test(rpcUrl)) throw new Error(NETWORK_BLOCKED)
  // Reject conflicting legacy settings instead of silently ignoring them.
  for (const key of ['NFT_DEMO_RPC_URL', 'SOLANA_DEVNET_RPC_URL', 'VITE_SOLANA_RPC_URL']) {
    if (env[key] !== undefined && env[key] !== rpcUrl) throw new Error(`Conflicting ${key}; use SOLANA_RPC_URL.`)
  }
  if (env.VITE_SOLANA_NETWORK !== undefined && env.VITE_SOLANA_NETWORK !== network) throw new Error(NETWORK_BLOCKED)
  return Object.freeze({ network, rpcUrl })
}
export async function assertDevnet(connection: { getGenesisHash(): Promise<string> }, config: SolanaConfig) {
  solanaConfig({ SOLANA_NETWORK: config.network, SOLANA_RPC_URL: config.rpcUrl })
  if (await connection.getGenesisHash() !== DEVNET_GENESIS) throw new Error('Only Solana Devnet is supported. The configured RPC returned a different genesis hash; this does not indicate the network selected in Phantom.')
}
