import { Router, type RequestHandler } from 'express'
import { z } from 'zod'
import { investmentPreferencesSchema, namedNFTQuery, remainingBudget, walletAddressSchema } from '@gobuy/shared'
import { InputError } from '../../schemas/search.js'
import { originGuard } from '../originGuard.js'
import { extractNamedCollectionQuery } from '../../services/acquisition/intentLanguage.js'
import { AssetResolver } from '../../services/rwa/AssetResolver.js'
import { RWARegistry } from '../../services/rwa/RWARegistry.js'
import { RWAService, type MandateView } from '../../services/rwa/RWAService.js'
import { requiredMandateClient } from '../../services/mandate/MandateProgramClient.js'
import { InvestmentTwinService } from '../../services/twin/InvestmentTwinService.js'

/**
 * RWA and investment preferences.
 *
 * Routing is decided by the canonical `AssetResolver`, never by frontend keyword matching: the
 * frontend asks this API what an asset is. Identity comes from RWA_APPROVED_LIST (exact mint),
 * Jupiter supplies market data only, and the on-chain mandate stays the policy layer.
 */

export function investmentRoutes(authenticate: RequestHandler, origins: string[]) {
  const router = Router(), twin = new InvestmentTwinService()

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
  // Single source of truth for NFT vs RWA vs UNKNOWN. No frontend keyword list decides this.
  router.post('/asset/resolve', async (req, res) => {
    const input = body(textBody, req.body)
    const registry = await RWARegistry.configured()
    const resolution = new AssetResolver(registry, nftEvidence).resolve(input.text)
    res.json({ assetType: resolution.assetType, reason: resolution.reason, symbol: resolution.symbol ?? null,
      mint: resolution.mint ?? null, blocked: resolution.blocked })
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
