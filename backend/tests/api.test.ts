import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import type { Server } from 'node:http'
import { createApp } from '../src/app.ts'
import { DiscoveryService } from '../src/application/DiscoveryService.ts'
import { MockLLMProvider } from '../src/adapters/llm/LLMProvider.ts'
let server: Server
let url: string
before(async () => {
  server = createApp().listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No listener')
  url = 'http://127.0.0.1:' + address.port
})
after(() => new Promise<void>(resolve => server.close(() => resolve())))
const post = (body: unknown) => fetch(url + '/api/proposals/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
test('health declares demo mode and devnet', async () => {
  const response = await fetch(url + '/api/health')
  assert.deepEqual(await response.json(), { status: 'ok', mode: 'demo', cluster: 'devnet' })
})
test('search returns unique expiring proposals, never authorization', async () => {
  const first = await (await post({ text: 'Find art' })).json()
  const second = await (await post({ text: 'Find art' })).json()
  assert.equal(first.mode, 'demo')
  assert.notEqual(first.proposals[0].id, second.proposals[0].id)
  assert.equal(first.proposals[0].amount, '170000000')
  assert.ok(first.proposals[0].expiresAt > Date.now() / 1000)
  assert.equal('approved' in first, false)
  assert.equal('approved' in first.proposals[0], false)
})
test('all mock scenarios are reachable through API', async () => {
  for (const scenario of ['within', 'outside', 'unverified', 'wrong-market', 'rwa']) {
    const response = await post({ text: 'sample', scenario })
    assert.equal(response.status, 200)
    const p = (await response.json()).proposals[0]
    if (scenario === 'outside') assert.equal(p.amount, '280000000')
    if (scenario === 'unverified') assert.equal(p.sellerEvidence.claimedVerified, false)
    if (scenario === 'wrong-market') assert.equal(p.marketplace, 'DEMO_GALLERY')
    if (scenario === 'rwa') assert.equal(p.assetType, 'RWA')
  }
})
test('rejects blank requests, oversized text and authority fields', async () => {
  for (const body of [{}, { text: ' ' }, { text: 'x'.repeat(2001) }, { text: 'x', approved: true }, { text: 'x', mandate: {} }]) {
    assert.equal((await post(body)).status, 400)
  }
})
test('accepts image input and rejects MIME spoofing / size violations', async () => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1sAAAAASUVORK5CYII='
  assert.equal((await post({ image: { mimeType: 'image/png', base64: png } })).status, 200)
  for (const image of [
    { mimeType: 'image/png', base64: Buffer.from('not an image').toString('base64') },
    { mimeType: 'image/svg+xml', base64: png },
    { mimeType: 'image/png', base64: '***' },
    { mimeType: 'image/png', base64: Buffer.alloc(2 * 1024 * 1024 + 1).toString('base64') },
  ]) assert.equal((await post({ image })).status, 400)
  assert.equal((await post({ text: 'x'.repeat(3 * 1024 * 1024) })).status, 413)
})
test('malformed JSON is a safe 400, nonexistent authorize endpoint is 404', async () => {
  const malformed = await fetch(url + '/api/proposals/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })
  assert.equal(malformed.status, 400)
  assert.equal((await fetch(url + '/api/authorize', { method: 'POST' })).status, 404)
})
test('adapter errors do not expose secrets or stack traces', async () => {
  const broken = createApp(new DiscoveryService(new MockLLMProvider(), { async search() { throw new Error('secret-api-token') } })).listen(0, '127.0.0.1')
  await new Promise<void>(resolve => broken.once('listening', resolve))
  try {
    const address = broken.address()
    if (!address || typeof address === 'string') throw new Error('No listener')
    const response = await fetch('http://127.0.0.1:' + address.port + '/api/proposals/search', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"text":"art"}',
    })
    assert.equal(response.status, 500)
    assert.equal((await response.text()).includes('secret-api-token'), false)
  } finally { await new Promise<void>(resolve => broken.close(() => resolve())) }
})
