import { NFTPurchaseError } from './nft/errors.js'
import { AutonomousSpendBlockedError } from './services/acquisition/AutonomousSpendBlockedError.js'
import { createAccounts } from './auth/accounts.js'
import { ExtensionSessions, extensionRoutes } from './http/extensionSessions.js'
import express, { type ErrorRequestHandler } from 'express'
import { MockLLMProvider } from './adapters/llm/LLMProvider.js'
import { MockMarketplaceAdapter } from './adapters/marketplace/MockMarketplaceAdapter.js'
import { DiscoveryService } from './application/DiscoveryService.js'
import { proposalRoutes } from './http/routes/proposals.js'
import { InputError } from './schemas/search.js'
import { createResearchService } from './application/createResearchService.js'
import { researchRoutes } from './http/routes/research.js'
import { env } from './config/env.js'
import { nftDemoRoutes } from './http/routes/nftDemo.js'
import { acquisitionRoutes } from './http/routes/acquisition.js'
import { publicDemoMetadataRoutes } from './http/routes/publicDemoMetadata.js'
import { LLMUnavailableError, LLMContextError, LLMRefusalError } from './ai/errors/classifyProviderError.js'
import { MongoUnavailableError } from './persistence/mongo.js'
import { mandateRoutes } from './http/routes/mandate.js'
import { nftPurchaseRoutes } from './http/routes/nftPurchase.js'
import { investmentRoutes } from './http/routes/investment.js'

export function createApp(service = new DiscoveryService(new MockLLMProvider(), new MockMarketplaceAdapter()), research = createResearchService(), accounts = createAccounts()) {
  const app = express()
  app.disable('x-powered-by')
  app.use((_request, response, next) => {
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('X-Content-Type-Options', 'nosniff')
    next()
  })
  // Cross-origin access is granted only to the exact origins listed in APP_ORIGINS. Never '*':
  // these responses carry Authorization-authenticated data and must not be readable elsewhere.
  // Requests without an Origin header (curl, server-to-server, same-origin) are untouched, and
  // the per-route origin checks still run afterwards.
  app.use((request, response, next) => {
    const origin = request.get('origin')
    if (origin && env.APP_ORIGINS.includes(origin)) {
      response.setHeader('Access-Control-Allow-Origin', origin)
      response.vary('Origin')
      response.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS')
      response.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization')
    }
    if (request.method === 'OPTIONS') { response.sendStatus(204); return }
    next()
  })
  app.use(express.json({ limit: '3mb', strict: true }))
  app.get('/api/health', (_request, response) => response.json({ status: 'ok', mode: 'demo', cluster: 'devnet' }))
  app.use('/api/account', accounts.router)
  app.use('/api/acquisition', publicDemoMetadataRoutes())
  app.use('/api/acquisition', acquisitionRoutes(accounts.requireAuthenticated, accounts.requireReady, env.APP_ORIGINS))
  app.use('/api/mandate', mandateRoutes(accounts.requireAuthenticated, env.APP_ORIGINS))
  // Genuine original-NFT purchases. Separate from the DEMO delivery route on purpose: nothing here
  // mints a GoBuy DEMO NFT, and the purchase endpoint stays inert until explicitly enabled.
  app.use('/api/nft-purchases', nftPurchaseRoutes(accounts.requireAuthenticated, env.APP_ORIGINS))
  app.use('/api/investment', investmentRoutes(accounts.requireAuthenticated, env.APP_ORIGINS))
  app.use('/api/nft-demo', nftDemoRoutes(undefined, env.APP_ORIGINS, accounts.requireReady))
  app.use('/api/proposals', proposalRoutes(service))
  const extensionSessions = new ExtensionSessions()
  app.use('/api/extension', extensionRoutes(research, extensionSessions))
  app.use('/api/research', researchRoutes(research, env.APP_ORIGINS, extensionSessions))
  app.use((_request, response) => response.status(404).json({ error: { code: 'NOT_FOUND', message: 'Endpoint not found.' } }))
  const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
    if (error instanceof AutonomousSpendBlockedError) {
      response.status(400).json({ error: { code: 'AUTONOMOUS_SPEND_BLOCKED', executionStarted: false, message: error.message } }); return
    }
    if (error instanceof MongoUnavailableError || error instanceof Error && /^Mongo(?:ServerSelection|Network|NetworkTimeout)/.test(error.name)) {
      console.error(`[API] MongoDB operation failed (${error.name}).`)
      response.status(503).json({ error: { code: 'DATABASE_UNAVAILABLE', message: 'Cơ sở dữ liệu tạm thời chưa kết nối được. Yêu cầu chưa hoàn tất; vui lòng thử lại.' } })
      return
    }
    if (error instanceof LLMUnavailableError || error instanceof LLMContextError || error instanceof LLMRefusalError) {
      response.status(error instanceof LLMUnavailableError ? 503 : 422).json({ error: { code: error.code, retryable: error.retryable, message: error.message } })
      return
    }
    if (error instanceof NFTPurchaseError) { response.status(409).json({ error: { code: error.code, message: error.message } }); return }
    const status = error.type === 'entity.too.large' ? 413
      : error instanceof InputError || error.type === 'entity.parse.failed' ? 400
      : error.status === 415 ? 415 : 500
    if (status === 500) console.error('[API] Unhandled request error:', JSON.stringify({
      method: _request.method,
      path: _request.originalUrl.split('?')[0],
      error: error instanceof Error ? error.name : 'Unknown error',
      // This known static message is safe; arbitrary provider errors may contain credentials.
      ...(error instanceof Error && error.message === 'NA_PROGRAM_ID is not a valid Solana address.'
        ? { reason: 'NA_PROGRAM_ID_INVALID' } : {}),
    }))
    response.status(status).json({ error: {
      code: status === 413 ? 'REQUEST_TOO_LARGE' : status === 500 ? 'INTERNAL_ERROR' : 'INVALID_REQUEST',
      message: status === 413 ? 'Request exceeds 3 MiB.'
        : error instanceof InputError ? error.message
        : status === 500 ? 'Unable to complete this request.' : 'Invalid JSON request.',
    } })
  }
  app.use(errorHandler)
  return app
}
