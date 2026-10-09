import assert from 'node:assert/strict'
import { test } from 'node:test'
import { undeliveredPayments } from '../src/services/delivery/undeliveredPayments.js'

test('legacy confirmed payments remain visible without claiming asset ownership', async () => {
  const stores = {
    nft: { list: async () => [
      { owner: 'wallet', reply: { id: 'nft', selected: { name: 'Selected NFT' }, requestedSpendLamports: '40000000',
        result: { status: 'CONFIRMED', signature: 'nft-payment' } } },
      { owner: 'wallet', reply: { result: { status: 'NOT_SUBMITTED' } } },
    ] },
    rwa: { list: async () => [{ owner: 'wallet', reference: 'rwa', symbol: 'NVDAx', amount: '800000000',
      result: { status: 'CONFIRMED', signature: 'rwa-payment' } }] },
    delivery: { list: async () => [] },
  }
  const rows = await undeliveredPayments('user', stores as unknown as Parameters<typeof undeliveredPayments>[1])
  assert.equal(rows.length, 2)
  assert.equal(rows[0].amountLamports, '40000000')
  assert.match(rows[1].reason, /Thiếu kế hoạch/)
  assert.equal('ownership' in rows[0], false)
})

test('orders with delivery plans are not duplicated as legacy unpaid-delivery entries', async () => {
  const stores = {
    nft: { list: async () => [{ owner: 'wallet', reply: { id: 'nft', selected: { name: 'NFT' },
      result: { status: 'CONFIRMED', signature: 'payment' } } }] },
    rwa: { list: async () => [] },
    delivery: { list: async () => [{ kind: 'NFT', paymentSignature: 'payment' }] },
  }
  assert.deepEqual(await undeliveredPayments('user', stores as unknown as Parameters<typeof undeliveredPayments>[1]), [])
})
