import assert from 'node:assert/strict'
import { test } from 'node:test'
import express from 'express'
import { publicDemoMetadataRoutes } from '../src/http/routes/publicDemoMetadata.js'
import { acquisitionRoutes } from '../src/http/routes/acquisition.js'
import { mandateRoutes } from '../src/http/routes/mandate.js'
import { createAccounts } from '../src/auth/accounts.js'
import { verifyPublicMetadata } from '../src/services/delivery/metadataUrl.js'

test('only public demo GET routes bypass real authentication; purchase/recovery/delivery/mandate stay protected', async t => {
  const previous = process.env.NFT_DEMO_PUBLIC_URL
  process.env.NFT_DEMO_PUBLIC_URL = 'https://demo.example.com'
  t.after(() => { if (previous === undefined) delete process.env.NFT_DEMO_PUBLIC_URL; else process.env.NFT_DEMO_PUBLIC_URL = previous })
  const app = express(), id = 'a'.repeat(64)
  const accounts = createAccounts({ verify: async () => { throw new Error('invalid token') } }, { read: async () => null, save: async () => {} })
  let core = false
  app.use('/api/acquisition', publicDemoMetadataRoutes(async key => key === id ? {
    ...(core ? { assetStandard: 'METAPLEX_CORE' } : {}),
    name: 'GoBuy Devnet Demo · Reference NFT', symbol: 'DEMO-NFT', image: 'https://original.example/art.png',
    attributes: [{ trait_type: 'Type', value: 'Demo / Simulated NFT' }],
  } : undefined))
  app.use('/api/acquisition', acquisitionRoutes(accounts.requireAuthenticated, accounts.requireReady, []))
  app.use('/api/mandate', mandateRoutes(accounts.requireAuthenticated, []))
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())))
  const address = server.address() as { port: number }, base = `http://127.0.0.1:${address.port}`
  const metadata = await fetch(base + '/api/acquisition/delivery-metadata/' + id)
  assert.equal(metadata.status, 200)
  const json = await metadata.json() as any
  assert.match(json.description, /Not the original marketplace NFT/)
  assert.equal(json.image, 'https://demo.example.com/api/acquisition/demo-nft-image.svg')
  await verifyPublicMetadata('https://demo.example.com/api/acquisition/delivery-metadata/' + id,
    { name: json.name, image: json.image }, (url, init) => fetch(String(url).replace('https://demo.example.com', base), init))
  const image = await fetch(base + '/api/acquisition/demo-nft-image.svg', { headers: { Origin: 'https://wallet.example' } })
  assert.equal(image.status, 200); assert.match(image.headers.get('content-type')!, /image\/svg\+xml/)
  assert.equal(image.headers.get('access-control-allow-origin'), '*')
  core = true
  const coreMetadata = await (await fetch(base + '/api/acquisition/delivery-metadata/' + id)).json() as any
  assert.equal(coreMetadata.image, 'https://original.example/art.png')
  assert.match(coreMetadata.description, /Not the original marketplace NFT/)
  for (const key of ['invalid', 'b'.repeat(64)]) assert.equal((await fetch(base + '/api/acquisition/delivery-metadata/' + key)).status, 404)
  for (const [method, path] of [
    ['POST', '/api/acquisition/demo-nft-image.svg'], ['POST', '/api/acquisition/delivery-metadata/' + id],
    ['HEAD', '/api/acquisition/demo-nft-image.svg'], ['POST', '/api/acquisition/autonomous-spend'],
    ['POST', '/api/acquisition/autonomous-spends/order/demo-consent'], ['POST', '/api/acquisition/autonomous-spends/order/demo-recovery'],
    ['GET', '/api/acquisition/deliveries'], ['GET', '/api/acquisition/portfolio'], ['POST', '/api/acquisition/submit'],
    ['GET', '/api/acquisition/mandate'], ['POST', '/api/mandate/transaction'], ['POST', '/api/mandate/submit'],
  ]) assert.equal((await fetch(base + path, { method })).status, 401, method + ' ' + path)
})

 test('Core rejects insecure and temporary metadata hosting', async () => {
  const { validateCoreUrls } = await import('../src/services/delivery/metadataUrl.js')
  assert.doesNotThrow(() => validateCoreUrls('https://assets.example/m.json', 'https://assets.example/demo.png'))
  for (const uri of ['http://assets.example/m.json', 'https://localhost/m.json', 'https://test.trycloudflare.com/m.json']) {
    assert.throws(() => validateCoreUrls(uri, 'https://assets.example/demo.png'))
    assert.throws(() => validateCoreUrls('https://assets.example/m.json', uri))
  }
 })
