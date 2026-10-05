import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadAccountProfile, readAccountResponse } from '../src/features/account/response.ts'

test('account responses explain empty proxy failures and invalid success bodies', async () => {
  for (const response of [new Response('', { status: 500 }), new Response('<html>Bad gateway</html>', { status: 502 }), Response.json(null), Response.json({})]) {
    await assert.rejects(readAccountResponse(response), new RegExp(`HTTP ${response.status}`))
  }
})

test('account responses preserve API errors and validate returned profiles', async () => {
  await assert.rejects(readAccountResponse(Response.json({ error: { message: 'Verify phone first' } }, { status: 403 })), /Verify phone first/)
  const profile = { uid: 'test', email: null, phone: null, address: null, ready: false }
  assert.deepEqual(await readAccountResponse(Response.json(profile)), profile)
})

test('profile loading recovers from a backend restart without another login', async () => {
  const profile = { uid: 'test', email: null, phone: null, address: null, ready: false }
  let calls = 0
  const delays: number[] = []
  const loaded = await loadAccountProfile(async () => {
    calls++
    if (calls === 1) throw new TypeError('Failed to fetch')
    return calls === 2 ? new Response('', { status: 500 }) : Response.json(profile)
  }, () => true, async ms => { delays.push(ms) })
  assert.deepEqual(loaded, profile)
  assert.deepEqual(delays, [1000, 2000])
  assert.equal(calls, 3)
})

test('profile retries are bounded and preserve the final backend error', async () => {
  let calls = 0
  await assert.rejects(loadAccountProfile(async () => {
    calls++
    return Response.json({ error: { message: 'Backend unavailable' } }, { status: 503 })
  }, () => true, async () => {}), /Backend unavailable/)
  assert.equal(calls, 4)
})

test('profile loading does not retry authentication errors or a superseded account', async () => {
  let calls = 0
  await assert.rejects(loadAccountProfile(async () => {
    calls++
    return Response.json({ error: { message: 'Login required' } }, { status: 401 })
  }, () => true, async () => {}), /Login required/)
  assert.equal(calls, 1)
  let current = true
  await assert.rejects(loadAccountProfile(async () => {
    calls++
    return new Response('', { status: 503 })
  }, () => current, async () => { current = false }), /superseded/)
  assert.equal(calls, 2)
})
