import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertPrePurchaseTokens } from './tensor-fixture-assertions.mjs';
const expected = { mint: 'original', listing: 'listing', listAta: 'escrow', sellerAta: 'seller-ata',
  buyerAta: 'buyer-ata', seller: 'seller', buyer: 'buyer', tokenProgram: 'spl' };
function fixture() {
  return { accounts: { listAta: { address: 'escrow', value: { owner: 'spl' } },
    sellerAta: { address: 'seller-ata', value: null }, buyerAta: { address: 'buyer-ata', value: null } },
  decoded: { listingToken: { mint: 'original', owner: 'listing', amount: '1', state: 1 }, seller: null, buyer: null } };
}
test('closed seller ATA and missing buyer ATA are valid with original NFT in escrow', () => {
  assert.doesNotThrow(() => assertPrePurchaseTokens(fixture(), expected));
});
test('existing empty seller and buyer ATAs require correct owners and mint', () => {
  const s = fixture();
  for (const role of ['seller', 'buyer']) {
    s.accounts[`${role}Ata`].value = { owner: 'spl' };
    s.decoded[role] = { mint: 'original', owner: role, amount: '0', state: 1 };
  }
  assert.doesNotThrow(() => assertPrePurchaseTokens(s, expected));
  s.decoded.buyer.owner = 'attacker';
  assert.throws(() => assertPrePurchaseTokens(s, expected), /token authority/);
});
test('missing escrow fails explicitly, never treated as zero balance', () => {
  const s = fixture(); s.accounts.listAta.value = null; s.decoded.listingToken = null;
  assert.throws(() => assertPrePurchaseTokens(s, expected), /listAta must exist/);
});
for (const [field, bad] of [['mint','replacement'], ['owner','attacker'], ['amount','0'], ['state',2]]) {
  test(`invalid escrow ${field} is rejected`, () => {
    const s = fixture(); s.decoded.listingToken[field] = bad;
    assert.throws(() => assertPrePurchaseTokens(s, expected));
  });
}
test('wrong escrow program/address and missing decoding fail closed', () => {
  for (const mutate of [s => s.accounts.listAta.value.owner = 'wrong',
    s => s.accounts.listAta.address = 'wrong', s => s.decoded.listingToken = null]) {
    const s = fixture(); mutate(s); assert.throws(() => assertPrePurchaseTokens(s, expected));
  }
});
test('absence and decoded account must agree', () => {
  const s = fixture(); s.decoded.seller = { amount: '0' };
  assert.throws(() => assertPrePurchaseTokens(s, expected), /consistency/);
});
