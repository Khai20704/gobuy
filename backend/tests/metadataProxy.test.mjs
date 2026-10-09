import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { metadataProxy } from '../scripts/metadata-proxy.mjs'

test('metadata proxy rejects sensitive routes, methods, queries and encoded paths before upstream', async t => {
  let calls = 0
  const upstream = createServer((_req, res) => { calls++; res.setHeader('Content-Type', 'image/svg+xml'); res.end('<svg/>') })
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const proxy = metadataProxy(`http://127.0.0.1:${upstream.address().port}`)
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve))
  t.after(async () => { await Promise.all([proxy, upstream].map(server => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }))) })
  const base = `http://127.0.0.1:${proxy.address().port}`
  for (const path of ['/api/account/me', '/api/acquisition/autonomous-spend', '/api/acquisition/autonomous-spends/id/demo-recovery', '/api/mandate/submit', '/api/acquisition/demo-nft-image.svg?x=1', '/api/acquisition/%64emo-nft-image.svg']) {
    assert.equal((await fetch(base + path)).status, 404)
  }
  for (const method of ['POST', 'PUT', 'DELETE', 'HEAD', 'OPTIONS']) assert.equal((await fetch(base + '/api/acquisition/demo-nft-image.svg', { method })).status, 404)
  assert.equal(calls, 0)
  assert.equal((await fetch(base + '/api/acquisition/demo-nft-image.svg')).status, 200)
  assert.equal(calls, 1)
})
