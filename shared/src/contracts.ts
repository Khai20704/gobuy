import { z } from 'zod'
import { publicKeyBytes } from './addresses.js'
export { base58Decode, publicKeyBytes } from './addresses.js'
export const publicKeySchema = z.string().refine(value => { try { publicKeyBytes(value); return true } catch { return false } }, 'Invalid Solana address')

export const MAX_IMAGE_BYTES = 2 * 1024 * 1024
export const U64_MAX = 18446744073709551615n
export const amountSchema = z.string().regex(/^[1-9][0-9]{0,19}$/).refine(value => /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= U64_MAX, 'Use a positive u64 integer')
export const assetTypeSchema = z.enum(['NFT', 'RWA'])
export const marketplaceSchema = z.enum(['DEMO_MARKET', 'DEMO_GALLERY'])
export const imageSchema = z.object({
  mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
  base64: z.string().max(4 * Math.ceil(MAX_IMAGE_BYTES / 3)).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
}).strict()
export const searchSchema = z.object({
  text: z.string().trim().max(2000).default(''),
  image: imageSchema.optional(),
  scenario: z.enum(['within', 'outside', 'unverified', 'wrong-market', 'rwa']).default('within'),
}).strict().refine(value => value.text.length > 0 || !!value.image, 'Add a request or image')
export type SearchRequest = z.infer<typeof searchSchema>

export const proposalSchema = z.object({
  id: z.uuid(),
  assetType: assetTypeSchema,
  title: z.string().min(1).max(160),
  amount: amountSchema,
  currency: z.literal('DEVNET_SOL_LAMPORTS'),
  decimals: z.literal(9),
  marketplace: marketplaceSchema,
  assetId: z.string().min(1).max(200),
  collection: publicKeySchema.optional(),
  protocol: publicKeySchema.optional(),
  riskLevel: z.number().int().min(0).max(3).optional(),
  sellerEvidence: z.object({
    source: z.literal('mock-adapter'),
    claimedVerified: z.boolean(),
    reference: z.string().max(200),
    disclaimer: z.string().max(300),
  }).strict(),
  metadata: z.object({
    imageUrl: z.enum(['/demo/artwork.svg', '/demo/rwa.svg']),
    description: z.string().max(500),
    demo: z.literal(true),
  }).strict(),
  expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict()
export type CommerceProposal = z.infer<typeof proposalSchema>
export const searchResponseSchema = z.object({
  mode: z.literal('demo'),
  explanation: z.string(),
  proposals: z.array(proposalSchema).min(1).max(3),
}).strict()
export type SearchResponse = z.infer<typeof searchResponseSchema>
