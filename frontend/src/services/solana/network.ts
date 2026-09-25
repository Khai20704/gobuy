export const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1'
export async function requireDevnet(connection: { getGenesisHash(): Promise<string> }) {
  if (await connection.getGenesisHash() !== DEVNET_GENESIS) throw new Error('Only Solana Devnet is supported. RPC genesis hash does not match.')
}
