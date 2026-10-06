import { Router, type RequestHandler } from 'express'
import { z } from 'zod'
import { walletAddressSchema } from '@gobuy/shared'
import { InputError } from '../../schemas/search.js'
import { originGuard } from '../originGuard.js'
import { AcquisitionService } from '../../services/acquisition/AcquisitionService.js'
import { DiscoveryEngine, NFTIntentParser, acquisitionConfig } from '../../services/acquisition/discovery.js'
import { nftProviders } from '../../services/acquisition/providers.js'
import { createLLMRouter } from '../../ai/createLLMRouter.js'
import { createNaRequestStore } from '../../persistence/NaRequestStore.js'
import { NFTRankingService } from '../../services/nft-intelligence/NFTRankingService.js'
import { NaChatService } from '../../services/acquisition/NaChatService.js'
import { TensorAwareExecutionEngine } from '../../services/acquisition/TensorDevnetExecutor.js'
import { agentKeypair } from '../../services/mandate/agentKeypair.js'
import { describeMandate, mandateProgramId, requiredMandateGuard, serializeMandate } from '../../services/mandate/MandateGuard.js'

export function acquisitionRoutes(authenticate: RequestHandler, requireReady: RequestHandler, origins: string[], injected?: AcquisitionService) {
  const config = acquisitionConfig()
  // Lazy creation avoids startup calls to marketplace/LLMs.
  let instance = injected
  const service = () => {
    if (!instance) {
      const llm = createLLMRouter()
      instance = new AcquisitionService(new DiscoveryEngine(nftProviders(), config.NFT_PROVIDER_TIMEOUT_MS), new NFTIntentParser(llm),
        undefined, new TensorAwareExecutionEngine(), undefined, undefined, undefined, undefined, undefined, new NFTRankingService(undefined, llm),
        undefined, new NaChatService(llm))
    }
    return instance
  }
  const history = createNaRequestStore(), router = Router()
  router.get('/metadata/:id', async (req, res) => {
    if (!/^[a-f0-9]{64}$/.test(req.params.id)) { res.sendStatus(404); return }
    const metadata = await service().publicMetadata(req.params.id)
    if (!metadata) { res.sendStatus(404); return }
    res.json(metadata)
  })
  // A cross-site request is normal here: the deployed frontend lives on a different domain, so
  // Origin decides, never Sec-Fetch-Site.
  router.use(originGuard(origins, response => response.status(403).json({ error: { message: 'Mở GoBuy từ địa chỉ ứng dụng đã cấu hình.' } })))
  router.use(authenticate)
  router.get('/config', (_req, res) => {
    const programId = mandateProgramId()
    res.json({ discoveryMode: config.NFT_DISCOVERY_MODE, discoveryNetwork: config.DISCOVERY_NETWORK,
      executionNetwork: 'devnet', simulated: config.NFT_DISCOVERY_MODE === 'mock',
      marketplaceProvider: config.NFT_MARKETPLACE_PROVIDER, assetProvider: config.NFT_ASSET_PROVIDER,
      heliusConfigured: config.heliusConfigured, tensorMarketplace: config.NFT_DISCOVERY_MODE === 'marketplace', autonomousSigning: Boolean(programId && agentKeypair()),
      purchaseExecution: 'Devnet autonomous spend demo',
      // Na may spend from the vault without the owner's key; a marketplace purchase still needs one.
      autonomousExecution: { mode: 'onchain_vault', ready: Boolean(programId && agentKeypair()), programId: programId?.toBase58() ?? null,
        blockers: programId ? [] : ['VAULT_NOT_DEPLOYED'], marketplaceExecution: 'wallet_signature_required' },
      embeddedWallet: 'pending', mainnetExecution: false })
  })
  // Read-only view of the owner's on-chain mandate so Na can speak about its own budget.
  router.get('/mandate', async (req, res) => {
    const input = z.object({ owner: walletAddressSchema }).strict().safeParse(req.query)
    if (!input.success) throw new InputError('Địa chỉ ví không hợp lệ.')
    const mandate = await requiredMandateGuard().snapshot(input.data.owner)
    res.json({ description: describeMandate(mandate), mandate: serializeMandate(mandate) })
  })
  router.get('/wallets', async (_req, res) => res.json(await service().wallets.list(res.locals.identity.uid)))
  router.post('/wallets/challenge', async (req, res) => {
    const input = z.object({ address: walletAddressSchema }).strict().safeParse(req.body)
    if (!input.success) throw new InputError('Địa chỉ ví không hợp lệ.')
    res.json(await service().wallets.challenge(res.locals.identity.uid, input.data.address))
  })
  router.post('/wallets/verify', async (req, res) => {
    const input = z.object({ id: z.uuid(), signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/) }).strict().safeParse(req.body)
    if (!input.success) throw new InputError('Chữ ký xác minh không hợp lệ.')
    res.json(await service().wallets.verify(res.locals.identity.uid, input.data.id, input.data.signature))
  })
  router.get('/portfolio', async (_req, res) => res.json(await service().portfolio.list(res.locals.identity.uid)))
  router.post('/requests', async (req, res) => {
    const input = z.object({ id: z.uuid(), prompt: z.string().trim().min(1).max(2000), response: z.string().trim().min(1).max(500) }).strict().safeParse(req.body)
    if (!input.success) throw new InputError('Yêu cầu lưu lịch sử không hợp lệ.')
    const uid = res.locals.identity.uid as string
    await history.create(uid, input.data.id, input.data.prompt)
    await history.update(uid, input.data.id, { status: 'NEEDS_INPUT', response: input.data.response })
    res.sendStatus(204)
  })
  router.post('/discover', async (req, res) => {
    const input = z.object({ id: z.uuid(), text: z.string().trim().min(1).max(2000), prompt: z.string().trim().min(1).max(2000).optional(),
      conversationId: z.uuid().optional(), owner: walletAddressSchema.optional() }).strict().safeParse(req.body)
    if (!input.success) throw new InputError('Yêu cầu tìm NFT không hợp lệ.')
    const uid = res.locals.identity.uid as string
    await history.create(uid, input.data.id, input.data.prompt ?? input.data.text)
    try {
      const reply = await service().discover(uid, input.data.text, input.data.id, input.data.conversationId, input.data.owner)
      await history.update(uid, input.data.id, { status: reply.status === 'DATA_UNAVAILABLE' ? 'FAILED'
        : reply.status === 'NO_MATCH' ? 'NO_MATCH' : reply.candidates.length ? 'NEEDS_INPUT' : 'FAILED', response: reply.message })
      res.json(reply)
    } catch (error) {
      await history.update(uid, input.data.id, { status: 'FAILED', response: error instanceof InputError ? error.message : 'Không tìm được dữ liệu marketplace. Thử lại sau.' })
      throw error
    }
  })
  router.post('/chat', async (req, res) => {
    const input = z.object({ text: z.string().trim().min(1).max(2000), conversationId: z.uuid().optional() }).strict().safeParse(req.body)
    if (!input.success) throw new InputError('Câu hỏi không hợp lệ.')
    res.json(await service().chat(res.locals.identity.uid, input.data.text, input.data.conversationId))
  })
  router.post('/quote', requireReady, async (req, res) => {
    const input = z.object({ discoveryId: z.uuid(), candidateId: z.string().min(1).max(150), owner: walletAddressSchema }).strict().safeParse(req.body)
    if (!input.success) throw new InputError('Yêu cầu báo giá không hợp lệ.')
    const result = await service().prepare(res.locals.identity.uid, input.data.discoveryId, input.data.candidateId, input.data.owner)
    await history.update(res.locals.identity.uid, input.data.discoveryId, { status: result.status === 'READY' ? 'QUOTED' : result.status,
      response: result.message, ...(result.status === 'READY' ? { orderId: result.quote.id, title: result.quote.title } : {}) })
    res.json(result)
  })
  router.post('/autonomous-spend', requireReady, async (req, res) => {
    const input = z.object({ discoveryId: z.uuid(), candidateId: z.string().min(1).max(150), owner: walletAddressSchema }).strict().safeParse(req.body)
    if (!input.success) throw new InputError('Invalid autonomous spend request.')
    const uid = res.locals.identity.uid as string
    const reply = await service().autonomousPurchase(uid, input.data.discoveryId, input.data.candidateId, input.data.owner)
    await history.update(uid, reply.id, { status: reply.result.status === 'NOT_SUBMITTED' ? 'FAILED' : reply.result.status === 'RECONCILIATION_ERROR' ? 'PENDING' : reply.result.status, response: reply.result.message,
      ...(reply.result.signature ? { signature: reply.result.signature } : {}) })
    res.json(reply)
  })
  router.get('/autonomous-spends/:id', async (req, res) => {
    if (!z.uuid().safeParse(req.params.id).success) throw new InputError('Invalid autonomous spend ID.')
    const uid = res.locals.identity.uid as string
    const query = z.object({ owner: walletAddressSchema.optional() }).strict().safeParse(req.query)
    if (!query.success) throw new InputError('Invalid reconciliation owner.')
    const reply = await service().reconcilePurchase(uid, req.params.id, query.data.owner)
    await history.update(uid, reply.id, { status: reply.status === 'RECONCILIATION_ERROR' ? 'PENDING' : reply.status === 'NOT_SUBMITTED' ? 'FAILED' : reply.status, response: reply.message,
      ...(reply.purchase?.result.signature ? { signature: reply.purchase.result.signature } : {}) })
    res.json(reply)
  })
  router.post('/submit', requireReady, async (req, res) => {
    const input = z.object({ id: z.uuid(), transaction: z.string().min(1).max(5000) }).strict().safeParse(req.body)
    if (!input.success) throw new InputError('Giao dịch không hợp lệ.')
    const receipt = await service().submit(res.locals.identity.uid, input.data.id, input.data.transaction)
    await history.update(res.locals.identity.uid, input.data.id, { status: receipt.status, response: receipt.message, ...(receipt.signature ? { signature: receipt.signature } : {}) })
    res.json(receipt)
  })
  router.get('/orders/:id', async (req, res) => {
    if (!z.uuid().safeParse(req.params.id).success) throw new InputError('Mã giao dịch không hợp lệ.')
    const receipt = await service().status(res.locals.identity.uid, req.params.id)
    await history.update(res.locals.identity.uid, req.params.id, { status: receipt.status, response: receipt.message, ...(receipt.signature ? { signature: receipt.signature } : {}) })
    res.json(receipt)
  })
  return router
}
