import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export function metadataProxy(upstream = 'http://127.0.0.1:3001') {
  return createServer(async (req, res) => {
    // Match raw paths: no decoding, redirects, queries or arbitrary forwarding.
    if (req.method !== 'GET' || !/^\/api\/acquisition\/(demo-nft-image\.svg|delivery-metadata\/[a-f0-9]{64})$/.test(req.url ?? '')) {
      res.writeHead(404); res.end(); return
    }
    try {
      const response = await fetch(upstream + req.url, { redirect: 'error', signal: AbortSignal.timeout(15000) })
      if (!response.ok) { res.writeHead(response.status); res.end(); return }
      const type = response.headers.get('content-type') ?? ''
      let body = Buffer.from(await response.arrayBuffer())
      if (req.url.includes('/delivery-metadata/')) {
        const metadata = JSON.parse(body.toString())
        // Reload only the public URL, so a running backend need not restart for the tunnel.
        const env = readFileSync(new URL('../.env', import.meta.url), 'utf8')
        const base = env.match(/^NFT_DEMO_PUBLIC_URL=(.+)$/m)?.[1].trim()
        if (!base || !/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(base)) throw Error('Tunnel URL not configured')
        metadata.image = base + '/api/acquisition/demo-nft-image.svg'
        if (metadata.symbol === 'DEMO-NFT') {
          const attributes = Array.isArray(metadata.attributes) ? metadata.attributes : []
          metadata.attributes = [...attributes.filter(item => item.trait_type !== 'Type'), { trait_type: 'Type', value: 'Demo / Simulated NFT' }]
        }
        body = Buffer.from(JSON.stringify(metadata))
      }
      res.writeHead(200, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
      res.end(body)
    } catch { res.writeHead(502); res.end('Metadata upstream unavailable') }
  })
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  metadataProxy().listen(3002, '127.0.0.1', () => console.log('Metadata-only proxy: 127.0.0.1:3002 -> 127.0.0.1:3001'))
}
