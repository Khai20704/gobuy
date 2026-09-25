import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { canonicalProposal, canonicalPolicy, hex, policyHash, proposalSchema, amountSchema,
  DEFAULT_MANDATE, previewReason, previewRules, type CommerceProposal } from '../src/index.ts'

export const fixture: CommerceProposal = {
  id: '00112233-4455-4677-8899-aabbccddeeff', assetType: 'NFT', title: 'Study',
  amount: '170000000', currency: 'DEVNET_SOL_LAMPORTS', decimals: 9,
  marketplace: 'DEMO_MARKET', assetId: 'demo:08',
  sellerEvidence: { source: 'mock-adapter', claimedVerified: true, reference: 'fixture:08', disclaimer: 'Demo claim' },
  metadata: { imageUrl: '/demo/artwork.svg', description: 'Demo', demo: true }, expiresAt: 2000000000,
}
test('amounts remain exact u64 integer strings', () => {
  for (const input of ['1', '9007199254740993', '18446744073709551615']) assert.equal(amountSchema.parse(input), input)
  for (const input of ['0', '-1', '1.2', '01', '1e9', '18446744073709551616', 100]) assert.equal(amountSchema.safeParse(input).success, false)
})
test('canonical bytes match the documented fixed-width wire encoding', async () => {
  const p = await canonicalProposal(fixture)
  const sha = (input: string | Buffer) => createHash('sha256').update(input).digest()
  const amount = Buffer.alloc(8); amount.writeBigUInt64LE(170000000n)
  const expiry = Buffer.alloc(8); expiry.writeBigInt64LE(2000000000n)
  const expected = Buffer.concat([
    Buffer.from('gobuy:proposal:v1'), Buffer.from('00112233445546778899aabbccddeeff', 'hex'),
    amount, Buffer.from([1, 1, 1, 1]), sha('demo:08'),
    sha('["mock-adapter",true,"fixture:08","Demo claim"]'),
    sha('["Study","/demo/artwork.svg","Demo",true]'), expiry,
  ])
  assert.equal(hex(p.bytes), expected.toString('hex'))
  assert.equal(hex(p.hash), sha(expected).toString('hex'))
  assert.equal(hex(p.hash), '46dd220afb7a52db29a6a89b5d740d12b2d8585a654b793c7d2260478655d112')
  assert.equal(hex(await policyHash(DEFAULT_MANDATE)), '169f249c81675717ee1075827a752406c454cd7736b19cd79d19c4853a6452fa')
  assert.equal(hex(await policyHash(DEFAULT_MANDATE)), sha(Buffer.from(canonicalPolicy(DEFAULT_MANDATE))).toString('hex'))
})
test('hash changes when price, identity, evidence or metadata changes', async () => {
  const original = hex((await canonicalProposal(fixture)).hash)
  for (const changed of [
    { ...fixture, amount: '170000001' }, { ...fixture, id: '11112233-4455-4677-8899-aabbccddeeff' },
    { ...fixture, title: 'Other' }, { ...fixture, expiresAt: fixture.expiresAt + 1 },
    { ...fixture, sellerEvidence: { ...fixture.sellerEvidence, claimedVerified: false } },
  ]) assert.notEqual(hex((await canonicalProposal(changed)).hash), original)
})
test('extra verdicts and unsafe image URLs cannot enter the proposal contract', () => {
  assert.equal(proposalSchema.safeParse({ ...fixture, approved: true }).success, false)
  assert.equal(proposalSchema.safeParse({ ...fixture, metadata: { ...fixture.metadata, imageUrl: 'javascript:alert(1)' } }).success, false)
})
test('preview rule priorities and expiry boundary are deterministic', () => {
  assert.equal(previewReason(previewRules(fixture, DEFAULT_MANDATE, 1, 1999999999)), 'APPROVED')
  assert.equal(previewReason(previewRules(fixture, DEFAULT_MANDATE, 1, 2000000000)), 'EXPIRED')
  assert.equal(previewReason(previewRules(fixture, DEFAULT_MANDATE, 0, 2000000000)), 'STALE_VERSION')
  assert.equal(previewReason(previewRules({ ...fixture, assetType: 'RWA' }, { ...DEFAULT_MANDATE, assetType: 'RWA' }, 1, 1)), 'RWA_READ_ONLY')
})
