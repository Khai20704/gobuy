import type { ServerResponse } from 'node:http'
import type { ProxyOptions } from 'vite'

export function apiProxy(target: string): ProxyOptions {
  return {
    target,
    configure(proxy) {
      proxy.on('error', (error, _request, response) => {
        const code = 'code' in error && typeof error.code === 'string' ? error.code : 'UNKNOWN'
        console.error(`[API proxy] Backend request failed (${code}).`)
        // Vite's default proxy error is an empty HTTP 500, not an API response.
        if (!('writeHead' in response)) return
        const outgoing = response as ServerResponse
        if (outgoing.headersSent || outgoing.writableEnded || outgoing.destroyed) return
        outgoing.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        outgoing.end(JSON.stringify({ error: { code: 'API_UNAVAILABLE',
          message: 'Chưa kết nối được backend GoBuy. Máy chủ có thể đang khởi động lại. Vui lòng chờ rồi bấm Thử lại.',
        } }))
      })
    },
  }
}
