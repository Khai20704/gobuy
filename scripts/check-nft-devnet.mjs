import { HeliusClient, heliusRpcUrl } from '../backend/dist/nft/helius/HeliusClient.js'
import { HeliusNFTProvider } from '../backend/dist/nft/helius/HeliusNFTProvider.js'
import { scanTensorDevnetListings, tensorMarketplaceProgram } from '@gobuy/tensor-adapter'

const client = new HeliusClient()
try {
  const response = await fetch(heliusRpcUrl(), { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'gobuy', method: 'getGenesisHash', params: [] }), signal: AbortSignal.timeout(15000) })
  const body = await response.json().catch(() => ({}))
  console.log(JSON.stringify({ check: 'Helius HTTP authentication', httpStatus: response.status,
    rpcErrorCode: body.error?.code, invalidKey: /invalid.*(?:key|token)|(?:key|token).*invalid|unauthorized/i.test(body.error?.message ?? '') }))
} catch (error) { console.log(JSON.stringify({ check: 'Helius HTTP transport', code: error.cause?.code ?? error.name })) }
async function check(name, run) {
  try { const result = await run(); console.log(JSON.stringify({ check: name, ok: true, result })); return result }
  catch (error) {
    console.log(JSON.stringify({ check: name, ok: false, code: error.code ?? error.name,
      // Only known constant codes, never raw transport messages/URLs.
      networkMismatch: error.message === 'NETWORK_MISMATCH' }))
    process.exitCode = 1
  }
}
await check('Helius Devnet genesis', () => client.call('getGenesisHash', []))
await check('Tensor program deployed', async () => {
  const result = await client.call('getAccountInfo', [tensorMarketplaceProgram, { encoding: 'base64' }])
  return { program: tensorMarketplaceProgram, exists: !!result.value, executable: result.value?.executable }
})
const scan = await check('Tensor listing discovery', () => scanTensorDevnetListings(heliusRpcUrl(), 1_000_000_000n, 5, AbortSignal.timeout(45000)))
if (scan?.listings[0]) await check('Helius NFT verification', () => new HeliusNFTProvider(client).verifyOwner(
  scan.listings[0].mint, scan.listings[0].listState, AbortSignal.timeout(20000)))
if (!scan) await check('Independent public Devnet diagnostic (not a runtime fallback)', () =>
  scanTensorDevnetListings('https://api.devnet.solana.com', 1_000_000_000n, 3, AbortSignal.timeout(45000)))
