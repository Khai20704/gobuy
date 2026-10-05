import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Connection, PublicKey } from '@solana/web3.js'
import type { RWAAsset } from '@gobuy/shared'
import { MAINNET_GENESIS, RWARegistry } from '../src/services/rwa/RWARegistry.js'
import { RWAService } from '../src/services/rwa/RWAService.js'
import { JupiterClient } from '../src/services/jupiter/JupiterClient.js'
import { JupiterQuoteService } from '../src/services/jupiter/JupiterQuoteService.js'
import { SOL_MINT, USDC_MINT } from '../src/services/jupiter/types.js'
import type { AssetStore } from '../src/persistence/AssetStore.js'
import type { SavedRWA } from '../src/services/rwa/RWAService.js'

// Synthetic identity fixture, never a production approval.
const asset = (): RWAAsset => ({ mint: USDC_MINT, symbol: 'TEST', name: 'Test RWA', issuer: 'Test issuer',
  category: 'OTHER', underlying: 'Test asset', decimals: 6, verified: true, allowedForSwap: true,
  verificationSource: 'https://example.com/issuer', updatedAt: new Date().toISOString() })
// Reading the constant instead of copying it: a copied literal is how a truncated mainnet genesis
// survived in production, making every mainnet RPC look like devnet.
const rpc = (decimals = 6, genesis = MAINNET_GENESIS) => ({
  getGenesisHash: async () => genesis,
  getParsedAccountInfo: async () => ({ value: { owner: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
    data: { parsed: { type: 'mint', info: { decimals, isInitialized: true } } } } }),
} as unknown as Connection)
const intent = { category: 'RWA' as const, action: 'BUY' as const, currency: 'SOL' as const, symbol: 'TEST' }

test('approved list rejects lookalike mints, revoked identities, duplicates and ambiguous symbols', () => {
  const row = asset(), registry = new RWARegistry([row])
  assert.throws(() => registry.resolve({ ...intent, mint: SOL_MINT }))
  assert.throws(() => new RWARegistry([{ ...row, verified: false }]).resolve(intent))
  assert.throws(() => new RWARegistry([{ ...row, allowedForSwap: false }]).resolve(intent))
  assert.throws(() => new RWARegistry([row, row]), /Duplicate/)
  assert.throws(() => new RWARegistry([row, { ...row, mint: SOL_MINT }]).resolve(intent))
  row.verified = false
  assert.equal(registry.resolve(intent).verified, true)
})

test('identity verification checks mainnet and mint metadata without market scores', async () => {
  const row = asset()
  assert.equal((await new RWARegistry([row], rpc()).verify(row)).mint, row.mint)
  await assert.rejects(new RWARegistry([row], rpc(9)).verify(row))
  await assert.rejects(new RWARegistry([row], rpc(6, 'devnet-genesis')).verify(row))
  await assert.rejects(new RWARegistry([{ ...row, updatedAt: '2020-01-01T00:00:00.000Z' }], rpc()).verify(row))
  assert.throws(() => new RWARegistry([{ ...row, popularity: 100 } as RWAAsset]))
})

test('RWA identity gate runs before Jupiter and rejects a substituted output mint', async () => {
  let calls = 0
  const quotes = new JupiterQuoteService(new JupiterClient('test', async () => {
    calls++
    return Response.json({ inputMint: SOL_MINT, outputMint: SOL_MINT, inAmount: '1000000000',
      outAmount: '1000000', otherAmountThreshold: '990000', slippageBps: 100, swapMode: 'ExactIn',
      routePlan: [{ swapInfo: { label: 'Test' } }] })
  }))
  // Injected cache: this test is about the identity gate, so it must not depend on a database.
  const cached = { put: async () => {} } as unknown as AssetStore<SavedRWA>
  const service = new RWAService(new RWARegistry([asset()], rpc()), { quotes, cached })
  assert.equal((await service.discover('user', `buy RWA TEST ${SOL_MINT} with 1 SOL`)).status, 'REJECTED')
  assert.equal(calls, 0)
  const result = await service.discover('user', 'buy RWA TEST with 1 SOL')
  assert.equal(calls, 1)
  assert.equal(result.status, 'REJECTED')
  assert.equal(result.transaction, undefined)
})
