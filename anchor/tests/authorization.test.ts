import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { BN, Program, type Idl } from '@anchor-lang/core'
import { Connection, Keypair, PublicKey, SystemProgram, sendAndConfirmTransaction, type Transaction } from '@solana/web3.js'
import { canonicalProposal, policyHash, hex, assetCode, marketCode, DEFAULT_MANDATE,
  type CommerceProposal, type MandateInput } from '@gobuy/shared'

// Opt-in integration suite uses ONLY Devnet test SOL and ephemeral test signers.
// Never reads or persists a user's key. Backend is not part of transaction signing.
test('Anchor Devnet: owner enforcement, rules, audit records and replay protection', {
  skip: process.env.GOBUY_RUN_DEVNET_TESTS !== '1', timeout: 240000,
}, async t => {
  const connection = new Connection(process.env.SOLANA_DEVNET_RPC_URL || 'https://api.devnet.solana.com', 'confirmed')
  assert.equal(await connection.getGenesisHash(), 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1', 'Devnet only')
  const idl = JSON.parse(readFileSync(new URL('../target/idl/gobuy_na.json', import.meta.url), 'utf8')) as Idl
  assert.notEqual(idl.address, SystemProgram.programId.toBase58(), 'Configure and deploy a real program first')
  const program = new Program(idl, { connection })
  assert.equal((await connection.getAccountInfo(program.programId))?.executable, true)
  const owner = Keypair.generate()
  const attacker = Keypair.generate()
  const drop = await connection.requestAirdrop(owner.publicKey, 1000000000)
  const latest = await connection.getLatestBlockhash()
  assert.equal((await connection.confirmTransaction({ signature: drop, ...latest }, 'confirmed')).value.err, null)
  const mandate = PublicKey.findProgramAddressSync([Buffer.from('mandate'), owner.publicKey.toBuffer()], program.programId)[0]
  const accounts = { owner: owner.publicKey, mandate, systemProgram: SystemProgram.programId }
  const send = (tx: Transaction, extra: Keypair[] = []) => sendAndConfirmTransaction(connection, tx, [owner, ...extra], { commitment: 'confirmed' })
  const read = async <T>(name: string, address: PublicKey) => {
    const info = await connection.getAccountInfo(address, 'confirmed')
    assert.ok(info)
    assert.ok(info.owner.equals(program.programId))
    return program.coder.accounts.decode<T>(name, info.data)
  }
  const policyArgs = async (m: MandateInput) => ({
    maxAmount: new BN(m.maxAmount), currency: 1, assetType: assetCode(m.assetType), marketplace: marketCode(m.marketplace),
    requireVerifiedSeller: m.requireVerifiedSeller, autonomy: m.autonomy, policyHash: Array.from(await policyHash(m)),
  })
  let version = 1
  const update = async (m: MandateInput) => {
    await send(await program.methods.updateMandate(await policyArgs(m), new BN(version)).accountsStrict({ owner: owner.publicKey, mandate }).transaction())
    version++
  }
  const makeProposal = (patch: Partial<CommerceProposal> = {}): CommerceProposal => ({
    id: crypto.randomUUID(), assetType: 'NFT', title: 'Devnet integration fixture', amount: '170000000',
    currency: 'DEVNET_SOL_LAMPORTS', decimals: 9, marketplace: 'DEMO_MARKET', assetId: 'demo:test:08',
    sellerEvidence: { source: 'mock-adapter', claimedVerified: true, reference: 'fixture:test', disclaimer: 'Unverified demo claim' },
    metadata: { imageUrl: '/demo/artwork.svg', description: 'Integration fixture', demo: true },
    expiresAt: Math.floor(Date.now() / 1000) + 3600, ...patch,
  })
  const proposalArgs = async (p: CommerceProposal) => {
    const canonical = await canonicalProposal(p)
    return {
      proposalId: Array.from(canonical.proposalId), amount: new BN(p.amount), currency: 1,
      assetType: assetCode(p.assetType), marketplace: marketCode(p.marketplace),
      sellerClaimedVerified: p.sellerEvidence.claimedVerified, assetIdHash: Array.from(canonical.assetIdHash),
      evidenceHash: Array.from(canonical.evidenceHash), metadataHash: Array.from(canonical.metadataHash),
      expiresAt: new BN(p.expiresAt), proposalHash: Array.from(canonical.hash),
    }
  }
  const actionAddress = (id: number[]) => PublicKey.findProgramAddressSync([Buffer.from('action'), mandate.toBuffer(), Buffer.from(id)], program.programId)[0]
  type RecordValue = { approved: boolean; reasonCode: number; checks: number; proposalHash: number[];
    mandateVersion: BN; currentVersion: BN; timestamp: BN }
  const authorize = async (p: CommerceProposal, requestedVersion = version, expectedReason = 0) => {
    const args = await proposalArgs(p)
    const actionRecord = actionAddress(args.proposalId)
    await send(await program.methods.authorizeProposal(args, new BN(requestedVersion)).accountsStrict({ ...accounts, actionRecord }).transaction())
    const record = await read<RecordValue>('actionRecord', actionRecord)
    assert.equal(record.reasonCode, expectedReason)
    assert.equal(record.approved, expectedReason === 0)
    assert.equal(record.mandateVersion.toNumber(), requestedVersion)
    assert.equal(record.currentVersion.toNumber(), version)
    assert.equal(hex(Uint8Array.from(record.proposalHash)), hex((await canonicalProposal(p)).hash))
    assert.ok(record.timestamp.toNumber() > 0)
    return { actionRecord, record }
  }
  await t.test('initialize requires owner signature and stores canonical policy', async () => {
    const ix = await program.methods.initializeMandate(await policyArgs(DEFAULT_MANDATE)).accountsStrict(accounts).transaction()
    ix.feePayer = attacker.publicKey
    ix.recentBlockhash = (await connection.getLatestBlockhash()).blockhash
    ix.partialSign(attacker)
    assert.throws(() => ix.serialize(), /signature/i)
    await send(await program.methods.initializeMandate(await policyArgs(DEFAULT_MANDATE)).accountsStrict(accounts).transaction())
    const m = await read<{ owner: PublicKey; version: BN; policyHash: number[] }>('mandate', mandate)
    assert.ok(m.owner.equals(owner.publicKey))
    assert.equal(m.version.toNumber(), 1)
    assert.equal(hex(Uint8Array.from(m.policyHash)), hex(await policyHash(DEFAULT_MANDATE)))
  })
  await t.test('another signer cannot update the owner mandate', async () => {
    const tx = await program.methods.updateMandate(await policyArgs(DEFAULT_MANDATE), new BN(version))
      .accountsStrict({ owner: attacker.publicKey, mandate }).transaction()
    await assert.rejects(send(tx, [attacker]))
    assert.equal((await read<{ version: BN }>('mandate', mandate)).version.toNumber(), version)
  })
  await t.test('another signer cannot authorize against the owner mandate', async () => {
    const args = await proposalArgs(makeProposal())
    const actionRecord = actionAddress(args.proposalId)
    const tx = await program.methods.authorizeProposal(args, new BN(version))
      .accountsStrict({ ...accounts, owner: attacker.publicKey, actionRecord }).transaction()
    await assert.rejects(send(tx, [attacker]))
    assert.equal(await connection.getAccountInfo(actionRecord), null)
  })
  await t.test('owner update increments version; stale update cannot overwrite', async () => {
    await update(DEFAULT_MANDATE)
    assert.equal((await read<{ version: BN }>('mandate', mandate)).version.toNumber(), 2)
    const tx = await program.methods.updateMandate(await policyArgs(DEFAULT_MANDATE), new BN(1)).accountsStrict({ owner: owner.publicKey, mandate }).transaction()
    await assert.rejects(send(tx))
  })
  const original = makeProposal()
  await t.test('within budget writes an approved record', async () => {
    const { record } = await authorize(original)
    assert.equal(record.checks, 511)
  })
  await t.test('duplicate ID cannot replay even with changed price/hash', async () => {
    const args = await proposalArgs({ ...original, amount: '1' })
    await assert.rejects(send(await program.methods.authorizeProposal(args, new BN(version)).accountsStrict({ ...accounts, actionRecord: actionAddress(args.proposalId) }).transaction()))
  })
  await t.test('price fail writes a rejected audit record', async () => { await authorize(makeProposal({ amount: '200000001' }), version, 4) })
  await t.test('price boundary passes', async () => { await authorize(makeProposal({ amount: '200000000' })) })
  await t.test('asset type fail', async () => { await authorize(makeProposal({ assetType: 'RWA' }), version, 6) })
  await t.test('marketplace fail', async () => { await authorize(makeProposal({ marketplace: 'DEMO_GALLERY' }), version, 7) })
  await t.test('seller evidence fail', async () => {
    const p = makeProposal(); p.sellerEvidence.claimedVerified = false
    await authorize(p, version, 8)
  })
  await t.test('autonomy off records rejection', async () => {
    await update({ ...DEFAULT_MANDATE, autonomy: false })
    await authorize(makeProposal(), version, 3)
    await update(DEFAULT_MANDATE)
  })
  await t.test('expiry fail', async () => { await authorize(makeProposal({ expiresAt: 1 }), version, 2) })
  await t.test('stale mandate version records rejection', async () => { await authorize(makeProposal(), version - 1, 1) })
  await t.test('duplicate ID remains blocked after a mandate update', async () => {
    await update(DEFAULT_MANDATE)
    const args = await proposalArgs(original)
    await assert.rejects(send(await program.methods.authorizeProposal(args, new BN(version)).accountsStrict({ ...accounts, actionRecord: actionAddress(args.proposalId) }).transaction()))
  })
  await t.test('malformed hash does not create an audit record', async () => {
    const args = await proposalArgs(makeProposal())
    args.amount = new BN(1)
    const actionRecord = actionAddress(args.proposalId)
    await assert.rejects(send(await program.methods.authorizeProposal(args, new BN(version)).accountsStrict({ ...accounts, actionRecord }).transaction()))
    assert.equal(await connection.getAccountInfo(actionRecord), null)
  })
  await t.test('RWA remains read-only even with an RWA mandate', async () => {
    await update({ ...DEFAULT_MANDATE, assetType: 'RWA' })
    await authorize(makeProposal({ assetType: 'RWA' }), version, 9)
  })
})
