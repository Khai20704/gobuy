// Test-only harness. Called by the preflight while its fresh validator is alive.
// No environment files, persisted signers, backend services or remote RPC writes.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertPrePurchaseTokens } from './tensor-fixture-assertions.mjs';
import { createMandateInstruction, mandatePdas } from '../backend/src/services/mandate/mandateInstructions.ts';
import { decodeMandateAccount } from '../backend/src/services/mandate/MandateGuard.ts';
import { createNftPurchaseAuthorizationInstruction, buyNftFromMandateInstruction,
  nftAuthorizationAddress, purchaseReceiptAddress } from '../backend/src/services/nft-purchase/nftPurchaseInstructions.ts';
import { decodeNftPurchaseAuthorization, decodeNftPurchaseReceipt } from '../backend/src/services/nft-purchase/nftPurchaseAccounts.ts';
import { assertTensorBuyLegacyInstruction, tensorRemainingAccounts } from '../backend/src/services/nft-purchase/tensorBuyLegacyLayout.ts';

const backend = createRequire(new URL('../backend/package.json', import.meta.url));
const adapter = createRequire(new URL('../tensor-adapter/package.json', import.meta.url));
const { Connection, PublicKey, Keypair, SystemProgram, Transaction, TransactionInstruction,
  ComputeBudgetProgram, SYSVAR_CLOCK_PUBKEY, SYSVAR_INSTRUCTIONS_PUBKEY } = backend('@solana/web3.js');
const token = backend('@solana/spl-token');
const kit = adapter('@solana/web3.js');
const tensor = adapter('@tensor-foundation/marketplace');
const metadataSdk = adapter('@tensor-foundation/mpl-token-metadata');
const RPC = 'http://127.0.0.1:18899';
const PROGRAM = new PublicKey('CHjdqooB7TrussJoZoboFP5TtdCspoHtvPpqoshbr5zE');
const TENSOR = new PublicKey('TCMPhJdwDryooaGtiocG1u3xcYbRpiJzb283XfCZsDp');
const METADATA = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
const PRICE = 100_000_000n;
const BUDGET = 500_000_000n;
const CASES = ['valid-purchase', 'duplicate-order', 'invalid-listing', 'wrong-mint',
  'unauthorized-executor', 'expired-authorization', 'insufficient-mandate-budget',
  'insufficient-authorization-budget', 'invalid-destination', 'transaction-rollback'];
const str = key => key.toBase58();
const address = key => kit.address(str(key));
// SDK signer descriptors mark account roles; web3 v1 signs with fresh in-memory Keypairs.
const descriptor = key => kit.createNoopSigner(address(key));
const pda = (seeds, program = PROGRAM) => PublicKey.findProgramAddressSync(seeds, program)[0];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const json = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2) + '\n';
function bridge(ix) {
  return new TransactionInstruction({ programId: new PublicKey(ix.programAddress),
    data: Buffer.from(ix.data), keys: ix.accounts.map(a => ({ pubkey: new PublicKey(a.address),
      isSigner: kit.isSignerRole(a.role), isWritable: kit.isWritableRole(a.role) })) });
}
function newFixture() {
  const seller = Keypair.generate(), owner = Keypair.generate(), agent = Keypair.generate();
  const intruder = Keypair.generate(), mintSigner = Keypair.generate(), mint = mintSigner.publicKey;
  const { mandate, vault } = mandatePdas(PROGRAM, owner.publicKey);
  const listing = pda([Buffer.from('list_state'), mint.toBuffer()], TENSOR);
  const metadata = pda([Buffer.from('metadata'), METADATA.toBuffer(), mint.toBuffer()], METADATA);
  const edition = pda([Buffer.from('metadata'), METADATA.toBuffer(), mint.toBuffer(), Buffer.from('edition')], METADATA);
  const sellerAta = token.getAssociatedTokenAddressSync(mint, seller.publicKey);
  const buyerAta = token.getAssociatedTokenAddressSync(mint, owner.publicKey);
  const listAta = token.getAssociatedTokenAddressSync(mint, listing, true);
  const authorization = nftAuthorizationAddress(PROGRAM, mandate);
  return { seller, owner, agent, intruder, mintSigner, mint, mandate, vault, listing, metadata,
    edition, sellerAta, buyerAta, listAta, authorization, order: randomBytes(16) };
}
function metadataInstructions(f) {
  const signer = descriptor(f.seller.publicKey);
  return [bridge(metadataSdk.getCreateMetadataAccountV3Instruction({
    metadata: address(f.metadata), mint: address(f.mint), mintAuthority: signer, payer: signer,
    updateAuthority: signer, data: { name: 'GoBuy local original', symbol: 'GBTEST',
      uri: 'https://example.invalid/gobuy-local-test.json', sellerFeeBasisPoints: 0,
      creators: null, collection: null, uses: null }, isMutable: true, collectionDetails: null,
  })), bridge(metadataSdk.getCreateMasterEditionV3Instruction({
    edition: address(f.edition), mint: address(f.mint), updateAuthority: signer,
    mintAuthority: signer, payer: signer, metadata: address(f.metadata), maxSupply: 0n,
  }))];
}
function listingInstruction(f) {
  return bridge(tensor.getListLegacyInstruction({ owner: descriptor(f.seller.publicKey),
    payer: descriptor(f.seller.publicKey), ownerTa: address(f.sellerAta), listState: address(f.listing),
    listTa: address(f.listAta), mint: address(f.mint), metadata: address(f.metadata), edition: address(f.edition),
    amount: PRICE, expireInSec: 3600n, tokenStandard: metadataSdk.TokenStandard.NonFungible,
    tokenMetadataProgram: address(METADATA), sysvarInstructions: address(SYSVAR_INSTRUCTIONS_PUBKEY),
  }));
}
async function buyInstruction(f) {
  const [fee] = await tensor.findFeeVaultPda({ address: address(f.listing) });
  f.feeVault = new PublicKey(fee);
  const ix = tensor.getBuyLegacyInstruction({ feeVault: fee, buyer: address(f.owner.publicKey),
    buyerTa: address(f.buyerAta), listTa: address(f.listAta), listState: address(f.listing),
    mint: address(f.mint), owner: address(f.seller.publicKey), payer: descriptor(f.vault),
    rentDestination: address(f.seller.publicKey), metadata: address(f.metadata), edition: address(f.edition),
    maxAmount: PRICE, tokenStandard: metadataSdk.TokenStandard.NonFungible,
    tokenMetadataProgram: address(METADATA), sysvarInstructions: address(SYSVAR_INSTRUCTIONS_PUBKEY),
  });
  const portable = { programAddress: ix.programAddress, data: ix.data, accounts: ix.accounts.map(a => ({
    address: a.address, isSigner: kit.isSignerRole(a.role), isWritable: kit.isWritableRole(a.role),
  })) };
  assertTensorBuyLegacyInstruction(portable, { payer: str(f.vault), buyer: str(f.owner.publicKey),
    buyerTokenAccount: str(f.buyerAta), mint: str(f.mint), listState: str(f.listing),
    seller: str(f.seller.publicKey), priceLamports: PRICE });
  assert.deepEqual(portable.accounts.flatMap((a,i) => a.isSigner ? [i] : []), [7]);
  f.tensor = portable;
  return purchase(f);
}
function purchase(f, { executor = f.agent.publicKey, expectedMint = f.mint, accounts = f.tensor.accounts } = {}) {
  return buyNftFromMandateInstruction(PROGRAM, { executor, owner: str(f.owner.publicKey),
    orderId: f.order, expectedMint, maxPriceLamports: PRICE,
    tensorAccounts: tensorRemainingAccounts({ ...f.tensor, accounts }) });
}

export async function runStep7({ evidenceDir, preflight }) {
  const out = evidenceDir;
  await mkdir(out, { recursive: true });
  const report = { status: 'BLOCKED', startedAt: new Date().toISOString(),
    realTensorCpi: 'NOT_VERIFIED', originalNftDelivered: 'NOT_TESTED', vaultPdaPayment: 'NOT_VERIFIED',
    authorizationAndReceipt: 'NOT_VERIFIED', negativePassed: 0, negativeTotal: 9,
    tests: CASES.map(name => ({ name, status: 'BLOCKED', reason: 'Not executed' })),
    environment: { rpc: RPC, node: process.version, validator: preflight.validatorVersion,
      genesisHash: preflight.genesisHash, gobuy: preflight.gobuy, programs: preflight.loadedPrograms,
      marketplaceSdk: '1.0.0', metadataSdk: '1.0.0-beta.1' } };
  const save = (name, value) => writeFile(join(out, name), json(value));
  const conn = new Connection(RPC, { commitment: 'confirmed', disableRetryOnRateLimit: true,
    fetch: async (url, options) => {
      assert.equal(String(url), RPC, 'Remote RPC forbidden in Step 7');
      return fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(15000) });
    } });
  let sequence = 0;
  async function confirmed(signature) {
    for (let i = 0; i < 60; i++) {
      const result = await conn.getSignatureStatuses([signature]);
      const status = result.value[0];
      if (status && ['confirmed', 'finalized'].includes(status.confirmationStatus)) return status;
      await sleep(500);
    }
    throw new Error(`Confirmation timeout: ${signature}`);
  }
  async function transact(label, instructions, payer, additional = []) {
    const latest = await conn.getLatestBlockhash();
    const tx = new Transaction({ ...latest, feePayer: payer.publicKey }).add(
      // Unique instruction bytes prevent duplicate-order submissions reusing a cached signature
      // when the validator returns the same recent blockhash.
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 - sequence }), ...instructions);
    tx.sign(payer, ...additional);
    const prefix = `${String(++sequence).padStart(3, '0')}-${label}`;
    await save(`${prefix}-message.json`, { feePayer: str(payer.publicKey),
      signers: tx.signatures.map(s => str(s.publicKey)),
      instructions: tx.instructions.map(ix => ({ programId: str(ix.programId), data: ix.data.toString('hex'),
        accounts: ix.keys.map(k => ({ address: str(k.pubkey), isSigner: k.isSigner, isWritable: k.isWritable })) })) });
    // Submit failures too: preflight simulation is not rollback evidence.
    const signature = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 0 });
    await save(`${prefix}-submission.json`, { signature });
    await confirmed(signature);
    let chain;
    for (let i = 0; i < 20 && !chain; i++) {
      chain = await conn.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
      if (!chain) await sleep(500);
    }
    assert(chain?.meta, 'Confirmed transaction metadata unavailable');
    await save(`${prefix}-transaction.json`, { signature, ...chain });
    await writeFile(join(out, `${prefix}.log`), (chain.meta.logMessages ?? []).join('\n') + '\n');
    return { signature, chain, evidence: `${prefix}-transaction.json` };
  }
  async function ok(label, instructions, payer, additional) {
    const result = await transact(label, instructions, payer, additional);
    assert.equal(result.chain.meta.err, null, `${label} failed; see ${result.evidence}`);
    return result;
  }
  async function now() {
    const clock = await conn.getAccountInfo(SYSVAR_CLOCK_PUBKEY);
    assert(clock);
    return Number(clock.data.readBigInt64LE(32));
  }
  function tokenState(info) {
    if (!info) return null;
    assert(info.owner.equals(token.TOKEN_PROGRAM_ID));
    const data = token.AccountLayout.decode(info.data);
    return { mint: str(data.mint), owner: str(data.owner), amount: data.amount.toString(), state: data.state };
  }
  async function state(f, label) {
    const receipt = purchaseReceiptAddress(PROGRAM, f.mandate, f.order);
    const keys = { vault: f.vault, seller: f.seller.publicKey, owner: f.owner.publicKey,
      agent: f.agent.publicKey, intruder: f.intruder.publicKey, mint: f.mint,
      metadata: f.metadata, edition: f.edition, sellerAta: f.sellerAta, buyerAta: f.buyerAta,
      listAta: f.listAta, listing: f.listing, mandate: f.mandate, authorization: f.authorization,
      receipt, feeVault: f.feeVault };
    const infos = await conn.getMultipleAccountsInfo(Object.values(keys));
    const accounts = Object.fromEntries(Object.entries(keys).map(([name,key], i) => [name,
      { address: str(key), value: infos[i] ? { lamports: infos[i].lamports,
        owner: str(infos[i].owner), executable: infos[i].executable, data: infos[i].data.toString('base64') } : null }]));
    const get = name => infos[Object.keys(keys).indexOf(name)];
    const decode = (name, fn) => { const info = get(name); if (!info) return null;
      assert(info.owner.equals(PROGRAM)); return fn(info.data); };
    const snapshot = { accounts, decoded: {
      mandate: decode('mandate', decodeMandateAccount),
      authorization: decode('authorization', data => decodeNftPurchaseAuthorization(str(f.authorization), data)),
      receipt: decode('receipt', data => decodeNftPurchaseReceipt(str(receipt), data)),
      buyer: tokenState(get('buyerAta')), seller: tokenState(get('sellerAta')), listingToken: tokenState(get('listAta')),
    } };
    await save(`${label}-state.json`, snapshot);
    return snapshot;
  }
  const lamports = (s, name) => BigInt(s.accounts[name].value?.lamports ?? 0);
  function unchanged(before, after, payerName, fee) {
    for (const name of Object.keys(before.accounts)) {
      if (name === payerName) {
        assert.equal(lamports(before, name) - lamports(after, name), BigInt(fee), 'Failed tx only charges executor fee');
        const b = { ...before.accounts[name].value }, a = { ...after.accounts[name].value };
        delete b.lamports; delete a.lamports; assert.deepEqual(a,b);
      } else assert.deepEqual(after.accounts[name], before.accounts[name], `Rollback changed ${name}`);
    }
  }
  function cpiEvidence(f, result, mustSucceed) {
    const { meta, transaction } = result.chain;
    const logs = meta.logMessages ?? [];
    assert(logs.includes(`Program ${PROGRAM} invoke [1]`));
    assert(logs.includes(`Program ${TENSOR} invoke [2]`));
    assert(logs.some(l => l.includes('Instruction: BuyLegacy')));
    if (mustSucceed) assert(logs.includes(`Program ${TENSOR} success`));
    const keys = transaction.message.staticAccountKeys;
    const nested = meta.innerInstructions.flatMap(group => group.instructions)
      .filter(ix => keys[ix.programIdIndex].equals(TENSOR)
        && Buffer.from(kit.getBase58Encoder().encode(ix.data)).subarray(0,8).toString('hex') === '447f2b08d41ff972');
    assert.equal(nested.length, 1, 'Exactly one genuine BuyLegacy CPI');
    const ix = nested[0];
    assert.equal(ix.accounts.length, 24);
    for (const [slot, key] of [[1,f.owner.publicKey],[2,f.buyerAta],[4,f.listing],[5,f.mint],[6,f.seller.publicKey],[7,f.vault]]) {
      assert(keys[ix.accounts[slot]].equals(key), `CPI account ${slot}`);
    }
    const signers = keys.slice(0, transaction.message.header.numRequiredSignatures).map(str);
    assert.deepEqual(signers, [str(f.agent.publicKey)], 'Only executor signs purchase');
    return { signature: result.signature, payer: str(f.vault), buyer: str(f.owner.publicKey),
      originalMint: str(f.mint), signers, instruction: ix, evidence: result.evidence };
  }
  async function fixture(name, { mandateBudget = BUDGET, authBudget = mandateBudget, expiresIn = 3600 } = {}) {
    const f = newFixture();
    await buyInstruction(f);
    for (const signer of [f.seller, f.owner, f.agent, f.intruder]) {
      const signature = await conn.requestAirdrop(signer.publicKey, 3_000_000_000);
      const status = await confirmed(signature);
      assert.equal(status.err, null);
      await save(`${name}-airdrop-${str(signer.publicKey)}.json`, { address: str(signer.publicKey), signature, lamports: 3_000_000_000 });
    }
    const mintRent = await conn.getMinimumBalanceForRentExemption(token.MINT_SIZE);
    await ok(`${name}-mint`, [SystemProgram.createAccount({ fromPubkey: f.seller.publicKey,
      newAccountPubkey: f.mint, lamports: mintRent, space: token.MINT_SIZE, programId: token.TOKEN_PROGRAM_ID }),
      token.createInitializeMint2Instruction(f.mint, 0, f.seller.publicKey, f.seller.publicKey),
      token.createAssociatedTokenAccountInstruction(f.seller.publicKey, f.sellerAta, f.seller.publicKey, f.mint),
      token.createMintToInstruction(f.mint, f.sellerAta, f.seller.publicKey, 1)], f.seller, [f.mintSigner]);
    await ok(`${name}-metadata`, metadataInstructions(f), f.seller);
    const metadataInfo = await conn.getAccountInfo(f.metadata);
    assert(metadataInfo?.owner.equals(METADATA));
    const md = metadataSdk.getMetadataDecoder().decode(metadataInfo.data);
    assert.equal(md.mint, str(f.mint)); assert.equal(md.sellerFeeBasisPoints, 0);
    assert.equal(md.tokenStandard.__option, 'Some');
    assert.equal(md.tokenStandard.value, metadataSdk.TokenStandard.NonFungible);
    const mint = await token.getMint(conn, f.mint);
    assert.equal(mint.supply, 1n); assert.equal(mint.decimals, 0);
    await save(`${name}-metadata.json`, md);
    await ok(`${name}-listing`, [listingInstruction(f)], f.seller);
    const listing = await conn.getAccountInfo(f.listing);
    assert(listing?.owner.equals(TENSOR));
    const list = tensor.getListStateDecoder().decode(listing.data);
    assert.equal(list.owner, str(f.seller.publicKey)); assert.equal(list.assetId, str(f.mint));
    assert.equal(list.amount, PRICE); assert.equal(list.currency.__option, 'None');
    assert.equal(list.makerBroker.__option, 'None'); assert.equal(list.privateTaker.__option, 'None');
    assert.equal(list.cosigner, null);
    await save(`${name}-listing.json`, list);
    // Keep the real fee PDA rent-exempt locally, as Tensor's own fixtures do.
    const floor = await conn.getMinimumBalanceForRentExemption(0);
    await ok(`${name}-fee-rent`, [SystemProgram.transfer({ fromPubkey: f.seller.publicKey,
      toPubkey: f.feeVault, lamports: floor })], f.seller);
    await ok(`${name}-mandate`, [createMandateInstruction(PROGRAM, f.owner.publicKey, {
      maxBudgetLamports: mandateBudget, expiresAt: await now() + 3600, category: 'NFT',
      recipient: f.owner.publicKey, executor: f.agent.publicKey })], f.owner);
    f.expiresAt = await now() + expiresIn;
    const auth = await ok(`${name}-authorization`, [createNftPurchaseAuthorizationInstruction(PROGRAM, f.owner.publicKey, {
      maxTotalDebitLamports: authBudget, expiresAt: f.expiresAt, executor: f.agent.publicKey,
      recipient: f.owner.publicKey })], f.owner);
    const authSigners = auth.chain.transaction.message.staticAccountKeys
      .slice(0, auth.chain.transaction.message.header.numRequiredSignatures).map(str);
    assert.deepEqual(authSigners, [str(f.owner.publicKey)]);
    await save(`${name}-fixture.json`, { originalMint: str(f.mint), seller: str(f.seller.publicKey),
      buyer: str(f.owner.publicKey), executor: str(f.agent.publicKey), intruder: str(f.intruder.publicKey),
      mandate: str(f.mandate), vault: str(f.vault), authorization: str(f.authorization),
      listing: str(f.listing), sellerAta: str(f.sellerAta), buyerAta: str(f.buyerAta), listAta: str(f.listAta),
      order: f.order.toString('hex'), price: PRICE, mandateBudget, authBudget,
      ownerSignedAuthorization: auth.signature, authorizationSigners: authSigners });
    return f;
  }
  async function runCase(name, fn) {
    const test = report.tests.find(t => t.name === name);
    delete test.reason;
    test.status = 'RUNNING';
    await save('report.json', report);
    try { await fn(test); test.status = 'PASS'; if (name !== 'valid-purchase') report.negativePassed++; }
    catch (error) { test.status = 'FAIL'; test.reason = error.message; throw error; }
    finally { await save('report.json', report); }
  }
  async function rejectCase(name, options, mutate, expected, reachesTensor = false) {
    await runCase(name, async test => {
      const f = await fixture(name, options);
      if (name === 'expired-authorization') {
        const deadline = Date.now() + 60000;
        while (await now() <= f.expiresAt) {
          assert(Date.now() < deadline, 'Local clock did not reach authorization expiry'); await sleep(500);
        }
      }
      const { ix, payer = f.agent } = mutate(f);
      const before = await state(f, `${name}-before`);
      const result = await transact(name, [ix], payer);
      const after = await state(f, `${name}-after`);
      assert(result.chain.meta.err, 'Expected a confirmed on-chain failure');
      assert(result.chain.meta.logMessages.some(l => l.includes(`Error Code: ${expected}.`)), `Expected ${expected}; see ${result.evidence}`);
      if (reachesTensor) cpiEvidence(f, result, true);
      else assert(!result.chain.meta.logMessages.includes(`Program ${TENSOR} invoke [2]`));
      unchanged(before, after, payer === f.intruder ? 'intruder' : 'agent', result.chain.meta.fee);
      assert.equal(after.accounts.receipt.value, null);
      Object.assign(test, { signature: result.signature, evidence: result.evidence, expectedError: expected, reachesTensor });
    });
  }
  try {
    assert(preflight.validatorStarted && preflight.genuineProgramsLoaded && preflight.tensorDispatchExecuted);
    assert.equal(await conn.getGenesisHash(), preflight.genesisHash, 'Must use the preflight-owned fresh validator');
    const provenance = JSON.parse(await readFile(join(out, 'build-provenance.json'), 'utf8'));
    assert.equal(provenance.anchorSourceTreeVerified, true, 'Artifact source tree must match tested source');
    report.environment.provenance = provenance;
    let successful;
    await runCase('valid-purchase', async test => {
      const f = await fixture('valid-purchase'); successful = f;
      const before = await state(f, 'valid-purchase-before');
      assertPrePurchaseTokens(before, { mint: str(f.mint), listing: str(f.listing),
        listAta: str(f.listAta), sellerAta: str(f.sellerAta), buyerAta: str(f.buyerAta),
        seller: str(f.seller.publicKey), buyer: str(f.owner.publicKey), tokenProgram: str(token.TOKEN_PROGRAM_ID) });
      assert.equal(before.decoded.authorization.owner, str(f.owner.publicKey));
      assert.equal(before.decoded.authorization.executor, str(f.agent.publicKey));
      assert.equal(before.decoded.authorization.recipient, str(f.owner.publicKey));
      assert.equal(before.decoded.authorization.marketplace, str(TENSOR));
      assert.equal(before.decoded.authorization.active, true);
      assert.equal(before.decoded.mandate.owner, str(f.owner.publicKey));
      assert.equal(before.decoded.mandate.executor, str(f.agent.publicKey));
      assert.equal(before.decoded.mandate.vault, str(f.vault));
      assert.equal(before.accounts.receipt.value, null);
      const result = await ok('valid-purchase', [purchase(f)], f.agent);
      const cpi = cpiEvidence(f, result, true);
      const after = await state(f, 'valid-purchase-after');
      assert(after.accounts.buyerAta.value && after.decoded.buyer, 'Purchase must leave an existing decoded buyer ATA');
      assert.equal(after.decoded.buyer.mint, str(f.mint)); assert.equal(after.decoded.buyer.owner, str(f.owner.publicKey));
      assert.equal(after.decoded.buyer.amount, '1');
      assert.equal(after.accounts.listing.value, null); assert.equal(after.accounts.listAta.value, null);
      const debit = lamports(before,'vault') - lamports(after,'vault');
      const fee = PRICE * 200n / 10000n; // reviewed Tensor taker fee, no brokers or royalties
      const ataRent = before.accounts.buyerAta.value === null
        ? BigInt(await conn.getMinimumBalanceForRentExemption(token.ACCOUNT_SIZE)) : 0n;
      assert.equal(debit, PRICE + fee + ataRent);
      assert.equal(lamports(after,'feeVault') - lamports(before,'feeVault'), fee);
      assert.equal(lamports(after,'seller') - lamports(before,'seller'),
        PRICE + lamports(before,'listing') + lamports(before,'listAta'));
      assert.equal(after.decoded.mandate.spentLamports - before.decoded.mandate.spentLamports, debit);
      assert.equal(after.decoded.authorization.spentLamports - before.decoded.authorization.spentLamports, debit);
      assert.equal(after.decoded.mandate.maxBudgetLamports, BUDGET);
      assert.equal(after.decoded.authorization.maxTotalDebitLamports, BUDGET);
      const messageKeys = result.chain.transaction.message.staticAccountKeys;
      const payments = result.chain.meta.innerInstructions.flatMap(g => g.instructions).filter(ix => {
        const bytes = Buffer.from(kit.getBase58Encoder().encode(ix.data));
        return messageKeys[ix.programIdIndex].equals(SystemProgram.programId)
          && bytes.length === 12 && bytes.readUInt32LE(0) === 2;
      }).map(ix => ({ from: str(messageKeys[ix.accounts[0]]), to: str(messageKeys[ix.accounts[1]]),
        amount: Buffer.from(kit.getBase58Encoder().encode(ix.data)).readBigUInt64LE(4) }));
      assert(payments.some(p => p.from === str(f.vault) && p.to === str(f.seller.publicKey) && p.amount === PRICE),
        'Inner System transfer must pay seller directly from Vault');
      assert.equal(lamports(before,'agent') - lamports(after,'agent'), BigInt(result.chain.meta.fee) + lamports(after,'receipt'));
      assert.deepEqual(after.accounts.owner, before.accounts.owner);
      assert.deepEqual(after.accounts.mint, before.accounts.mint, 'Same original NFT; no replacement minting');
      const receipt = after.decoded.receipt;
      for (const [field,key] of Object.entries({ mandate:f.mandate, authorization:f.authorization, owner:f.owner.publicKey,
        executor:f.agent.publicKey, mint:f.mint, listing:f.listing, marketplace:TENSOR })) assert.equal(receipt[field], str(key));
      assert.equal(receipt.orderId, f.order.toString('hex'));
      assert.equal(receipt.totalDebitLamports, debit.toString()); assert.equal(receipt.priceLamports, PRICE.toString());
      const receipts = await conn.getProgramAccounts(PROGRAM, { filters: [{ dataSize: 274 },
        { memcmp: { offset: 9, bytes: str(f.mandate) } }] });
      assert.equal(receipts.length, 1); assert.equal(str(receipts[0].pubkey), receipt.address);
      await save('purchase-accounting.json', { debit, price: PRICE, tensorFee: fee, ataRent,
        executorTransactionFee: result.chain.meta.fee, receiptRent: lamports(after,'receipt'), receiptCount: receipts.length, cpi, payments });
      Object.assign(test, { signature: result.signature, evidence: result.evidence });
      Object.assign(report, { realTensorCpi: 'VERIFIED', originalNftDelivered: 'YES',
        vaultPdaPayment: 'VERIFIED', authorizationAndReceipt: 'VERIFIED' });
    });
    await runCase('duplicate-order', async test => {
      const f = successful, before = await state(f, 'duplicate-order-before');
      const result = await transact('duplicate-order', [purchase(f)], f.agent);
      const after = await state(f, 'duplicate-order-after');
      assert(result.chain.meta.err);
      assert(result.chain.meta.logMessages.some(l => /already in use|already initialized/i.test(l)), 'Receipt replay must fail initialization');
      assert(!result.chain.meta.logMessages.includes(`Program ${TENSOR} invoke [2]`));
      unchanged(before, after, 'agent', result.chain.meta.fee);
      Object.assign(test, { signature: result.signature, evidence: result.evidence });
    });
    const swapped = (f, index, key) => f.tensor.accounts.map((a,i) => i === index ? { ...a, address: str(key) } : a);
    await rejectCase('invalid-listing', {}, f => ({ ix: purchase(f, { accounts: swapped(f,4,f.seller.publicKey) }) }), 'InvalidListing');
    await rejectCase('wrong-mint', {}, f => ({ ix: purchase(f, { expectedMint: Keypair.generate().publicKey }) }), 'InvalidListing');
    await rejectCase('unauthorized-executor', {}, f => ({ ix: purchase(f, { executor: f.intruder.publicKey }), payer: f.intruder }), 'InvalidOwner');
    await rejectCase('expired-authorization', { expiresIn: 8 }, f => ({ ix: purchase(f) }), 'PurchaseAuthorizationExpired');
    await rejectCase('insufficient-mandate-budget', { mandateBudget: PRICE - 1n }, f => ({ ix: purchase(f) }), 'BudgetExceeded');
    // Current source checks authorization's measured debit AFTER real Tensor CPI.
    await rejectCase('insufficient-authorization-budget', { authBudget: PRICE - 1n }, f => ({ ix: purchase(f) }), 'PurchaseAuthorizationBudgetExceeded', true);
    await rejectCase('invalid-destination', {}, f => ({ ix: purchase(f, { accounts: swapped(f,2,f.sellerAta) }) }), 'InvalidBuyerTokenAccount');
    await runCase('transaction-rollback', async test => {
      const f = await fixture('transaction-rollback'), before = await state(f, 'transaction-rollback-before');
      const result = await transact('transaction-rollback', [purchase(f), SystemProgram.transfer({
        fromPubkey: f.agent.publicKey, toPubkey: f.seller.publicKey, lamports: 100_000_000_000 })], f.agent);
      const after = await state(f, 'transaction-rollback-after');
      assert.equal(result.chain.meta.err?.InstructionError?.[0], 2, 'Failure must be AFTER GoBuy purchase');
      cpiEvidence(f, result, true);
      assert(result.chain.meta.logMessages.includes(`Program ${PROGRAM} success`));
      unchanged(before, after, 'agent', result.chain.meta.fee);
      assert.equal(after.accounts.receipt.value, null);
      Object.assign(test, { signature: result.signature, evidence: result.evidence });
    });
    report.status = 'PASS';
  } catch (error) {
    report.status = report.tests.some(t => t.status === 'FAIL') ? 'FAIL' : 'BLOCKED';
    report.error = error.message;
    throw error;
  } finally {
    report.finishedAt = new Date().toISOString();
    await save('report.json', report);
  }
  return report;
}

export async function checkEncoding() {
  const f = newFixture();
  const ix = await buyInstruction(f);
  assert.equal(ix.keys.length, 30); assert.equal(ix.keys[6+7].isSigner, false);
  assert(ix.keys[6+7].pubkey.equals(f.vault));
  assert(ix.keys[6+1].pubkey.equals(f.owner.publicKey));
  assert.equal(metadataInstructions(f).length, 2);
  const list = listingInstruction(f);
  assert(list.programId.equals(TENSOR)); assert.equal(list.keys.length, 19);
  assert(list.keys[0].isSigner); assert(list.keys[5].isSigner);
  for (const [instructions,payer] of [[metadataInstructions(f),f.seller], [[list],f.seller], [[ix],f.agent],
    [[ix, SystemProgram.transfer({ fromPubkey: f.agent.publicKey, toPubkey: f.seller.publicKey,
      lamports: 100_000_000_000 })],f.agent]]) {
    const tx = new Transaction({ feePayer: payer.publicKey, recentBlockhash: str(Keypair.generate().publicKey) })
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }), ...instructions);
    tx.sign(payer);
    assert(tx.serialize().length <= 1232, 'Local test transaction must fit packet size');
  }
  console.log('PASS: official SDK NFT/ListLegacy/BuyLegacy construction and GoBuy Vault account mapping (offline only)');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.equal(process.argv[2], '--check-encoding', 'Execute integration only through the owning preflight');
  await checkEncoding();
}
