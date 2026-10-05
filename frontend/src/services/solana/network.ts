/// <reference types="vite/client" />
import { Connection } from '@solana/web3.js'
import { solanaConfig, assertDevnet } from '@gobuy/shared'
export { DEVNET_GENESIS } from '@gobuy/shared'
export function frontendSolanaConfig() {
  return solanaConfig({ SOLANA_NETWORK: import.meta.env?.VITE_SOLANA_NETWORK,
    SOLANA_RPC_URL: import.meta.env?.VITE_SOLANA_RPC_URL })
}
export function devnetConnection() {
  return new Connection(frontendSolanaConfig().rpcUrl, { commitment: 'confirmed', disableRetryOnRateLimit: true })
}
export async function requireDevnet(connection: { getGenesisHash(): Promise<string> }) {
  await assertDevnet(connection, frontendSolanaConfig())
}
