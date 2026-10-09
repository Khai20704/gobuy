import { z } from 'zod'
import { nftCandidateSchema, walletAddressSchema } from './acquisition.js'
import { mandateSpendResponseSchema } from './mandate.js'
import { devnetDeliverySchema, purchasePhaseSchema } from './devnetDelivery.js'

/** Optional presentation metadata never substitutes for an executable listing identity. */
export const autonomousNFTCandidateSchema = nftCandidateSchema.extend({
  provider: z.literal('tensor'), sourceNetwork: z.literal('devnet'), mint: walletAddressSchema,
  asset: nftCandidateSchema.shape.asset.unwrap(),
  marketplaceListing: nftCandidateSchema.shape.marketplaceListing.unwrap().extend({ status: z.literal('LISTED') }),
  listing: nftCandidateSchema.shape.listing.extend({ seller: walletAddressSchema,
    priceLamports: z.string().regex(/^[1-9]\d{0,15}$/) }),
}).superRefine((candidate, context) => {
  const listing = candidate.marketplaceListing
  if (candidate.mint !== listing.mint || candidate.asset.mint !== candidate.mint
    || candidate.asset.owner !== listing.listingId || candidate.listing.seller !== listing.seller
    || candidate.listing.priceLamports !== listing.priceLamports) {
    context.addIssue({ code: 'custom', message: 'Mint, custody, seller or price does not match the verified Tensor listing.' })
  }
  if (candidate.purchaseEligibility?.allowed === false) context.addIssue({ code: 'custom', message: 'Asset verification blocks execution.' })
})
export type AutonomousNFTCandidate = z.infer<typeof autonomousNFTCandidateSchema>
export const autonomousPurchaseResultSchema = z.object({
  deliveryMode: z.literal('DEVNET_DEMO_MINT').optional(), recipientWallet: walletAddressSchema.optional(),
  phase: purchasePhaseSchema.optional(), delivery: devnetDeliverySchema.optional(),
  id: z.uuid(), execution: z.literal('Devnet autonomous spend demo'), network: z.literal('devnet'),
  selected: autonomousNFTCandidateSchema, listingPriceLamports: z.string().regex(/^[1-9]\d*$/),
  requestedSpendLamports: z.string().regex(/^[1-9]\d*$/),
  actualSpendLamports: z.string().regex(/^\d+$/).nullable(),
  signedBy: z.literal('Na Agent / executor'), phantomSignatureRequired: z.literal(false),
  result: mandateSpendResponseSchema.extend({ status: z.enum(['CONFIRMED', 'FAILED', 'NOT_SUBMITTED', 'PENDING', 'RECONCILIATION_ERROR']) }),
})
export type AutonomousPurchaseResult = z.infer<typeof autonomousPurchaseResultSchema>
export const autonomousReconciliationSchema = z.object({
  id: z.uuid(), status: z.enum(['CONFIRMED', 'FAILED', 'NOT_SUBMITTED', 'PENDING', 'RECONCILIATION_ERROR']),
  message: z.string(), safeToRetry: z.boolean(), purchase: autonomousPurchaseResultSchema.optional(),
})
export type AutonomousReconciliation = z.infer<typeof autonomousReconciliationSchema>
