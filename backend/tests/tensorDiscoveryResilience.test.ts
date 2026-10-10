import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Keypair } from '@solana/web3.js'
import { nftSearchIntentSchema, type NFTSearchIntent } from '@gobuy/shared'
import { TensorAdapterError, type TensorScanResult, type TensorListing } from '@gobuy/tensor-adapter'
import { TensorDevnetNFTProvider } from '../src/services/acquisition/TensorDevnetNFTProvider.js'
import { DiscoveryEngine, heliusFailureCode, tensorFailureCode } from '../src/services/acquisition/discovery.js'
import { HeliusError } from '../src/nft/helius/HeliusClient.js'

/**
 * Regression tests for Tensor Devnet discovery failure handling.
 *
 * The invariant under test is narrow and absolute: an unreachable, throttled or misconfigured RPC
 * must never be reported as a successfully verified, empty NFT market. Every provider double below
 * is a test fixture, never marketplace data.
 */

type Scan = ConstructorParameters<typeof TensorDevnetNFTProvider>[1]
type Read = ConstructorParameters<typeof TensorDevnetNFTProvider>[2]
type Assets = NonNullable<ConstructorParameters<typeof TensorDevnetNFTProvider>[3]>
type VerifiedAsset = Awaited<ReturnType<Assets['verifyOwner']>>

const address = () => Keypair.generate().publicKey.toBase58()

function listing(overrides: Partial<TensorListing> = {}): TensorListing {
  return { listState: address(), mint: address(), seller: address(), priceLamports: '50000000',
    expiry: '1800000000', name: 'Devnet Monke', symbol: 'MONKE', ...overrides }
}

function scanResult(listings: TensorListing[]): TensorScanResult {
  return { listings, scanned: listings.length, activeSolListings: listings.length,
    metadataMissing: 0, unsupportedStandards: 0, diagnostics: [] } as TensorScanResult
}

/** A structurally valid Helius asset, matching what ownership verification returns on success. */
function asset(mint: string): VerifiedAsset {
  return { mint, owner: address(), name: 'Devnet Monke', description: '',
    network: 'devnet', verifiedAt: new Date().toISOString(), attributes: [] } as unknown as VerifiedAsset
}

function makeProvider(scan: Scan, verifyOwner: Assets['verifyOwner'], read?: Read) {
  return new TensorDevnetNFTProvider('https://api.devnet.solana.com', scan,
    read ?? (async () => undefined), { verifyOwner })
}

function searchIntent(): NFTSearchIntent {
  return nftSearchIntentSchema.parse({ assetType: 'NFT', semanticQuery: 'devnet monke', terms: ['monke'],
    maximumLamports: '1000000000', currency: 'SOL', intent: 'acquire_asset', parser: 'literal', broadSearch: true })
}

test('an empty but valid scan is NO_MATCH, not a provider failure', async () => {
  const provider = makeProvider(async () => scanResult([]), async () => { throw new Error('ownership must not be read') })
  const reply = await new DiscoveryEngine([provider]).search(searchIntent())
  assert.equal(reply.status, 'NO_MATCH')
  assert.deepEqual(reply.sources, [{ provider: 'tensor', status: 'AVAILABLE' }])
  assert.equal(reply.candidates.length, 0)
})

test('an RPC transport failure is an unavailable market, never an empty one', async () => {
  const provider = makeProvider(async () => { throw new TensorAdapterError('RPC_UNAVAILABLE', 'getProgramAccounts') },
    async () => { throw new Error('ownership must not be read') })
  const reply = await new DiscoveryEngine([provider]).search(searchIntent())
  assert.equal(reply.status, 'DATA_UNAVAILABLE')
  assert.notEqual(reply.status, 'NO_MATCH')
  assert.equal(reply.sources[0].status, 'UNAVAILABLE')
  assert.equal(reply.sources[0].code, 'NETWORK_ERROR')
  assert.ok(reply.warnings.some(warning => /Không dùng catalog giả thay thế/.test(warning)))
})

test('a throttled RPC keeps its rate-limit identity and HTTP status', async () => {
  const provider = makeProvider(
    async () => { throw new TensorAdapterError('RATE_LIMITED', 'getProgramAccounts', { httpStatus: 429 }) },
    async () => { throw new Error('ownership must not be read') })
  const reply = await new DiscoveryEngine([provider]).search(searchIntent())
  assert.equal(reply.sources[0].code, 'RATE_LIMITED')
  assert.equal(reply.sources[0].httpStatus, 429)
})

test('an unsupported RPC method is reported as unsupported, not as an outage or an empty market', async () => {
  const provider = makeProvider(
    async () => { throw new TensorAdapterError('RPC_UNSUPPORTED', 'getProgramAccounts', { rpcCode: -32601 }) },
    async () => { throw new Error('ownership must not be read') })
  const reply = await new DiscoveryEngine([provider]).search(searchIntent())
  assert.equal(reply.sources[0].code, 'RPC_UNSUPPORTED')
  assert.ok(reply.warnings.some(warning => /không hỗ trợ thao tác bắt buộc/.test(warning)))
})

test('a ListState layout change is a schema mismatch, never an empty market', async () => {
  const provider = makeProvider(async () => { throw new TensorAdapterError('INVALID_DATA', 'decode') },
    async () => { throw new Error('ownership must not be read') })
  const reply = await new DiscoveryEngine([provider]).search(searchIntent())
  assert.equal(reply.status, 'DATA_UNAVAILABLE')
  assert.equal(reply.sources[0].code, 'SCHEMA_MISMATCH')
})

test('a caller deadline that fires is reported as TIMEOUT with its source', async () => {
  const provider = makeProvider(
    async () => { throw new TensorAdapterError('TIMEOUT', 'getProgramAccounts', { timeoutSource: 'caller' }) },
    async () => { throw new Error('ownership must not be read') })
  const reply = await new DiscoveryEngine([provider]).search(searchIntent())
  assert.equal(reply.sources[0].code, 'TIMEOUT')
})

test('a provider that never answers hits the engine deadline instead of hanging discovery', async () => {
  const provider = makeProvider(async () => new Promise<TensorScanResult>(() => {}),
    async () => { throw new Error('ownership must not be read') })
  const reply = await new DiscoveryEngine([provider], 30).search(searchIntent())
  assert.equal(reply.status, 'DATA_UNAVAILABLE')
  assert.equal(reply.sources[0].code, 'TIMEOUT')
})
test('an auth failure on ownership verification is not reported as a missing NFT', async () => {
  const provider = makeProvider(async () => scanResult([listing()]),
    async () => { throw new HeliusError('AUTH_FAILED', { httpStatus: 401 }) })
  const reply = await new DiscoveryEngine([provider]).search(searchIntent())
  assert.equal(reply.status, 'DATA_UNAVAILABLE')
  assert.equal(reply.sources[0].code, 'AUTHENTICATION_FAILED')
  assert.equal(reply.sources[0].httpStatus, 401)
  assert.ok(reply.warnings.some(warning => /HELIUS_API_KEY/.test(warning)))
})

test('a partial provider outage still returns the listings that did verify', async () => {
  const reachable = listing()
  const unreachable = listing()
  const provider = makeProvider(async () => scanResult([unreachable, reachable]),
    async mint => { if (mint === unreachable.mint) throw new HeliusError('NETWORK_ERROR'); return asset(mint) })
  const candidates = await provider.search(searchIntent(), AbortSignal.timeout(2000))
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].mint, reachable.mint)
  // The provider stays available: a partial outage is not an empty market and not a total failure.
  assert.equal((await new DiscoveryEngine([provider]).search(searchIntent())).sources[0].status, 'AVAILABLE')
})

test('when nothing can be verified and the cause is transient, the market is unavailable not empty', async () => {
  const provider = makeProvider(async () => scanResult([listing()]),
    async () => { throw new HeliusError('NETWORK_ERROR') })
  const reply = await new DiscoveryEngine([provider]).search(searchIntent())
  assert.equal(reply.status, 'DATA_UNAVAILABLE')
  assert.notEqual(reply.status, 'NO_MATCH')
  assert.equal(reply.sources[0].code, 'NETWORK_ERROR')
})

test('a listing whose NFT is no longer owned by the ListState is a rejection, not an outage', async () => {
  const provider = makeProvider(async () => scanResult([listing()]),
    async () => { throw new HeliusError('ASSET_NOT_FOUND') })
  const reply = await new DiscoveryEngine([provider]).search(searchIntent())
  assert.equal(reply.status, 'NO_MATCH')
  assert.equal(reply.sources[0].status, 'AVAILABLE')
})

test('malformed asset metadata fails the search loudly instead of being silently dropped', async () => {
  const provider = makeProvider(async () => scanResult([listing()]),
    async () => ({ mint: address(), owner: address(), name: 'x', network: 'devnet',
      verifiedAt: new Date().toISOString(), attributes: [{ name: 1, value: 'x' }] }) as unknown as VerifiedAsset)
  const reply = await new DiscoveryEngine([provider]).search(searchIntent())
  assert.notEqual(reply.status, 'NO_MATCH')
  assert.equal(reply.status, 'DATA_UNAVAILABLE')
  assert.equal(reply.sources[0].code, 'PROVIDER_UNAVAILABLE')
})

test('listing refresh reports current chain state and a vanished listing as unavailable', async () => {
  const original = listing({ priceLamports: '50000000' })
  const repriced = { ...original, priceLamports: '90000000' }
  const live = makeProvider(async () => scanResult([original]), async mint => asset(mint),
    async () => repriced)
  const [candidate] = await live.search(searchIntent(), AbortSignal.timeout(2000))
  assert.equal(candidate.listing.priceLamports, '50000000')
  const refreshed = await live.refresh(candidate, AbortSignal.timeout(2000))
  assert.equal(refreshed?.listing.priceLamports, '90000000')

  const gone = makeProvider(async () => scanResult([original]), async mint => asset(mint), async () => undefined)
  assert.equal(await gone.refresh(candidate, AbortSignal.timeout(2000)), undefined)
})

test('ownership verification is bounded and still verifies every scanned listing', async () => {
  const listings = Array.from({ length: 12 }, () => listing())
  let active = 0
  let peak = 0
  const provider = makeProvider(async () => scanResult(listings), async mint => {
    active += 1
    peak = Math.max(peak, active)
    await new Promise(resolve => setTimeout(resolve, 5))
    active -= 1
    return asset(mint)
  })
  const candidates = await provider.search(searchIntent(), AbortSignal.timeout(10000))
  assert.equal(candidates.length, 12)
  assert.ok(peak > 1, 'verification should run concurrently')
  assert.ok(peak <= 4, `verification concurrency ${peak} exceeded the bound`)
})

test('the failure vocabulary keeps NO_MATCH distinct from every transport failure', () => {
  assert.equal(tensorFailureCode(new TensorAdapterError('RPC_UNAVAILABLE', 'getProgramAccounts')), 'NETWORK_ERROR')
  assert.equal(tensorFailureCode(new TensorAdapterError('RATE_LIMITED', 'getProgramAccounts')), 'RATE_LIMITED')
  assert.equal(tensorFailureCode(new TensorAdapterError('TIMEOUT', 'getProgramAccounts')), 'TIMEOUT')
  assert.equal(tensorFailureCode(new TensorAdapterError('AUTH_FAILED', 'getProgramAccounts')), 'AUTHENTICATION_FAILED')
  assert.equal(tensorFailureCode(new TensorAdapterError('RPC_UNSUPPORTED', 'getProgramAccounts')), 'RPC_UNSUPPORTED')
  assert.equal(tensorFailureCode(new TensorAdapterError('INVALID_DATA', 'decode')), 'SCHEMA_MISMATCH')
  assert.equal(tensorFailureCode(new TensorAdapterError('NETWORK_MISMATCH', 'getGenesisHash')), 'PROVIDER_UNAVAILABLE')
  assert.equal(tensorFailureCode(new TensorAdapterError('HTTP_ERROR', 'getProgramAccounts', { httpStatus: 502 })), 'PROVIDER_UNAVAILABLE')
  assert.equal(heliusFailureCode(new HeliusError('ASSET_NOT_FOUND')), 'NO_DATA')
  for (const code of ['NETWORK_ERROR', 'RATE_LIMITED', 'TIMEOUT', 'AUTH_FAILED', 'RPC_UNSUPPORTED', 'INVALID_RESPONSE'] as const) {
    assert.notEqual(heliusFailureCode(new HeliusError(code)), 'NO_DATA')
  }
})

test('Tensor failures carry a log-safe operation name and never a URL or credential', () => {
  const error = new TensorAdapterError('RPC_UNAVAILABLE', 'getProgramAccounts')
  assert.equal(error.operation, 'getProgramAccounts')
  assert.equal(error.category, 'RPC_UNAVAILABLE')
  assert.equal(error.message, 'Tensor adapter getProgramAccounts failed: RPC_UNAVAILABLE')
  assert.ok(!/https?:|api-key|authorization/i.test(error.message))
})

test('real scanner failure reaches backend logs with sanitized operation duration and HTTP status', async t => {
  t.mock.method(globalThis, 'fetch', async (_url: unknown, options: RequestInit) => {
    const body = JSON.parse(String(options.body))
    if (body.method === 'getGenesisHash') return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id,
      result: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG' }), { headers: { 'content-type': 'application/json' } })
    return new Response('', { status: 429 })
  })
  const logs: string[] = []
  t.mock.method(console, 'info', (...args: unknown[]) => { logs.push(args.map(String).join(' ')) })
  const provider = new TensorDevnetNFTProvider('https://rpc.invalid/?api-key=TEST_SECRET', undefined, undefined,
    { verifyOwner: async () => { throw new Error('No listing should reach verification') } })
  const reply = await new DiscoveryEngine([provider]).search(searchIntent())
  assert.equal(reply.status, 'DATA_UNAVAILABLE')
  assert.equal(reply.sources[0].code, 'RATE_LIMITED')
  assert.equal(reply.sources[0].httpStatus, 429)
  const records = logs.map(line => JSON.parse(line.slice(line.indexOf('{'))))
  const failure = records.find(record => record.event === 'provider_failure')
  assert.equal(failure.operation, 'getProgramAccounts')
  assert.ok(failure.latencyMs >= 0)
  assert.ok(records.some(record => record.event === 'tensor_scan' && record.operation === 'getProgramAccounts'
    && record.category === 'RATE_LIMITED' && record.httpStatus === 429 && record.latencyMs >= 0))
  assert.doesNotMatch(logs.join('\n'), /TEST_SECRET|rpc\.invalid|https:|stack/)
})
