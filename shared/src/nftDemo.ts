import { z } from 'zod'
import { nftCandidateSchema } from './acquisition.js'
import { purchasePhaseSchema } from './devnetDelivery.js'

export const nftDemoQuoteSchema = z.object({
  sourceAsset: nftCandidateSchema.optional(), simulated: z.boolean().optional(),
  conversion: z.object({ maximumUsd: z.number().positive(), usdPerSol: z.number().positive(), observedAt: z.string(), sourceUrl: z.string() }).optional(),
  id: z.uuid(), network: z.literal('devnet'), owner: z.string(), asset: z.string(),
  title: z.string(), image: z.string(), priceLamports: z.number().int().nonnegative(),
  maximumLamports: z.number().int().positive(), estimatedTotalLamports: z.number().int().positive(),
  transaction: z.string(), expiresAt: z.string(),
})
export type NftDemoQuote = z.infer<typeof nftDemoQuoteSchema>
export const nftDemoReplySchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('READY'), message: z.string(), quote: nftDemoQuoteSchema }),
  z.object({ status: z.enum(['NO_MATCH', 'NEEDS_INPUT']), message: z.string() }),
])
export const nftDemoReceiptSchema = z.object({
  phase: purchasePhaseSchema.optional(),
  status: z.enum(['CONFIRMED', 'PENDING', 'FAILED', 'NOT_SUBMITTED']), message: z.string(),
  signature: z.string().optional(), asset: z.string().optional(), totalLamports: z.number().optional(),
})
export type NftDemoReceipt = z.infer<typeof nftDemoReceiptSchema>
