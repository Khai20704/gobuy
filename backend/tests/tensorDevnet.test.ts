import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { Keypair } from '@solana/web3.js'
import { nftCandidateSchema, nftDemoQuoteSchema, nftSearchIntentSchema } from '@gobuy/shared'
import { tensorMarketplaceProgram, type TensorBuyInstruction, type TensorListing } from '@gobuy/tensor-adapter'
import { TensorDevnetNFTProvider } from '../src/services/acquisition/TensorDevnetNFTProvider.js'
import { toWeb3JsTensorInstruction } from '../src/services/acquisition/TensorDevnetExecutor.js'
import { NFTAcquisitionRanker } from '../src/services/acquisition/NFTAcquisitionRanker.js'
import { NFTIntentParser } from '../src/services/acquisition/discovery.js'

test('Tensor Devnet provider maps only SDK-decoded listings into canonical NFT candidates', async () => {
  const mint = Keypair.generate().publicKey.toBase58()
  const seller = Keypair.generate().publicKey.toBase58()
  const listing: TensorListing = {
    listState: Keypair.generate().publicKey.toBase58(),
    mint,
    seller,
    priceLamports: '50000000',
    expiry: '1800000000',
    name: 'Devnet Monke',
    symbol: 'MONKE',
  }
  let scanArgs: [string, bigint, number?] | undefined
  const provider = new TensorDevnetNFTProvider(
    'https://api.devnet.solana.com',
    async (rpcUrl, maximumLamports, limit, signal) => {
      scanArgs = [rpcUrl, maximumLamports, limit]
      assert.ok(signal instanceof AbortSignal)
      return { listings: [listing], scanned: 3, activeSolListings: 1, metadataMissing: 1, unsupportedStandards: 1 }
    },
    async (_rpcUrl, requestedMint) => requestedMint === mint ? listing : undefined,
    { verifyOwner: async () => ({ mint, owner: listing.listState, name: 'Devnet Monke', network: 'devnet', verifiedAt: new Date().toISOString() }) },
  )
  const intent = nftSearchIntentSchema.parse({
    assetType: 'NFT',
    semanticQuery: 'Devnet Monke',
    terms: ['monke'],
    maximumLamports: '1000000000',
    currency: 'SOL',
    intent: 'acquire_asset',
    parser: 'literal',
    broadSearch: true,
  })
  const [candidate] = await provider.search(intent, AbortSignal.timeout(1000))
  assert.deepEqual(scanArgs, ['https://api.devnet.solana.com', 1_000_000_000n, 50])
  assert.equal(candidate.provider, 'tensor')
  assert.equal(candidate.sourceNetwork, 'devnet')
  assert.equal(candidate.mint, mint)
  assert.equal(candidate.listing.seller, seller)
  assert.equal(candidate.listing.priceLamports, listing.priceLamports)
  assert.equal(candidate.image, null)
  const buyIntent = nftSearchIntentSchema.parse({ ...intent, action: 'BUY', objective: 'BEST_OVERALL' })
  const selected = new NFTAcquisitionRanker().select([candidate], buyIntent)
  assert.equal(selected?.candidate.id, candidate.id)
  assert.equal(selected?.ranking.components.marketQuality, 1)
  assert.match(selected?.ranking.reasons.join(' ') ?? '', /does not indicate popularity/)
  const nonTensor = nftCandidateSchema.parse({ ...candidate, provider: 'magiceden' })
  assert.equal(new NFTAcquisitionRanker().select([nonTensor], buyIntent), undefined)
  const refreshed = await provider.refresh(candidate, AbortSignal.timeout(1000))
  assert.equal(refreshed?.listing.priceLamports, listing.priceLamports)

  const quote = nftDemoQuoteSchema.parse({
    id: randomUUID(),
    network: 'devnet',
    owner: Keypair.generate().publicKey.toBase58(),
    asset: mint,
    title: candidate.name,
    image: '',
    priceLamports: Number(listing.priceLamports),
    maximumLamports: 1_000_000_000,
    estimatedTotalLamports: 51_000_000,
    transaction: 'AQ==',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    sourceAsset: candidate,
    simulated: false,
  })
  assert.equal(quote.simulated, false)
})

test('generic explicit Tensor buy queries are broad rather than unmatched keywords', async () => {
  const intent = await new NFTIntentParser().parse('Buy any NFT under 1 SOL')
  assert.equal(intent.action, 'BUY')
  assert.equal(intent.broadSearch, true)
})

test('Tensor SDK instruction bridge preserves account roles and exact instruction bytes', () => {
  const signer = Keypair.generate().publicKey.toBase58()
  const readonly = Keypair.generate().publicKey.toBase58()
  const instruction: TensorBuyInstruction = {
    programAddress: tensorMarketplaceProgram,
    accounts: [
      { address: signer, isSigner: true, isWritable: true },
      { address: readonly, isSigner: false, isWritable: false },
    ],
    data: Uint8Array.of(1, 2, 3),
    mint: Keypair.generate().publicKey.toBase58(),
    seller: Keypair.generate().publicKey.toBase58(),
    listState: Keypair.generate().publicKey.toBase58(),
    priceLamports: '50000000',
  }
  const converted = toWeb3JsTensorInstruction(instruction)
  assert.equal(converted.programId.toBase58(), tensorMarketplaceProgram)
  assert.equal(converted.keys[0].pubkey.toBase58(), signer)
  assert.equal(converted.keys[0].isSigner, true)
  assert.equal(converted.keys[0].isWritable, true)
  assert.equal(converted.keys[1].isSigner, false)
  assert.equal(converted.keys[1].isWritable, false)
  assert.deepEqual([...converted.data], [1, 2, 3])
  assert.throws(() => toWeb3JsTensorInstruction({ ...instruction, programAddress: readonly }), /unexpected program address/)
})
