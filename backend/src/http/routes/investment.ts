import { Router, type RequestHandler } from 'express'
import { z } from 'zod'
import { investmentPreferencesSchema, namedNFTQuery, remainingBudget, walletAddressSchema } from '@gobuy/shared'
import { InputError } from '../../schemas/search.js'
import { originGuard } from '../originGuard.js'
import { extractNamedCollectionQuery } from '../../services/acquisition/intentLanguage.js'
import { AssetResolver } from '../../services/rwa/AssetResolver.js'
import { classifyAssetIntent } from '../../services/rwa/classification.js'
import { RWARegistry } from '../../services/rwa/RWARegistry.js'
import { RWAService, type MandateView } from '../../services/rwa/RWAService.js'
import { requiredMandateClient } from '../../services/mandate/MandateProgramClient.js'
import { InvestmentTwinService } from '../../services/twin/InvestmentTwinService.js'
import { WalletAssociationService } from '../../services/acquisition/WalletAssociationService.js'
import { RWAChatSettlement } from '../../services/rwa/RWAChatSettlement.js'
import { executeVaultSpend } from '../../services/mandate/autonomousSpend.js'
import { createNaRequestStore } from '../../persistence/NaRequestStore.js'

/**
 * RWA and investment preferences.
 *
 * Routing is decided by the canonical `AssetResolver`, never by frontend keyword matching: the
 * frontend asks this API what an asset is. Identity comes from RWA_APPROVED_LIST (exact mint),
 * Jupiter supplies market data only, and the on-chain mandate stays the policy layer.
 */

export function investmentRoutes(authenticate: RequestHandler, origins: string[]) {
  const router = Router(), twin = new InvestmentTwinService()
  // Classification is advisory only. Execution services still reload current approvals.
  let classificationRegistry: { value: Promise<RWARegistry>; expires: number } | undefined
  const registryForClassification = () => {
    if (classificationRegistry && classificationRegistry.expires > Date.now()) return classificationRegistry.value
    const value = RWARegistry.configured()
    const entry = { value, expires: Number.POSITIVE_INFINITY }
    classificationRegistry = entry
    void value.then(() => { entry.expires = Date.now() + 30000 }, () => {
      if (classificationRegistry === entry) classificationRegistry = undefined
    })
    return value
  }

  /** Reads the owner's mandate for the policy re-check. Missing configuration is not an error here. */
  async function mandateOf(owner: string): Promise<MandateView | null> {
    try {
      const mandate = await requiredMandateClient().read(owner)
      if (!mandate) return null
      return { active: mandate.active, allowedCategory: mandate.allowedCategory,
        remainingLamports: remainingBudget(mandate.maxBudgetLamports, mandate.spentLamports) }
    } catch { return null }
  }
  /** Optional end-of-signature NFT evidence so the resolver never treats a collection as RWA. */
  const nftEvidence = (text: string) => !!extractNamedCollectionQuery(text) || !!namedNFTQuery(text)
  // Reload approvals for every request so revoked identities are not cached indefinitely.
  const service = async () => {
    const registry = await RWARegistry.configured()
    return new RWAService(registry, { mandate: mandateOf, resolver: new AssetResolver(registry, nftEvidence) })
  }
  const body = <T>(schema: z.ZodType<T>, raw: unknown): T => {
    const parsed = schema.safeParse(raw)
    if (!parsed.success) throw new InputError('Dữ liệu yêu cầu NFT/RWA không hợp lệ.')
    return parsed.data
  }
  const textBody = z.object({ text: z.string().trim().min(1).max(2000), owner: walletAddressSchema.optional() }).strict()
  const ownerQuery = (value: unknown) => {
    const parsed = walletAddressSchema.optional().safeParse(value)
    return parsed.success ? parsed.data ?? '' : ''
  }
  // A cross-site request is normal here: the deployed frontend lives on a different domain, so
  // Origin decides, never Sec-Fetch-Site.
  router.use(originGuard(origins, response => response.sendStatus(403)), authenticate)
  router.get('/config', (_req, res) => res.json({ rwaNetwork: 'mainnet', executionEnabled: false }))
  router.post('/rwa/chat-settle', async (req, res) => {
    const input = body(z.object({ owner: walletAddressSchema, requestId: z.uuid(), text: z.string().trim().min(1).max(2000) }).strict(), req.body)
    const userId = res.locals.identity.uid
    await new WalletAssociationService().require(userId, input.owner)
    const history = createNaRequestStore()
    // Retry updates the same request; it does not add another history entry.
    try { await history.create(userId, input.requestId, input.text) }
    catch { await history.update(userId, input.requestId, { status: 'PENDING' }) }
    const registry = await RWARegistry.configured()
    const settlement = new RWAChatSettlement(registry, new RWAService(registry),
      request => executeVaultSpend(requiredMandateClient(), request), async owner => {
        const mandate = await requiredMandateClient().read(owner)
        if (!mandate) throw new InputError('Chưa có mandate của ví này trên Devnet.')
        // Include creation time: a closed PDA can be recreated at the same address.
        return mandate.address + ':' + mandate.createdAt
      })
    try {
      const reply = await settlement.run(userId, input)
      await history.update(userId, input.requestId, { response: reply.message, orderId: input.requestId,
        phase: reply.phase, title: 'RWA · tài sản thử nghiệm Devnet', ...(reply.signature ? { signature: reply.signature } : {}),
        status: reply.status === 'CONFIRMED' || reply.status === 'PENDING' || reply.status === 'FAILED' ? reply.status
          : reply.status === 'NEEDS_INPUT' ? 'NEEDS_INPUT' : 'NOT_SUBMITTED' })
      res.json(reply)
    } catch (error) {
      if (error instanceof InputError) {
        await history.update(userId, input.requestId, { status: 'NOT_SUBMITTED', response: error.message })
        res.json({ id: input.requestId, status: 'REJECTED', message: error.message, network: 'devnet', warnings: [] })
        return
      }
      // Keep the client request ID after uncertain execution/history failures.
      await history.update(userId, input.requestId, { status: 'PENDING', response: error instanceof Error ? error.message : 'Chưa xác định kết quả.' }).catch(() => {})
      throw error
    }
  })
  // Single source of truth for NFT vs RWA vs UNKNOWN. No frontend keyword list decides this.
  router.post('/asset/resolve', async (req, res) => {
    const input = body(textBody, req.body)
    const resolution = await classifyAssetIntent(input.text, nftEvidence, registryForClassification)
    res.json({ assetType: resolution.assetType, reason: resolution.reason, symbol: resolution.symbol ?? null,
      mint: resolution.mint ?? null, blocked: resolution.blocked, category: resolution.category ?? null })
  })
  router.get('/preferences', async (_req, res) => res.json(await twin.read(res.locals.identity.uid)))
  router.put('/preferences', async (req, res) => res.json(await twin.update(res.locals.identity.uid, body(investmentPreferencesSchema, req.body))))
  router.post('/rwa/discover', async (req, res) => {
    const input = body(textBody, req.body)
    res.json(await (await service()).discover(res.locals.identity.uid, input.text, input.owner))
  })
  router.get('/rwa/orders', async (_req, res) => res.json({ orders: await (await service()).list(res.locals.identity.uid) }))
  /** Re-checks the price condition and revalidates policy; never executes a duplicate order. */
  router.get('/rwa/orders/:id', async (req, res) => res.json(await (await service()).status(
    res.locals.identity.uid, body(z.uuid(), req.params.id), ownerQuery(req.query.owner))))
  router.post('/rwa/orders/:id/evaluate', async (req, res) => res.json(await (await service()).status(
    res.locals.identity.uid, body(z.uuid(), req.params.id), ownerQuery(req.body?.owner))))
  return router
}
