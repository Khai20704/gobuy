import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import type { Server } from 'node:http'
import { createApp } from '../src/app.ts'
import { NaResearchService } from '../src/application/NaResearchService.ts'
import { IntentExtractor } from '../src/services/ai/intentExtractor.ts'
import { SearchAggregator } from '../src/services/search/SearchAggregator.ts'
import { MockSneakerProvider } from '../src/services/search/MockSneakerProvider.ts'
import { MemoryTwinStore } from '../src/services/twin/TwinStore.ts'
import { env } from '../src/config/env.ts'

// The production frontend is served from its own domain, so every browser call already carries
// `Sec-Fetch-Site: cross-site`. Only `Origin` may decide whether the request continues.
const allowed = env.APP_ORIGINS[0]
const hostile = 'https://evil.example'
const crossSite = { 'Sec-Fetch-Site': 'cross-site' }
const guarded = ['/api/acquisition/config', '/api/mandate/config', '/api/investment/config', '/api/nft-demo/requests']
const research = () => new NaResearchService(new IntentExtractor(), new SearchAggregator([new MockSneakerProvider()]), new MemoryTwinStore(), { mode: 'mock' })
const searchBody = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Find Jordan 1 under 200 USD' }) }

let server: Server
let base: string
before(async () => {
  server = createApp(undefined, research()).listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No listener')
  base = 'http://127.0.0.1:' + address.port
})
after(() => new Promise<void>(resolve => server.close(() => resolve())))

test('an allowlisted origin passes the guard and reaches authentication', async () => {
  for (const path of guarded) {
    const response = await fetch(base + path, { headers: { Origin: allowed, ...crossSite } })
    assert.equal(response.status, 401, `${path} must be allowed through the origin guard`)
  }
})

test('an origin outside APP_ORIGINS is still rejected with 403', async () => {
  for (const path of guarded) {
    const response = await fetch(base + path, { headers: { Origin: hostile, ...crossSite } })
    assert.equal(response.status, 403, `${path} must reject an unlisted origin`)
  }
})

test('research accepts the allowlisted cross-site origin and denies an unlisted one', async () => {
  const permitted = await fetch(base + '/api/research/search', { ...searchBody, headers: { Origin: allowed, ...crossSite, ...searchBody.headers } })
  assert.equal(permitted.status, 200)
  const denied = await fetch(base + '/api/research/search', { ...searchBody, headers: { Origin: hostile, ...crossSite, ...searchBody.headers } })
  assert.equal(denied.status, 403)
})

test('requests without an Origin header keep working', async () => {
  const response = await fetch(base + '/api/research/search', searchBody)
  assert.equal(response.status, 200)
  for (const path of guarded) assert.equal((await fetch(base + path)).status, 401, `${path} must not require an Origin`)
})
