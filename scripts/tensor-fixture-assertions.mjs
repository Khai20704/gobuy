import assert from 'node:assert/strict';

// A closed seller ATA is genuine ListLegacy behavior, not an empty decoded account.
export function assertPrePurchaseTokens(snapshot, expected) {
  function check(accountName, decodedName, address, owner, amount, optional) {
    const account = snapshot.accounts[accountName];
    assert(account, `Missing ${accountName} snapshot`);
    assert.equal(account.address, address, `${accountName} canonical address`);
    const decoded = snapshot.decoded[decodedName];
    if (account.value === null) {
      assert(optional, `${accountName} must exist`);
      assert.equal(decoded, null, `${accountName} absent/decoded consistency`);
      return;
    }
    assert(account.value && decoded, `${accountName} must decode`);
    assert.equal(account.value.owner, expected.tokenProgram, `${accountName} SPL program owner`);
    assert.equal(decoded.mint, expected.mint, `${accountName} original mint`);
    assert.equal(decoded.owner, owner, `${accountName} token authority`);
    assert.equal(decoded.state, 1, `${accountName} initialized and unfrozen`);
    assert.equal(decoded.amount, amount, `${accountName} amount`);
  }
  check('listAta', 'listingToken', expected.listAta, expected.listing, '1', false);
  check('sellerAta', 'seller', expected.sellerAta, expected.seller, '0', true);
  check('buyerAta', 'buyer', expected.buyerAta, expected.buyer, '0', true);
}
