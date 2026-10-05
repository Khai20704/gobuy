import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express, { type RequestHandler } from 'express'
import { test } from 'node:test'
import type { NftDemoService } from '../src/services/nftDemo/NftDemoService.js'
import { FileNaRequestStore } from '../src/persistence/NaRequestStore.js'
import { nftDemoRoutes } from '../src/http/routes/nftDemo.js'

test('Na chat requests are persisted and returned only to their signed-in owner', async () => {
  const store = new FileNaRequestStore(await mkdtemp(join(tmpdir(), 'na-requests-')))
  const preparedTexts: string[] = []
  const service = {
    async prepare(_id: string, text: string) {
      preparedTexts.push(text)
      return { status: 'NEEDS_INPUT' as const, message: `Add a budget for: ${text}` }
    },
  } as unknown as NftDemoService
  const identity: RequestHandler = (request, response, next) => {
    response.locals.identity = { uid: request.get('x-test-user') || 'alice' }
    next()
  }
  const app = express()
  app.use(express.json())
  app.use('/nft-demo', nftDemoRoutes(service, [], identity, store))
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Test server did not bind.')
  const base = `http://127.0.0.1:${address.port}/nft-demo`
  const id = crypto.randomUUID()
  try {
    const response = await fetch(`${base}/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, text: 'Mua tranh NFT về rừng', owner: '' }),
    })
    assert.equal(response.status, 200)
    assert.match((await response.json()).message, /Add a budget/)
    const followupId = crypto.randomUUID()
    const followup = await fetch(`${base}/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: followupId,
        text: 'Mua tranh NFT về rừng dưới 1 SOL',
        prompt: 'dưới 1 SOL',
        owner: '',
      }),
    })
    assert.equal(followup.status, 200)
    assert.equal(preparedTexts[1], 'Mua tranh NFT về rừng dưới 1 SOL')
    const ownHistory = await fetch(`${base}/requests`)
    assert.equal(ownHistory.status, 200)
    const rows = await ownHistory.json()
    assert.equal(rows.length, 2)
    const original = rows.find((row: { id: string }) => row.id === id)
    const reply = rows.find((row: { id: string }) => row.id === followupId)
    assert.equal(original.prompt, 'Mua tranh NFT về rừng')
    assert.equal(original.status, 'NEEDS_INPUT')
    assert.equal(reply.prompt, 'dưới 1 SOL')
    assert.equal(reply.status, 'NEEDS_INPUT')
    const otherHistory = await fetch(`${base}/requests`, { headers: { 'x-test-user': 'bob' } })
    assert.deepEqual(await otherHistory.json(), [])
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})
