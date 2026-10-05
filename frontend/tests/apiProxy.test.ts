import assert from 'node:assert/strict'
import { createServer as createHttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import { createServer } from 'vite'
import { apiProxy } from '../dev/apiProxy.ts'

test('development proxy returns JSON 503 while backend is down and recovers when it starts', async () => {
  const backend = createHttpServer((_request, response) => {
    response.writeHead(401, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ error: { message: 'Login required' } }))
  })
  await new Promise<void>(resolve => backend.listen(0, '127.0.0.1', resolve))
  const port = (backend.address() as AddressInfo).port
  await new Promise<void>((resolve, reject) => backend.close(error => error ? reject(error) : resolve()))
  const vite = await createServer({ configFile: false, logLevel: 'silent',
    server: { host: '127.0.0.1', port: 0, hmr: false, proxy: { '/api': apiProxy(`http://127.0.0.1:${port}`) } },
    optimizeDeps: { noDiscovery: true, include: [] },
  })
  const originalError = console.error
  let proxyLog = ''
  try {
    await vite.listen()
    const address = vite.httpServer!.address() as AddressInfo
    const endpoint = `http://127.0.0.1:${address.port}/api/account/me`
    console.error = message => { proxyLog = String(message) }
    const failed = await fetch(endpoint)
    console.error = originalError
    assert.equal(failed.status, 503)
    assert.match(failed.headers.get('content-type')!, /application\/json/)
    assert.equal((await failed.json()).error.code, 'API_UNAVAILABLE')
    assert.match(proxyLog, /Backend request failed \(ECONNREFUSED\)/)
    await new Promise<void>(resolve => backend.listen(port, '127.0.0.1', resolve))
    const recovered = await fetch(endpoint)
    assert.equal(recovered.status, 401)
    assert.equal((await recovered.json()).error.message, 'Login required')
  } finally {
    console.error = originalError
    await vite.close()
    if (backend.listening) await new Promise<void>((resolve, reject) => backend.close(error => error ? reject(error) : resolve()))
  }
})
