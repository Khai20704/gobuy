import assert from 'node:assert/strict'
import { test } from 'node:test'
import { getBase58Decoder } from '@solana/web3.js'
import { getListStateEncoder, TENSOR_MARKETPLACE_PROGRAM_ADDRESS } from '@tensor-foundation/marketplace'
import { getMetadataEncoder, Key, TokenStandard } from '@tensor-foundation/mpl-token-metadata'
import { findMetadataPda } from '@tensor-foundation/resolvers'
import { DEVNET_GENESIS, TOKEN_PROGRAM, TensorAdapterError, scanTensorDevnetListings, scopeSignal } from '../dist/index.js'

// Fixtures exist only in tests. Exercise the compiled scanner and SDK codecs; mock only HTTP.
const url = 'https://rpc.invalid/?api-key=TEST_SECRET'
const addr = n => getBase58Decoder().decode(Uint8Array.from({ length: 32 }, () => n))
const account = (bytes, owner) => ({ data: [Buffer.from(bytes).toString('base64'), 'base64'],
  owner, executable: false, lamports: 1, rentEpoch: 0, space: bytes.length })

async function fixture() {
  const mints = [addr(1), addr(2), addr(3)]
  const rows = mints.map((mint, i) => ({ pubkey: addr(i + 10),
    account: account(getListStateEncoder().encode({ version: 1, bump: [1], owner: addr(4), assetId: mint,
      amount: 100 + i, currency: null, expiry: 0, privateTaker: null, makerBroker: null,
      rentPayer: null, cosigner: null, reserved1: new Uint8Array(64) }), TENSOR_MARKETPLACE_PROGRAM_ADDRESS) }))
  const accounts = new Map()
  for (const mint of mints) {
    const [pda] = await findMetadataPda({ mint })
    accounts.set(pda, account(getMetadataEncoder().encode({ key: Key.MetadataV1, updateAuthority: addr(4), mint,
      name: 'Test NFT', symbol: 'TEST', uri: '', sellerFeeBasisPoints: 0, creators: null,
      primarySaleHappened: false, isMutable: false, editionNonce: null,
      tokenStandard: TokenStandard.NonFungible, collection: null, uses: null,
      collectionDetails: null, programmableConfig: null }), 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s'))
    accounts.set(mint, account(new Uint8Array(82), TOKEN_PROGRAM))
  }
  return { mints, rows, accounts }
}

function transport(t, handler) {
  const calls = []
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const body = JSON.parse(options.body)
    calls.push(body.method)
    const result = await handler(body, options.signal)
    if (result instanceof Response) return result
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }),
      { headers: { 'content-type': 'application/json' } })
  })
  return calls
}

function serve(f) {
  return body => {
    if (body.method === 'getGenesisHash') return DEVNET_GENESIS
    if (body.method === 'getProgramAccounts') return f.rows
    assert.equal(body.method, 'getMultipleAccounts')
    return { context: { slot: 1 }, value: body.params[0].map(key => f.accounts.get(key) ?? null) }
  }
}

function checkFailure(error, category, operation) {
  assert.ok(error instanceof TensorAdapterError)
  assert.equal(error.category, category)
  assert.equal(error.operation, operation)
  const phase = error.diagnostics.at(-1)
  assert.equal(phase.operation, operation)
  assert.equal(phase.category, category)
  assert.ok(Number.isFinite(phase.durationMs) && phase.durationMs >= 0)
  assert.equal(error.cause, undefined)
  assert.doesNotMatch(JSON.stringify(error), /TEST_SECRET|rpc\.invalid|https:|stack/)
  return true
}

test('real scanner accepts an empty successful scan and records every phase', async t => {
  const calls = transport(t, serve({ rows: [], accounts: new Map() }))
  const result = await scanTensorDevnetListings(url, 1000n)
  assert.deepEqual(result.listings, [])
  assert.equal(result.scanned, 0)
  assert.deepEqual(calls, ['getGenesisHash', 'getProgramAccounts'])
  assert.deepEqual(result.diagnostics.map(d => d.operation),
    ['getGenesisHash', 'getProgramAccounts', 'decode', 'metadata', 'mintAccounts'])
})

test('malformed ListState bytes fail decode instead of reporting an empty market', async t => {
  transport(t, serve({ rows: [{ pubkey: addr(10), account: account(new Uint8Array(2), TENSOR_MARKETPLACE_PROGRAM_ADDRESS) }] }))
  await assert.rejects(scanTensorDevnetListings(url, 1000n), e => checkFailure(e, 'INVALID_DATA', 'decode'))
})

for (const lastMintValid of [true, false]) test(`missing middle metadata preserves mint association (last valid=${lastMintValid})`, async t => {
  const f = await fixture()
  f.accounts.delete((await findMetadataPda({ mint: f.mints[1] }))[0])
  // Opposite owners at positions 1 and 2 expose both false rejection and false acceptance.
  f.accounts.set(f.mints[1], account(new Uint8Array(82), lastMintValid ? addr(9) : TOKEN_PROGRAM))
  f.accounts.set(f.mints[2], account(new Uint8Array(82), lastMintValid ? TOKEN_PROGRAM : addr(9)))
  transport(t, serve(f))
  const result = await scanTensorDevnetListings(url, 1000n)
  assert.deepEqual(result.listings.map(l => l.mint), lastMintValid ? [f.mints[0], f.mints[2]] : [f.mints[0]])
  assert.equal(result.metadataMissing, 1)
})

test('metadata for a different mint is rejected by the real scanner', async t => {
  const f = await fixture()
  f.accounts.set((await findMetadataPda({ mint: f.mints[1] }))[0],
    f.accounts.get((await findMetadataPda({ mint: f.mints[0] }))[0]))
  transport(t, serve(f))
  const result = await scanTensorDevnetListings(url, 1000n)
  assert.deepEqual(result.listings.map(l => l.mint), [f.mints[0], f.mints[2]])
  assert.equal(result.metadataMissing, 1)
})

for (const status of [429, 401, 403, 503]) test(`HTTP ${status} survives SDK transport wrapping`, async t => {
  transport(t, body => body.method === 'getGenesisHash' ? DEVNET_GENESIS : new Response('', { status }))
  await assert.rejects(scanTensorDevnetListings(url, 1000n), error => {
    checkFailure(error, status === 429 ? 'RATE_LIMITED' : status === 503 ? 'HTTP_ERROR' : 'AUTH_FAILED', 'getProgramAccounts')
    assert.equal(error.httpStatus, status)
    assert.equal(error.diagnostics.at(-1).httpStatus, status)
    assert.equal(error.diagnostics[0].operation, 'getGenesisHash')
    return true
  })
})

test('network errors retain failing phase and sanitized duration', async t => {
  transport(t, body => {
    if (body.method === 'getGenesisHash') return DEVNET_GENESIS
    throw new TypeError(`fetch failed ${url}`)
  })
  await assert.rejects(scanTensorDevnetListings(url, 1000n), e => checkFailure(e, 'RPC_UNAVAILABLE', 'getProgramAccounts'))
})

for (const source of ['adapter', 'caller']) test(`real scan attributes ${source} timeout`, async t => {
  transport(t, (body, signal) => {
    if (body.method === 'getGenesisHash') return DEVNET_GENESIS
    return new Promise((_, reject) => {
      if (signal.aborted) reject(signal.reason)
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
  })
  // Keep the event loop alive because AbortSignal.timeout uses an unref'ed timer.
  const keepAlive = setInterval(() => {}, 1000)
  try {
    await assert.rejects(scanTensorDevnetListings(url, 1000n, 50,
      source === 'caller' ? AbortSignal.timeout(25) : undefined,
      { timeoutMs: source === 'adapter' ? 25 : 1000 }), error => {
      checkFailure(error, 'TIMEOUT', 'getProgramAccounts')
      assert.equal(error.timeoutSource, source)
      assert.equal(error.diagnostics.at(-1).timeoutSource, source)
      return true
    })
  } finally { clearInterval(keepAlive) }
})

test('first timeout source remains stable after the other signal aborts', async () => {
  const caller = new AbortController()
  const scope = scopeSignal(caller.signal, 1)
  const keepAlive = setInterval(() => {}, 1000)
  await new Promise(resolve => scope.signal.addEventListener('abort', resolve, { once: true }))
  clearInterval(keepAlive)
  caller.abort()
  assert.equal(scope.classified(new Error()).timeoutSource, 'adapter')
  const alreadyCancelled = new AbortController()
  alreadyCancelled.abort()
  const other = scopeSignal(alreadyCancelled.signal, 1)
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(other.classified(new Error()).timeoutSource, 'caller')
})
