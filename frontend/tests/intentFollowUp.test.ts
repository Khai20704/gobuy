import assert from 'node:assert/strict'
import { test } from 'node:test'
import { hasSolBudget, isBudgetOnlyReply, isPurchaseIntent } from '../src/features/na/intentFollowUp.ts'

test('purchase requests can be clarified with a natural SOL budget reply', () => {
  assert.equal(isPurchaseIntent('Tìm tranh NFT Collector Crypt để mua'), true)
  assert.equal(hasSolBudget('Tìm tranh NFT Collector Crypt để mua'), false)
  assert.equal(isBudgetOnlyReply('dưới 1 SOL'), true)
  assert.equal(isBudgetOnlyReply('tầm 0,5 SOL nha'), true)
  assert.equal(isBudgetOnlyReply('Mua tranh NFT rừng dưới 1 SOL'), false)
  assert.equal(hasSolBudget('ngân sách 1 SOL'), true)
})
