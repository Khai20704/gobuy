import assert from 'node:assert/strict'
import { test } from 'node:test'
import { rpcTransport, RpcUnavailable } from '../src/services/delivery/rpc.js'
import { publicMetadataUrl } from '../src/services/delivery/metadataUrl.js'

const call = (method: string, id = 1) => ({ method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id, method, params: ['wallet'] }) })
test('RPC honors Retry-After, then recovers; JSON rate limits use exponential backoff', async () => {
  let calls = 0
  const delays: number[] = []
  const rpc = rpcTransport({ random: () => 0, sleep: async ms => { delays.push(ms) }, fetch: async () => {
    calls++
    if (calls === 1) return new Response('', { status: 429, headers: { 'Retry-After': '3' } })
    if (calls === 2) return Response.json({ error: { code: 429 } })
    return Response.json({ result: 42 })
  } })
  assert.equal((await (await rpc('https://rpc.example', call('getBalance'))).json()).result, 42)
  assert.deepEqual(delays, [3000, 4000])
})
test('RPC bounded retries sanitize errors and permanent failures are not retried', async () => {
  let count = 0
  const rpc = rpcTransport({ sleep: async () => {}, fetch: async () => { count++; return new Response('secret endpoint', { status: 429 }) } })
  await assert.rejects(rpc('https://rpc.example', call('getBalance')), (e: unknown) => e instanceof RpcUnavailable && e.message === 'RPC_RATE_LIMIT')
  assert.equal(count, 5)
  count = 0
  const permanent = rpcTransport({ fetch: async () => { count++; return new Response('denied', { status: 403 }) } })
  assert.equal((await permanent('https://rpc.example', call('getBalance'))).status, 403)
  assert.equal(count, 1)
})
test('RPC deduplicates reads with distinct IDs, limits concurrency and never caches submission or funds reads', async () => {
  let active = 0, max = 0, count = 0
  const rpc = rpcTransport({ concurrency: 2, fetch: async () => {
    count++; active++; max = Math.max(max, active)
    await new Promise(resolve => setTimeout(resolve, 5)); active--
    return Response.json({ id: 1, result: 3 })
  } })
  const results = await Promise.all([rpc('https://rpc.example', call('getBalance', 1)), rpc('https://rpc.example', call('getBalance', 2))])
  assert.equal(count, 1)
  assert.equal((await results[1].json()).id, 2)
  await rpc('https://rpc.example', call('getBalance'))
  assert.equal(count, 2)
  await Promise.all(Array.from({ length: 6 }, (_, i) => rpc('https://rpc.example', call('sendTransaction', i))))
  assert.equal(count, 8); assert.equal(max, 2)
})
test('demo metadata rejects localhost and missing images', () => {
  assert.throws(() => publicMetadataUrl('id', 'https://images.example/nft.png', 'http://localhost:3001'), /metadata/)
  assert.throws(() => publicMetadataUrl('id', undefined, 'https://app.example'), /metadata/)
  assert.equal(publicMetadataUrl('id', 'https://images.example/nft.png', 'https://app.example'), 'https://app.example/api/acquisition/delivery-metadata/id')
})
