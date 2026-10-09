import assert from 'node:assert/strict'
import { test } from 'node:test'
import { devnetDeliverySchema, type DevnetDelivery } from '@gobuy/shared'
import { deliveryStatusLabel, deliveryPollingFinished } from '../src/features/na/deliveryStatus.js'
test('payment and submission never render NFT delivery success; attention stops polling', () => {
  for (const status of ['pending', 'preparing', 'submitted', 'confirming', 'retrying', 'completed'] as const) {
    const delivery = { phase: 'DELIVERY_PENDING', recovery: { status } } as DevnetDelivery
    assert.doesNotMatch(deliveryStatusLabel(delivery), /Thành công/)
    assert.equal(deliveryPollingFinished(delivery), false)
  }
  const attention = { phase: 'DELIVERY_PENDING', recovery: { status: 'requires_attention', lastError: 'RPC_RATE_LIMIT' } } as DevnetDelivery
  assert.equal(deliveryPollingFinished(attention), true)
  assert.doesNotMatch(deliveryStatusLabel(attention), /tự động thử lại/)
  assert.match(deliveryStatusLabel({ phase: 'COMPLETED', ownership: 'verified' } as DevnetDelivery), /Phantom Collectibles/)
})
test('legacy pending deliveries with null mint/signature remain readable by the wallet panel', () => {
  const value = devnetDeliverySchema.parse({ id: 'order', owner: 'owner', kind: 'NFT', name: 'NFT', sourceMint: 'source',
    mint: null, signature: null, pricing: null, balance: null, paymentLamports: null, quantity: '1', rawQuantity: '1', decimals: 0,
    network: 'devnet', simulated: false, phase: 'DELIVERY_PENDING', paymentSignature: 'paid', ownership: 'unknown', message: 'pending' })
  assert.equal(value.mint, undefined); assert.equal(value.signature, undefined)
  assert.equal(value.paymentSignature, 'paid')
  assert.equal(value.paymentLamports, undefined)
})
