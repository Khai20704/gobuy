import { Router, type RequestHandler } from 'express'
import { z } from 'zod'
import { InputError } from '../../schemas/search.js'
import { originGuard } from '../originGuard.js'
import { NftDemoService } from '../../services/nftDemo/NftDemoService.js'
import { artSvg, demoArt } from '../../services/nftDemo/catalog.js'
import { createNaRequestStore, type NaRequestStatus, type NaRequestStore } from '../../persistence/NaRequestStore.js'

export function nftDemoRoutes(service = new NftDemoService(), origins: string[] = [], requireAccount: RequestHandler = (_req, res) => { res.status(401).json({ error: { message: 'Login required' } }) },
  requests: NaRequestStore = createNaRequestStore()) {
  const router = Router()
  router.get('/art/:id', (req, res) => {
    const art = demoArt.find(a => a.id === req.params.id)
    if (!art) { res.sendStatus(404); return }
    res.type('image/svg+xml').send(artSvg(art))
  })
  router.get('/metadata/:id', (req, res) => {
    const art = demoArt.find(a => a.id === req.params.id)
    if (!art) { res.sendStatus(404); return }
    const base = (process.env.NFT_DEMO_PUBLIC_URL || 'http://localhost:3001').replace(/\/$/, '')
    res.json({ name: `Na Demo - ${art.name}`, description: 'Demo artwork minted on purchase on Solana devnet. No mainnet value.',
      image: `${base}/api/nft-demo/art/${art.id}`, attributes: [{ trait_type: 'Network', value: 'Devnet' }],
      properties: { category: 'image', files: [{ uri: `${base}/api/nft-demo/art/${art.id}`, type: 'image/svg+xml' }] } })
  })
  // A cross-site request is normal here: the deployed frontend lives on a different domain, so
  // Origin decides, never Sec-Fetch-Site.
  router.use(originGuard(origins, response => response.status(403).json({ error: { message: 'Open Na from the configured app origin.' } })))
  router.use(requireAccount)
  router.get('/requests', async (_req, res) => {
    res.json(await requests.list(res.locals.identity.uid))
  })
  router.post('/chat', async (req, res) => {
    if (service instanceof NftDemoService && process.env.NFT_DISCOVERY_MODE !== 'mock') {
      res.json({ status: 'NEEDS_INPUT', message: 'Na đã chuyển sang tìm NFT trên marketplace. Hãy tải lại trang để dùng luồng tìm kiếm mới.' }); return
    }
    const input = z.object({
      id: z.uuid(),
      text: z.string().trim().min(1).max(2000),
      prompt: z.string().trim().min(1).max(2000).optional(),
      owner: z.string().max(44).default(''),
    }).safeParse(req.body)
    if (!input.success) throw new InputError('Yêu cầu mua không hợp lệ.')
    const userId = res.locals.identity.uid as string
    const prompt = input.data.prompt ?? input.data.text
    await requests.create(userId, input.data.id, prompt)
    try {
      const result = await service.prepare(input.data.id, input.data.text, input.data.owner, userId)
      const status: NaRequestStatus = result.status === 'READY' ? 'QUOTED' : result.status
      await requests.update(userId, input.data.id, {
        status,
        response: result.message,
        ...(result.status === 'READY' ? { orderId: result.quote.id, title: result.quote.title } : {}),
      })
      res.json(result)
    } catch (error) {
      await requests.update(userId, input.data.id, {
        status: 'FAILED',
        response: error instanceof Error ? error.message : 'Không hoàn tất được yêu cầu.',
      })
      throw error
    }
  })
  router.post('/submit', async (req, res) => {
    const input = z.object({ id: z.uuid(), transaction: z.string().min(1).max(5000) }).safeParse(req.body)
    if (!input.success) throw new InputError('Giao dịch không hợp lệ.')
    const userId = res.locals.identity.uid as string
    const receipt = await service.submit(input.data.id, input.data.transaction, userId)
    const status = receipt.status === 'NOT_SUBMITTED' ? 'NOT_SUBMITTED'
      : receipt.status === 'CONFIRMED' ? 'CONFIRMED'
      : receipt.status === 'FAILED' ? 'FAILED' : 'PENDING'
    await requests.update(userId, input.data.id, {
      status, response: receipt.message, ...(receipt.signature ? { signature: receipt.signature } : {}),
    })
    res.json(receipt)
  })
  router.get('/orders/:id', async (req, res) => {
    if (!z.uuid().safeParse(req.params.id).success) throw new InputError('Mã yêu cầu không hợp lệ.')
    const userId = res.locals.identity.uid as string
    const receipt = await service.status(req.params.id, userId)
    const status = receipt.status === 'NOT_SUBMITTED' ? 'NOT_SUBMITTED'
      : receipt.status === 'CONFIRMED' ? 'CONFIRMED'
      : receipt.status === 'FAILED' ? 'FAILED' : 'PENDING'
    await requests.update(userId, req.params.id, {
      status, response: receipt.message, ...(receipt.signature ? { signature: receipt.signature } : {}),
    })
    res.json(receipt)
  })
  return router
}
