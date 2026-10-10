import { Router, type RequestHandler } from 'express'
import { z } from 'zod'
import { createNftPurchaseAuthorizationInputSchema, TENSOR_MARKETPLACE_PROGRAM_ID, walletAddressSchema,
  type DiscoveryReply } from '@gobuy/shared'
import { InputError } from '../../schemas/search.js'
import { originGuard } from '../originGuard.js'
import { assetStore } from '../../persistence/AssetStore.js'
import { WalletAssociationService } from '../../services/acquisition/WalletAssociationService.js'
import { requiredMandateClient } from '../../services/mandate/MandateProgramClient.js'
import { readNftPurchaseAuthorization } from '../../services/nft-purchase/readNftPurchaseAuthorization.js'
import { mandateProgramId } from '../../services/mandate/MandateGuard.js'
import { NftPurchaseService, nftPurchaseLiveEnabled } from '../../services/nft-purchase/NftPurchaseService.js'
import { NftPurchaseAuthorizationClient } from '../../services/nft-purchase/NftPurchaseAuthorizationClient.js'

type SavedDiscovery = { reply: DiscoveryReply; text: string }

/**
 * Genuine NFT purchase endpoints.
 *
 * These routes can move Vault SOL to a marketplace, so they are the strictest in the API. There is
 * no DEMO mint and no settlement transfer here: the vault pays Tensor and the minted NFT is the
 * original listing transferred straight to the owner's wallet. The purchase endpoint refuses to act
 * unless NFT_PURCHASE_LIVE_ENABLED is explicitly true and an owner-signed purchase authorization
 * exists on chain.
 */
export function nftPurchaseRoutes(authenticate: RequestHandler, origins: string[]) {
  const router = Router()
  const discoveries = assetStore<SavedDiscovery>('assetDiscoveries')
  const wallets = new WalletAssociationService()
  const purchases = new NftPurchaseService()
  const authorizations = new NftPurchaseAuthorizationClient()
  let instance: ReturnType<typeof requiredMandateClient> | undefined
  const client = () => instance ??= requiredMandateClient()
  function parse<T>(schema: z.ZodType<T>, value: unknown): T {
    const result = schema.safeParse(value)
    if (!result.success) throw new InputError('Yêu cầu mua NFT gốc không hợp lệ.')
    return result.data
  }

  router.use(originGuard(origins, response => response.sendStatus(403)), authenticate)

  router.get('/config', (_request, response) => response.json({
    network: 'devnet', marketplace: 'Tensor', marketplaceProgram: TENSOR_MARKETPLACE_PROGRAM_ID,
    deliveryMode: 'ORIGINAL_NFT_TRANSFER', demoFallback: false,
    liveExecutionEnabled: nftPurchaseLiveEnabled(), authorizationRequired: true,
    vaultProgramId: mandateProgramId()?.toBase58() ?? null,
  }))

  router.get('/authorization', async (request, response) => {
    const { owner } = parse(z.object({ owner: walletAddressSchema }).strict(), request.query)
    response.json({ authorization: await readNftPurchaseAuthorization(client(), owner) })
  })

  // The owner signs this themselves; the backend only prepares and verifies it.
  router.post('/authorization', async (request, response) => {
    const input = parse(createNftPurchaseAuthorizationInputSchema.extend({ owner: walletAddressSchema }).strict(), request.body)
    await wallets.require(response.locals.identity.uid, input.owner)
    response.json(await authorizations.build(input.owner, input))
  })

  router.post('/authorization/submit', async (request, response) => {
    const input = parse(createNftPurchaseAuthorizationInputSchema.extend({ owner: walletAddressSchema,
      transaction: z.string().min(32).max(40_000) }).strict(), request.body)
    await wallets.require(response.locals.identity.uid, input.owner)
    try { response.json(await authorizations.submit(input.owner, input, input.transaction)) }
    catch (error) {
      // InputError is raised only before broadcast; transport ambiguity returns PENDING.
      if (!(error instanceof InputError)) throw error
      response.json({ action: 'authorize_nft', status: 'FAILED', signature: null,
        message: error.message })
    }
  })

  /**
   * Genuine purchase of a listing from a saved discovery. `candidateId` must belong to that saved
   * discovery and it must have been a BUY request: a SEARCH result carries no spending authority.
   */
  router.post('/purchase', async (request, response) => {
    const input = parse(z.object({ discoveryId: z.uuid(), candidateId: z.string().min(1).max(200),
      owner: walletAddressSchema }).strict(), request.body)
    const uid = response.locals.identity.uid
    await wallets.require(uid, input.owner)
    const saved = await discoveries.get(uid, input.discoveryId)
    if (!saved || Date.parse(saved.reply.expiresAt) <= Date.now()) {
      throw new InputError('Kết quả tìm kiếm đã hết hạn hoặc không thuộc tài khoản. Hãy tìm lại NFT.')
    }
    if (saved.reply.intent.action !== 'BUY' || saved.reply.intent.priceDiscoveryOnly) {
      throw new InputError('SEARCH không có quyền chi tiêu. Gửi yêu cầu mua rõ ràng kèm ngân sách.')
    }
    const candidate = saved.reply.candidates.find(item => item.id === input.candidateId)
    if (!candidate) throw new InputError('NFT không thuộc kết quả tìm kiếm này.')
    if (BigInt(candidate.listing.priceLamports) > BigInt(saved.reply.intent.maximumLamports)) {
      throw new InputError('Giá NFT vượt ngân sách của yêu cầu BUY ban đầu.')
    }
    response.json(await purchases.purchase(uid, { discoveryId: input.discoveryId, owner: input.owner, candidate }))
  })

  router.get('/purchases/:discoveryId', async (request, response) => {
    const { discoveryId } = parse(z.object({ discoveryId: z.uuid() }).strict(), request.params)
    response.json(await purchases.status(response.locals.identity.uid, discoveryId))
  })

  return router
}

/** Named so a test can assert the genuine path never advertises a DEMO delivery. */
export const NFT_PURCHASE_DELIVERY_MODE = 'ORIGINAL_NFT_TRANSFER' as const
