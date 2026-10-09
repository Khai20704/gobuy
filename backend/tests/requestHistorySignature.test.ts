import assert from 'node:assert/strict'
import { test } from 'node:test'
import { naRequestSchema } from '@gobuy/shared'

const row = { id: '12345678-1234-4123-8123-123456789abc', prompt: 'Find RWA FOOx',
  status: 'NEEDS_INPUT', createdAt: '2026-10-08T00:00:00.000Z', updatedAt: '2026-10-08T00:00:00.000Z' }

test('history accepts legacy null and absent signatures while preserving actual transaction links', () => {
  const rows = naRequestSchema.array().parse([row, { ...row, signature: null }, { ...row, signature: 'tx-signature' }])
  assert.equal(rows[0].signature, undefined)
  assert.equal(rows[1].signature, undefined)
  assert.equal(rows[2].signature, 'tx-signature')
  assert.equal(Object.hasOwn(JSON.parse(JSON.stringify(rows[1])), 'signature'), false)
})

test('history still rejects invalid signature values and invalid required fields', () => {
  for (const signature of [123, {}, []]) assert.equal(naRequestSchema.safeParse({ ...row, signature }).success, false)
  assert.equal(naRequestSchema.safeParse({ ...row, status: null, signature: null }).success, false)
})
