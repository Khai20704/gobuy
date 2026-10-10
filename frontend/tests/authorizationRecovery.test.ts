import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Connection } from '@solana/web3.js'
import { reconcileAuthorization, matchesPurchaseContinuation } from '../src/features/na/authorizationRecovery.js'

function rpc(statuses: unknown[], valid = false) {
  return { getSignatureStatuses: async () => ({ value: [statuses.shift() ?? null] }),
    isBlockhashValid: async () => ({ value: valid }) } as unknown as Connection
}
test('unsigned stale marker can recover; a legacy signature without expiry cannot', async () => {
  assert.equal(await reconcileAuthorization({}, rpc([])), 'RETRY_SAFE')
  assert.equal(await reconcileAuthorization({ signature: 'sig' }, rpc([])), 'UNKNOWN')
})
test('only expired absent or finalized failed authorization unlocks', async () => {
  const attempt = { signature: 'sig', blockhash: 'hash' }
  assert.equal(await reconcileAuthorization(attempt, rpc([], true)), 'UNKNOWN')
  assert.equal(await reconcileAuthorization(attempt, rpc([])), 'RETRY_SAFE')
  for (const confirmationStatus of ['processed', 'confirmed', 'finalized']) {
    assert.equal(await reconcileAuthorization(attempt, rpc([{ confirmationStatus, err: null }])), confirmationStatus === 'processed' ? 'UNKNOWN' : 'CONFIRMED')
  }
  assert.equal(await reconcileAuthorization(attempt, rpc([{ confirmationStatus: 'finalized', err: {} }])), 'RETRY_SAFE')
  assert.equal(await reconcileAuthorization(attempt, rpc([null, { confirmationStatus: 'confirmed', err: null }])), 'CONFIRMED')
  assert.equal(await reconcileAuthorization(attempt, rpc([{ confirmationStatus: 'confirmed', err: {} }])), 'UNKNOWN')
})
test('RPC failure preserves uncertainty', async () => {
  const connection = rpc([])
  connection.getSignatureStatuses = async () => { throw new Error('offline') }
  await assert.rejects(reconcileAuthorization({ signature: 'sig' }, connection), /offline/)
})
test('auto continuation binds original owner, request, candidate and budget; started never retries', () => {
  const expected = { owner: 'owner', discoveryId: 'buy', candidateId: 'nft', maximumLamports: '40000000', ceiling: '50000000' }
  const saved = { ...expected, state: 'authorized-request' as const }
  assert.equal(matchesPurchaseContinuation(saved, expected), true)
  for (const key of Object.keys(expected)) {
    assert.equal(matchesPurchaseContinuation({ ...saved, [key]: 'different' }, expected), false)
  }
  assert.equal(matchesPurchaseContinuation({ ...saved, state: 'started' }, expected), false)
})
