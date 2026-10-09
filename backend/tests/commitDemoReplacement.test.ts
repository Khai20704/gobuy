import assert from 'node:assert/strict'
import { test } from 'node:test'
import { commitDemoReplacement } from '../src/services/delivery/commitDemoReplacement.js'
import type { DeliveryPlan } from '../src/services/delivery/DeliveryService.js'

test('recovery commits nonce, existing order and delivery in one transaction; failures roll back', async () => {
  const previous = { id: 'order', owner: 'owner', paymentSignature: 'paid', mode: 'TRANSFER_NFT' } as DeliveryPlan
  const plan = { ...previous, mode: 'DEVNET_DEMO_MINT', recoveryConsent: { challengeId: 'nonce', acceptedAt: new Date().toISOString(), recipientWallet: 'owner', originalMode: previous.mode } } as DeliveryPlan
  for (const failure of ['', 'nonce', 'order', 'delivery']) {
    let committed: string[] = []
    const session = {}
    const transaction = async (work: any) => {
      const staged: string[] = []
      const db = { collection: (name: string) => ({
        deleteOne: async (filter: any, options: any) => {
          assert.equal(options.session, session); assert.equal(filter['value.payment'], 'paid')
          staged.push(name); return { deletedCount: failure === 'nonce' ? 0 : 1 }
        },
        updateOne: async (filter: any, update: any, options: any) => {
          assert.equal(options.session, session); assert.equal(filter.userId, 'alice')
          assert.ok(!JSON.stringify(update).includes('spentLamports'))
          if (name === 'autonomousPurchases') {
            assert.equal(filter['value.refundSignature'], null)
            assert.equal(update.$set['value.deliveryMode'], 'DEVNET_DEMO_MINT')
            assert.equal(filter['value.reply.result.signature'], 'paid')
          }
          staged.push(name)
          return { matchedCount: failure === (name === 'autonomousPurchases' ? 'order' : 'delivery') ? 0 : 1 }
        },
      }) }
      const result = await work(db, session)
      committed = staged
      return result
    }
    const action = commitDemoReplacement('alice', previous, plan, transaction as any)
    if (failure) { await assert.rejects(action); assert.deepEqual(committed, []) }
    else { await action; assert.deepEqual(committed, ['walletChallenges', 'autonomousPurchases', 'deliveryPlans']) }
  }
})
