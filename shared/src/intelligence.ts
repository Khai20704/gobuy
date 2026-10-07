import { z } from 'zod'

export const rwaCategorySchema = z.enum(['GOLD', 'TREASURY', 'EQUITY', 'ETF', 'COMMODITY', 'OTHER'])
export type RWACategory = z.infer<typeof rwaCategorySchema>
export const assetCategorySchema = z.enum(['NFT', 'RWA'])
export const nftObjectiveSchema = z.enum([
  'BEST_OVERALL',
  'STRONGEST_MOMENTUM', 'MOST_BOUGHT', 'TRENDING', 'BEST_LIQUIDITY',
  'LOWEST_PRICE', 'HIGHEST_PRICE', 'RARITY', 'GENERAL_MATCH',
])
export type NFTObjective = z.infer<typeof nftObjectiveSchema>
export const investmentPreferencesSchema = z.object({
  riskTolerance: z.enum(['low', 'medium', 'high']).optional(),
  horizon: z.enum(['1h', '24h', '7d']).optional(),
  preferredNFTCategories: z.array(z.string().min(1).max(60)).max(12).optional(),
  preferredRWACategories: z.array(rwaCategorySchema).max(6).optional(),
  maxPriceSol: z.number().finite().positive().max(10).optional(),
}).strict()
export const nftInvestmentIntentSchema = z.object({
  category: z.literal('NFT'), chain: z.literal('solana'),
  objective: z.enum(['strongest_momentum', 'most_bought', 'best_liquidity', 'trending', 'value']),
  horizon: z.enum(['1h', '24h', '7d']), riskTolerance: z.enum(['low', 'medium', 'high']),
  futurePredictionRequested: z.boolean().default(false),
})
export type NFTInvestmentIntent = z.infer<typeof nftInvestmentIntentSchema>
const nonnegative = z.number().finite().nonnegative()
const score = z.number().finite().min(0).max(100)
export const nftMarketFeaturesSchema = z.object({
  mint: z.string(), collection: z.string(), priceSol: nonnegative,
  marketScope: z.enum(['collection', 'mint']).default('collection'),
  mintSales1h: nonnegative.optional(), mintSales24h: nonnegative.optional(), mintSales7d: nonnegative.optional(),
  mintUniqueBuyers24h: nonnegative.optional(),
  mintVolume24h: nonnegative.optional(),
  floorPriceSol: nonnegative.optional(),
  floorChange1h: z.number().finite().optional(), floorChange24h: z.number().finite().optional(), floorChange7d: z.number().finite().optional(),
  volume1h: nonnegative.optional(), volume24h: nonnegative.optional(), volume7d: nonnegative.optional(),
  volumeChange1h: z.number().finite().optional(), volumeChange24h: z.number().finite().optional(), volumeChange7d: z.number().finite().optional(),
  sales1h: nonnegative.optional(), sales24h: nonnegative.optional(), sales7d: nonnegative.optional(),
  salesChange1h: z.number().finite().optional(), salesChange24h: z.number().finite().optional(), salesChange7d: z.number().finite().optional(),
  uniqueBuyers24h: nonnegative.optional(), uniqueSellers24h: nonnegative.optional(),
  buyerChange1h: z.number().finite().optional(), buyerChange24h: z.number().finite().optional(), buyerChange7d: z.number().finite().optional(),
  listedCount: nonnegative.optional(), listedRatio: z.number().min(0).max(1).optional(),
  supply: nonnegative.optional(), collectionVerified: z.boolean().optional(),
  selfTradeRatio: z.number().min(0).max(1).optional(), topSellerShare: z.number().min(0).max(1).optional(),
  liquidityScore: score.optional(), observations: nonnegative, coverage: z.enum(['complete', 'partial', 'unknown']),
  source: z.string(), observedAt: z.iso.datetime(), warnings: z.array(z.string()).default([]),
})
export type NFTMarketFeatures = z.infer<typeof nftMarketFeaturesSchema>
export const nftScoreSchema = z.object({
  momentum: score.nullable(), liquidity: score.nullable(), risk: score, confidence: score,
  finalScore: score.nullable(), eligible: z.boolean(),
  signals: z.array(z.object({ name: z.string(), value: z.union([z.number(), z.string()]), contribution: z.number().optional() })),
  warnings: z.array(z.string()),
})
export type NFTScore = z.infer<typeof nftScoreSchema>
export const nftIntelligenceSchema = z.object({
  objective: nftInvestmentIntentSchema, features: nftMarketFeaturesSchema, score: nftScoreSchema,
  explanation: z.string(),
})

const mint = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)
const positiveUnits = z.string().regex(/^[1-9]\d{0,15}$/)
export const rwaAssetSchema = z.object({
  mint, symbol: z.string().min(1).max(24), name: z.string().min(1).max(120), issuer: z.string().min(1).max(120),
  category: rwaCategorySchema, underlying: z.string().min(1).max(300),
  decimals: z.number().int().min(0).max(12), verified: z.boolean(), allowedForSwap: z.boolean(),
  verificationSource: z.url().refine(v => v.startsWith('https://')), updatedAt: z.iso.datetime(),
  // Optional so existing RWA_APPROVED_LIST rows stay valid; treated as mainnet when absent.
  network: z.enum(['mainnet', 'devnet']).optional(),
  // Administrator attests issuer eligibility; an allowlist is required for restricted assets.
  eligibleWallets: z.array(mint).max(1000).optional(),
}).strict()
export type RWAAsset = z.infer<typeof rwaAssetSchema>

/** Conditional trigger. Only a price ceiling is supported, in the currency the user named. */
export const rwaPriceConditionSchema = z.object({
  type: z.literal('PRICE_BELOW'),
  targetPrice: z.number().finite().positive(),
  priceCurrency: z.enum(['USD', 'USDC', 'SOL']),
}).strict()
export type RWAPriceCondition = z.infer<typeof rwaPriceConditionSchema>

export const rwaOrderStatusSchema = z.enum(['WAITING_FOR_PRICE', 'EXECUTING', 'CONFIRMED', 'FAILED',
  'EXPIRED', 'CANCELLED', 'EXECUTION_UNAVAILABLE'])
export type RWAOrderStatus = z.infer<typeof rwaOrderStatusSchema>

/**
 * A conditional RWA order. Persisted so an unmet price is a waiting state, never a rejection, and so
 * an eligible order can be revalidated and executed exactly once.
 */
export const rwaOrderSchema = z.object({
  id: z.uuid(), owner: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/),
  assetMint: mint, symbol: z.string().min(1).max(24),
  orderType: z.enum(['SPEND', 'QUANTITY']),
  spendAmount: positiveUnits.optional(), spendCurrency: z.enum(['SOL', 'USDC']).optional(),
  quantity: positiveUnits.optional(),
  maxTotalSpend: positiveUnits.optional(), maxSpendCurrency: z.enum(['SOL', 'USDC']).optional(),
  condition: rwaPriceConditionSchema.optional(),
  status: rwaOrderStatusSchema,
  mandate: z.string().nullable().optional(),
  observation: z.object({ observedPrice: z.number().finite().nullable(), observedAt: z.iso.datetime().nullable() }).strict().optional(),
  execution: z.object({ network: z.enum(['mainnet', 'devnet']), reason: z.string(), signature: z.string().nullable() }).strict().optional(),
  idempotencyKey: z.string().min(8).max(200),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(), expiresAt: z.iso.datetime(),
}).strict()
export type RWAOrder = z.infer<typeof rwaOrderSchema>
export const rwaIntentSchema = z.object({
  category: z.literal('RWA'), subtype: rwaCategorySchema.optional(), symbol: z.string().max(24).optional(), mint: mint.optional(),
  action: z.enum(['SEARCH', 'BUY']), amount: positiveUnits.optional(), currency: z.enum(['SOL', 'USDC']),
  // SPEND: pay `amount` of `currency`. QUANTITY: buy exactly `quantity` asset units, total cost at
  // most `maxTotalSpend`. The two are never interchangeable: "100 USDC NVDAx" spends 100 USDC and
  // does NOT mean 100 units of NVDAx.
  order: z.enum(['SPEND', 'QUANTITY']).optional(),
  // The requested quantity EXACTLY as the user stated it ("1", "0.5"). Atomic units need the
  // asset's decimals, which are only known after the mint resolves, so the order record carries
  // the atomic value and the intent keeps the user-facing decimal.
  quantity: z.string().regex(/^\d+(?:\.\d{1,12})?$/).refine(v => Number(v) > 0).optional(),
  condition: rwaPriceConditionSchema.optional(),
  maxTotalSpend: positiveUnits.optional(), maxSpendCurrency: z.enum(['SOL', 'USDC']).optional(),
  // A request is either about ONE named asset (SPECIFIC_ASSET) or about a category of approved assets
  // (CATEGORY_DISCOVERY). A discovery request names no symbol and no mint: the whole sentence is NEVER
  // used as an asset identifier or as a canonical-mint lookup key.
  requestKind: z.enum(['SPECIFIC_ASSET', 'CATEGORY_DISCOVERY']).optional(),
  // The category a user asked for (for example TECHNOLOGY). It only filters and ranks candidates that
  // RWA_APPROVED_LIST has already approved, and can never grant approval by itself.
  desiredCategory: z.string().min(1).max(40).optional(),
}).strict()
export type RWAIntent = z.infer<typeof rwaIntentSchema>

/** One already-approved candidate returned by a category discovery, with market data and a rank. */
export const rwaRecommendationSchema = z.object({
  symbol: z.string().min(1).max(24), mint, name: z.string().min(1).max(120), category: rwaCategorySchema,
  // Jupiter market data only. Never used to decide identity or authenticity.
  priceUsd: z.number().finite().nonnegative().nullable(),
  withinBudget: z.boolean().nullable(),
  estimatedQuantity: z.string().optional(),
  score: z.number().finite().min(0).max(100),
  reasons: z.array(z.string()).default([]),
}).strict()
export type RWARecommendation = z.infer<typeof rwaRecommendationSchema>

export const rwaReplySchema = z.object({
  id: z.uuid(),
  status: z.enum(['NEEDS_INPUT', 'REJECTED', 'QUOTED', 'APPROVED', 'PENDING', 'CONFIRMED', 'FAILED',
    'WAITING_FOR_PRICE', 'EXECUTING', 'EXECUTION_UNAVAILABLE', 'EXPIRED', 'CANCELLED', 'RECOMMENDED']),
  message: z.string(), intent: rwaIntentSchema.optional(), asset: rwaAssetSchema.optional(),
  // Category discovery returns ranked already-approved candidates instead of one asset/order.
  recommendations: z.array(rwaRecommendationSchema).optional(),
  quote: z.object({ inputMint: mint, outputMint: mint, inAmount: positiveUnits, outAmount: positiveUnits,
    minOutput: positiveUnits, slippageBps: z.number(), expiresAt: z.iso.datetime(),
    policyValueLamports: z.number().int().positive(), network: z.enum(['mainnet', 'devnet']), route: z.array(z.string()) }).optional(),
  order: rwaOrderSchema.optional(),
  network: z.enum(['mainnet', 'devnet']).optional(),
  transaction: z.string().optional(), signature: z.string().optional(), warnings: z.array(z.string()).default([]),
})
export type RWAReply = z.infer<typeof rwaReplySchema>

/** Answer of the canonical AssetResolver: what the backend decided this request is about. */
export const assetResolutionViewSchema = z.object({
  assetType: z.enum(['RWA', 'NFT', 'UNKNOWN']),
  reason: z.string().min(1), symbol: z.string().nullable(), mint: z.string().nullable(), blocked: z.boolean(),
  // Set only for a CATEGORY_DISCOVERY request (for example TECHNOLOGY); null for a specific asset.
  category: z.string().max(40).nullable().optional(),
}).strict()
export type AssetResolutionView = z.infer<typeof assetResolutionViewSchema>
