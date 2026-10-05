import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkMandateSpend, explainMandateRejection, mandateCategoryAllows } from '@gobuy/shared'

/**
 * The owner picks one category when signing a mandate. NFT and RWA never cross: an NFT mandate may
 * not buy RWA and a RWA mandate may not buy NFT. `ANY` is the only mandate that permits both.
 * These assertions mirror `mandate_rules::authorize_spend` in the Anchor program.
 */

const mandate = (allowedCategory: 'ANY' | 'NFT' | 'RWA') => ({
  active: true, closed: false, expiresAt: Math.floor(Date.now() / 1000) + 3600,
  allowedCategory, maxBudgetLamports: 1_000_000_000n, spentLamports: 0n,
})

const check = (allowedCategory: 'ANY' | 'NFT' | 'RWA', category: 'NFT' | 'RWA') =>
  checkMandateSpend({ mandate: mandate(allowedCategory), amountLamports: 40_000_000n, category,
    nowSeconds: Math.floor(Date.now() / 1000), vaultLamports: 1_000_000_000n })

test('a mandate signed for one category never authorizes the other', () => {
  assert.equal(mandateCategoryAllows('NFT', 'NFT'), true)
  assert.equal(mandateCategoryAllows('RWA', 'RWA'), true)
  assert.equal(mandateCategoryAllows('NFT', 'RWA'), false)
  assert.equal(mandateCategoryAllows('RWA', 'NFT'), false)
  assert.equal(mandateCategoryAllows('ANY', 'NFT'), true)
  assert.equal(mandateCategoryAllows('ANY', 'RWA'), true)
})

test('an NFT mandate refuses an RWA spend and a RWA mandate refuses an NFT spend', () => {
  assert.equal(check('NFT', 'NFT').allowed, true)
  assert.deepEqual(check('NFT', 'RWA'), { allowed: false, rejection: 'InvalidCategory' })
  assert.equal(check('RWA', 'RWA').allowed, true)
  assert.deepEqual(check('RWA', 'NFT'), { allowed: false, rejection: 'InvalidCategory' })
})

test('ANY is the only mandate that permits both categories', () => {
  assert.equal(check('ANY', 'NFT').allowed, true)
  assert.equal(check('ANY', 'RWA').allowed, true)
})

test('the refusal names both categories so the owner can act on it', () => {
  const message = explainMandateRejection('InvalidCategory', { mandateCategory: 'NFT', requestedCategory: 'RWA' })
  assert.match(message, /NFT/)
  assert.match(message, /RWA/)
  assert.match(message, /thu hồi/)
  // Without category context the message stays generic rather than inventing a reason.
  assert.equal(explainMandateRejection('InvalidCategory'), 'Danh mục tài sản này không nằm trong mandate bạn đã ủy quyền.')
})
