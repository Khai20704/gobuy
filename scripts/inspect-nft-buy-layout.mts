import { scanTensorDevnetListings, buildTensorLegacyBuyInstruction } from '@gobuy/tensor-adapter'
const rpc = process.env.SOLANA_RPC_URL!
try {
  const scan = await scanTensorDevnetListings(rpc, 100_000_000n, 50, AbortSignal.timeout(30000))
  const listing = scan.listings.find(row => row.name.includes('Bodega Monke #5'))
  if (!listing) console.log(JSON.stringify({ found: false }))
  else {
    const ix = await buildTensorLegacyBuyInstruction(rpc, listing.mint, listing.seller, BigInt(listing.priceLamports))
    console.log(JSON.stringify({ name: listing.name, mint: listing.mint, accounts: ix.accounts.length, dataLength: ix.data.length, trailingAccounts: ix.accounts.slice(24) }))
  }
} catch (error) { console.log(JSON.stringify({ error: error instanceof Error ? error.name : 'unknown' })); process.exitCode = 1 }
