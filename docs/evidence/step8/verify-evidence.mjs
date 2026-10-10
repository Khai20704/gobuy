// Offline audit only: reads archived public evidence; never connects or signs.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
const dir = new URL('./step7-pass/', import.meta.url);
const read = name => JSON.parse(fs.readFileSync(new URL('docs__evidence__step7__' + name + '.json', dir)));
const report = read('report');
const program = report.environment.gobuy.programId;
const tensor = report.environment.programs[1].address;
const checks = [];
for (const test of report.tests) {
  const tx = read(test.evidence.replace(/\.json$/, ''));
  assert.equal(tx.signature, test.signature);
  const positive = test.name === 'valid-purchase';
  assert.equal(tx.meta.err === null, positive);
  const before = read(test.name + '-before-state');
  const after = read(test.name + '-after-state');
  const logs = tx.meta.logMessages.join('\n');
  if (test.expectedError) assert(logs.includes(test.expectedError));
  if (test.reachesTensor !== undefined) assert.equal(logs.includes('Program ' + tensor + ' invoke [2]'), test.reachesTensor);
  if (!positive) {
    let feeDelta = 0;
    for (const [name, account] of Object.entries(before.accounts)) {
      const next = after.accounts[name];
      if (JSON.stringify(account) === JSON.stringify(next)) continue;
      assert(['agent', 'intruder'].includes(name), test.name + ': changed ' + name);
      assert.deepEqual({...account.value, lamports: next.value.lamports}, next.value);
      const payer = tx.transaction.message.accountKeys[0];
      assert.equal(account.address, typeof payer === 'string' ? payer : payer.pubkey);
      feeDelta += account.value.lamports - next.value.lamports;
    }
    assert.equal(feeDelta, tx.meta.fee);
    if (test.name === 'transaction-rollback') {
      assert(logs.includes('Program ' + program + ' success'));
      assert(logs.includes('Program ' + tensor + ' success'));
      assert.equal(tx.meta.err.InstructionError[0], 2);
    }
  } else {
    const f = read('valid-purchase-fixture');
    const authorizationTx = read('006-valid-purchase-authorization-transaction');
    assert.equal(authorizationTx.signature,f.ownerSignedAuthorization);
    assert.equal(authorizationTx.meta.err,null);
    assert.equal(authorizationTx.transaction.message.header.numRequiredSignatures,1);
    const authorizationPayer=authorizationTx.transaction.message.accountKeys[0];
    assert.equal(typeof authorizationPayer==='string'?authorizationPayer:authorizationPayer.pubkey,f.buyer);
    assert.equal(before.accounts.receipt.value,null);
    assert(logs.includes('Program ' + program + ' invoke [1]'));
    assert(logs.includes('Program ' + tensor + ' invoke [2]'));
    const keys = tx.transaction.message.accountKeys;
    const key = index => typeof keys[index] === 'string' ? keys[index] : keys[index].pubkey;
    const inner = tx.meta.innerInstructions.flatMap(i => i.instructions).filter(i => key(i.programIdIndex) === tensor && i.stackHeight === 2);
    assert.equal(inner.length, 1);
    assert.equal(inner[0].stackHeight, 2);
    assert.equal(inner[0].data, '3qnGEUcRWqJPkbkbdzxmhfMEF'); // fixture BuyLegacy, 100,000,000 lamports
    assert.equal(key(inner[0].accounts[7]), f.vault);
    assert.equal(key(0), f.executor);
    assert.equal(tx.transaction.message.header.numRequiredSignatures, 1);
    assert.equal(after.accounts.buyerAta.address, getAssociatedTokenAddressSync(new PublicKey(f.originalMint), new PublicKey(f.buyer)).toBase58());
    const token = Buffer.from(after.accounts.buyerAta.value.data, 'base64');
    assert.equal(new PublicKey(token.subarray(0,32)).toBase58(), f.originalMint);
    assert.equal(new PublicKey(token.subarray(32,64)).toBase58(), f.buyer);
    assert.equal(token.readBigUInt64LE(64), 1n);
    assert.deepEqual(before.accounts.mint, after.accounts.mint);
    assert.equal(after.accounts.listing.value, null);
    assert.equal(after.accounts.listAta.value, null);
    const debit = before.accounts.vault.value.lamports - after.accounts.vault.value.lamports;
    assert.equal(debit, 104039280);
    assert.equal(after.accounts.feeVault.value.lamports - before.accounts.feeVault.value.lamports, 2000000);
    assert.equal(debit, Number(f.price) + 2000000 + after.accounts.buyerAta.value.lamports);
    for (const [name, offset] of [['mandate',112], ['authorization',177]]) {
      const b = Buffer.from(before.accounts[name].value.data, 'base64');
      const a = Buffer.from(after.accounts[name].value.data, 'base64');
      assert.equal(a.readBigUInt64LE(offset) - b.readBigUInt64LE(offset), BigInt(debit));
    }
    const receipt = Buffer.from(after.accounts.receipt.value.data,'base64');
    assert.equal(receipt.length,274);
    assert.equal(receipt.subarray(0,8).toString('hex'),createHash('sha256').update('account:NftPurchaseReceipt').digest('hex').slice(0,16));
    assert.equal(receipt.readBigUInt64LE(241),BigInt(debit));
    assert.equal(receipt.subarray(249,265).toString('hex'),f.order);
    for (const [offset, value] of [[9,f.mandate],[41,f.authorization],[73,f.buyer],[105,f.executor],[137,f.originalMint],[169,f.listing],[201,tensor]]) assert.equal(new PublicKey(receipt.subarray(offset,offset+32)).toBase58(),value);
    assert.equal(before.accounts.agent.value.lamports-after.accounts.agent.value.lamports,tx.meta.fee+after.accounts.receipt.value.lamports);
    assert.deepEqual(before.accounts.owner,after.accounts.owner);
  }
  checks.push({name:test.name,verified:true,error:tx.meta.err,computeUnits:tx.meta.computeUnitsConsumed});
}
assert.equal(checks.length,10);
const snapshot = JSON.parse(fs.readFileSync(new URL('./devnet-snapshot.json',import.meta.url)));
assert.equal(snapshot.genesis,'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG');
assert.equal(snapshot.programAccount.value.executable,true);
assert.equal(snapshot.programAccount.value.owner,'BPFLoaderUpgradeab1e11111111111111111111111');
for (const entry of snapshot.accounts.value) {
  const data=Buffer.from(entry.account.data[0],'base64');
  assert.equal(entry.account.owner,program);
  if(data.length===181) {
    assert.equal(data.subarray(0,8).toString('hex'),'71d8629fb93f3712');
    const [mandate,bump]=PublicKey.findProgramAddressSync([Buffer.from('mandate'),data.subarray(8,40)],new PublicKey(program));
    assert.equal(mandate.toBase58(),entry.pubkey); assert.equal(bump,data[147]);
    const [vault,vaultBump]=PublicKey.findProgramAddressSync([Buffer.from('vault'),mandate.toBuffer()],new PublicKey(program));
    assert.equal(vault.toBase58(),new PublicKey(data.subarray(40,72)).toBase58()); assert.equal(vaultBump,data[148]);
  } else { assert.equal(data.length,194); assert.equal(data.subarray(0,8).toString('hex'),'0ca553109f951940'); }
}
console.log(JSON.stringify({status:'PASS',positive:1,negative:9,checks},null,2));
