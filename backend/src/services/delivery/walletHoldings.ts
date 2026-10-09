import { PublicKey } from '@solana/web3.js'
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token'
import { assertDevnet, solanaConfig, walletHoldingSchema, type WalletHolding } from '@gobuy/shared'
import { decimalUnits } from './quantity.js'
import { balanceCacheTtl, devnetRpc } from './rpc.js'

const cache = new Map<string, { expires: number; value: Promise<WalletHolding[]> }>()
/** Two batched token-program reads per wallet, shared by all known delivery checks. */
export function walletHoldings(owner: string, fresh = false): Promise<WalletHolding[]> {
  const config = solanaConfig(process.env), key = config.rpcUrl + ':' + owner
  const cached = cache.get(key)
  if (!fresh && cached && cached.expires > Date.now()) return cached.value
  const value = (async () => {
    const connection = devnetRpc(config.rpcUrl)
    await assertDevnet(connection, config)
    const groups = await Promise.all([TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].map(programId =>
      connection.getParsedTokenAccountsByOwner(new PublicKey(owner), { programId }, 'confirmed')))
    return groups.flatMap(group => group.value.flatMap(row => {
      const info = row.account.data.parsed.info
      if (info.owner !== owner || BigInt(info.tokenAmount.amount) <= 0n) return []
      return [walletHoldingSchema.parse({ owner, mint: info.mint, tokenAccount: row.pubkey.toBase58(),
        rawQuantity: info.tokenAmount.amount, quantity: decimalUnits(info.tokenAmount.amount, info.tokenAmount.decimals),
        decimals: info.tokenAmount.decimals, network: 'devnet' })]
    }))
  })()
  // Keep in-flight reads shared even during provider backoff; TTL starts after success.
  cache.set(key, { expires: Infinity, value })
  void value.then(() => { if (cache.get(key)?.value === value) cache.set(key, { expires: Date.now() + balanceCacheTtl(), value }) }).catch(() => {})
  if (cache.size > 200) cache.delete(cache.keys().next().value!)
  void value.catch(() => { if (cache.get(key)?.value === value) cache.delete(key) })
  return value
}
