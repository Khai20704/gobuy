import assert from 'node:assert/strict'
import { test } from 'node:test'
import express from 'express'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createAccounts, FileProfileStore, type Identity } from '../src/auth/accounts.js'

test('server enforces identity, verified phone, address and per-account isolation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gobuy-accounts-'))
  const identities: Record<string, Identity> = {
    alice: { uid: 'alice', email: 'alice@example.com', phone: null },
    bob: { uid: 'bob', email: 'bob@example.com', phone: '+14155552671' },
  }
  const accounts = createAccounts({ async verify(token) { if (!identities[token]) throw new Error('invalid token'); return identities[token] } }, new FileProfileStore(directory))
  const app = express(); app.use(express.json()); app.use('/account', accounts.router)
  app.post('/buy', accounts.requireReady, (_req, res) => res.json({ ok: true }))
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No port')
  const base = `http://127.0.0.1:${address.port}`
  const call = (path: string, token?: string, body?: unknown, method = body ? 'PUT' : 'GET') => fetch(base + path, { method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined })
  const shipping = { recipient: 'Test User', country: 'VN', line1: '123 Test Street', line2: '', city: 'Da Nang', region: 'Da Nang', postalCode: '' }
  try {
    assert.equal((await call('/account/me')).status, 401)
    assert.equal((await call('/account/me', 'forged')).status, 401)
    assert.equal((await call('/buy', 'alice', undefined, 'POST')).status, 403)
    assert.equal((await call('/account/address', 'alice', shipping)).status, 403)
    assert.equal((await call('/account/address', 'alice', { ...shipping, phoneVerified: true })).status, 403)
    identities.alice.phone = '+84912345678'
    assert.equal((await call('/account/address', 'alice', { ...shipping, country: 'ZZ' })).status, 400)
    assert.equal((await call('/account/address', 'alice', { ...shipping, uid: 'bob' })).status, 400)
    assert.equal((await call('/account/address', 'alice', shipping)).status, 200)
    assert.equal((await (await call('/account/me', 'alice')).json()).ready, true)
    assert.equal((await (await call('/account/me', 'bob')).json()).address, null)
    assert.equal((await call('/buy', 'alice', undefined, 'POST')).status, 200)
    assert.deepEqual(await new FileProfileStore(directory).read('alice'), shipping)
    delete identities.alice
    assert.equal((await call('/buy', 'alice', undefined, 'POST')).status, 401)
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
})
