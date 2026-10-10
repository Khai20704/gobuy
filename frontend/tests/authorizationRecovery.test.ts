import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Connection } from '@solana/web3.js'
import { authorizationRetrySafe, matchesPurchaseContinuation } from '../src/features/na/authorizationRecovery.js'

function rpc(statuses: unknown[], valid = false) {
  return { getSignatureStatuses: async () => ({ value: [statuses.shift() ?? null] }),
    isBlockhashValid: async () => ({ value: valid }) } as unknown as Connection
}
test('unsigned stale marker can recover; a legacy signature without expiry cannot', async () => {
  assert.equal(await authorizationRetrySafe({}, rpc([])), true)
  assert.equal(await authorizationRetrySafe({ signature: 'sig' }, rpc([])), false)
})
test('only expired absent or finalized failed authorization unlocks', async () => {
  const attempt = { signature: 'sig', blockhash: 'hash' }
  assert.equal(await authorizationRetrySafe(attempt, rpc([], true)), false)
  assert.equal(await authorizationRetrySafe(attempt, rpc([])), true)
  for (const confirmationStatus of ['processed', 'confirmed', 'finalized']) {
    assert.equal(await authorizationRetrySafe(attempt, rpc([{ confirmationStatus, err: null }])), false)
  }
  assert.equal(await authorizationRetrySafe(attempt, rpc([{ confirmationStatus: 'finalized', err: {} }])), true)
  assert.equal(await authorizationRetrySafe(attempt, rpc([null, { confirmationStatus: 'confirmed', err: null }])), false)
})
test('RPC failure preserves uncertainty', async () => {
  const connection = rpc([])
  connection.getSignatureStatuses = async () => { throw new Error('offline') }
  await assert.rejects(authorizationRetrySafe({ signature: 'sig' }, connection), /offline/)
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
