import { Router, type RequestHandler } from 'express'
import { z } from 'zod'
import { PublicKey } from '@solana/web3.js'
import { createMandateInputSchema, explainMandateRejection, mandateCategoryAllows, mandateOwnerActionSchema, mandateSpendRequestSchema, walletAddressSchema, MANDATE_DURATION_PRESETS } from '@gobuy/shared'
import { InputError } from '../../schemas/search.js'
import { originGuard } from '../originGuard.js'
import { requiredMandateClient, settlementAddress } from '../../services/mandate/MandateProgramClient.js'
import { describeMandate, mandateProgramId, serializeMandate } from '../../services/mandate/MandateGuard.js'
import { agentKeypair } from '../../services/mandate/agentKeypair.js'
import { executeVaultSpend } from '../../services/mandate/autonomousSpend.js'
import { spendNoteIndex } from '../../services/mandate/mandateNotes.js'
import { WalletAssociationService } from '../../services/acquisition/WalletAssociationService.js'

export function mandateRoutes(authenticate: RequestHandler, origins: string[]) {
  const router = Router(), wallets = new WalletAssociationService()
  let instance: ReturnType<typeof requiredMandateClient> | undefined
  const client = () => instance ??= requiredMandateClient()
  function parse<T>(schema: z.ZodType<T>, value: unknown): T {
    const result = schema.safeParse(value)
    if (!result.success) throw new InputError('Yêu cầu Na Vault không hợp lệ.')
    return result.data
  }
  // A cross-site request is normal here: the deployed frontend lives on a different domain, so
  // Origin decides, never Sec-Fetch-Site.
  router.use(originGuard(origins, response => response.sendStatus(403)), authenticate)
  router.get('/config', (_req, res) => res.json({
    vaultProgramId: mandateProgramId()?.toBase58() ?? null,
    autonomousExecutionReady: !!mandateProgramId() && !!agentKeypair() && !!settlementAddress(),
    categories: ['NFT', 'RWA', 'ANY'], durations: MANDATE_DURATION_PRESETS,
    marketplaceExecution: 'wallet_signature_required',
  }))
  router.get('/', async (req, res) => {
    const { owner } = parse(z.object({ owner: walletAddressSchema }).strict(), req.query)
    const mandate = await client().read(owner)
    res.json({ description: describeMandate(mandate), mandate: serializeMandate(mandate), vaultProgramId: client().programId.toBase58(), marketplaceExecution: 'wallet_signature_required' })
  })
  router.get('/spends', async (req, res) => {
    const { owner } = parse(z.object({ owner: walletAddressSchema }).strict(), req.query)
    const records = await client().history(owner)
    const notes = await spendNoteIndex(res.locals.identity.uid)
    const spends = await Promise.all(records.slice(0, 200).map(async record => {
      const note = notes.get(record.spendId)
      const signatures = await client().connection.getSignaturesForAddress(new PublicKey(record.address), { limit: 1 }, 'confirmed')
      return { ...record, reference: note?.owner === owner ? note.reference : null, signature: signatures.find(item => !item.err)?.signature ?? null }
    }))
    res.json({ spends })
  })
  router.post('/transaction', async (req, res) => {
    const input = parse(z.object({ owner: walletAddressSchema, action: mandateOwnerActionSchema, create: createMandateInputSchema.optional() }).strict(), req.body)
    res.json(await client().ownerTransaction(input))
  })
  router.post('/submit', async (req, res) => {
    const input = parse(z.object({ owner: walletAddressSchema, action: mandateOwnerActionSchema, transaction: z.string().min(32).max(40000) }).strict(), req.body)
    res.json(await client().submitOwnerTransaction(input))
  })
  // Explicit Devnet settlement demo. This transfers SOL; it does not acquire an NFT or RWA.
  router.post('/spend', async (req, res) => {
    const input = parse(mandateSpendRequestSchema, req.body)
    await wallets.require(res.locals.identity.uid, input.owner)
    // The mandate's category is authoritative: a mandate signed for NFT may not spend as RWA and
    // vice versa. The program enforces the same rule; checking here returns the precise reason
    // before any transaction is built, and never trusts the client-declared category.
    const mandate = await client().read(input.owner)
    if (!mandate) throw new InputError('Không tìm thấy mandate cho ví này trên Devnet.')
    if (!mandateCategoryAllows(mandate.allowedCategory, input.category)) {
      throw new InputError(explainMandateRejection('InvalidCategory', { mandateCategory: mandate.allowedCategory, requestedCategory: input.category }))
    }
    res.json(await executeVaultSpend(client(), { ...input, userId: res.locals.identity.uid, amountLamports: BigInt(input.amountLamports) }))
  })
  return router
}
