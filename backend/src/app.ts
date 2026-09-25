import express, { type ErrorRequestHandler } from 'express'
import { MockLLMProvider } from './adapters/llm/LLMProvider.js'
import { MockMarketplaceAdapter } from './adapters/marketplace/MockMarketplaceAdapter.js'
import { DiscoveryService } from './application/DiscoveryService.js'
import { proposalRoutes } from './http/routes/proposals.js'
import { InputError } from './schemas/search.js'

export function createApp(service = new DiscoveryService(new MockLLMProvider(), new MockMarketplaceAdapter())) {
  const app = express()
  app.disable('x-powered-by')
  app.use((_request, response, next) => {
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('X-Content-Type-Options', 'nosniff')
    next()
  })
  app.use(express.json({ limit: '3mb', strict: true }))
  app.get('/api/health', (_request, response) => response.json({ status: 'ok', mode: 'demo', cluster: 'devnet' }))
  app.use('/api/proposals', proposalRoutes(service))
  app.use((_request, response) => response.status(404).json({ error: { code: 'NOT_FOUND', message: 'Endpoint not found.' } }))
  const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
    const status = error.type === 'entity.too.large' ? 413
      : error instanceof InputError || error.type === 'entity.parse.failed' ? 400
      : error.status === 415 ? 415 : 500
    response.status(status).json({ error: {
      code: status === 413 ? 'REQUEST_TOO_LARGE' : status === 500 ? 'INTERNAL_ERROR' : 'INVALID_REQUEST',
      message: status === 413 ? 'Request exceeds 3 MiB.'
        : error instanceof InputError ? error.message
        : status === 500 ? 'Unable to prepare proposals.' : 'Invalid JSON request.',
    } })
  }
  app.use(errorHandler)
  return app
}
