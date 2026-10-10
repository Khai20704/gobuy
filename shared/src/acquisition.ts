import { z } from 'zod'
import { isPublicHttpsUrl } from './research.js'
import { nftInvestmentIntentSchema, nftMarketFeaturesSchema, nftIntelligenceSchema, nftObjectiveSchema } from './intelligence.js'

export const walletAddressSchema = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)
const units = z.string().regex(/^(0|[1-9]\d{0,15})$/)
export const nftSearchIntentSchema = z.object({
  assetType: z.literal('NFT'), semanticQuery: z.string().min(1).max(500),
  category: z.literal('NFT').default('NFT'), chain: z.literal('solana').default('solana'),
  collectionAddress: walletAddressSchema.optional(),
  exactNFTName: z.string().min(1).max(200).optional(),
  maxPriceSol: z.number().finite().positive().optional(), minPriceSol: z.number().finite().nonnegative().optional(),
  terms: z.array(z.string().min(2).max(60)).min(1).max(12),
  maximumLamports: units, currency: z.literal('SOL'), intent: z.literal('acquire_asset'),
  priceDiscoveryOnly: z.boolean().optional(),
  collectionSymbol: z.string().min(1).max(120).optional(),
  collectionQuery: z.string().trim().min(1).max(120).optional(),
  objective: nftObjectiveSchema.optional(),
  action: z.enum(['SEARCH', 'BUY']).default('SEARCH'),
  broadSearch: z.boolean().default(false),
  priorities: z.array(z.enum(['rarity', 'price', 'visual'])).max(3).default([]),
  avoidTerms: z.array(z.string().min(2).max(60)).max(12).default([]),
  excludedMints: z.array(walletAddressSchema).max(20).default([]),
  parser: z.enum(['llm', 'literal']),
  requestKind: z.enum(['discovery', 'investment_research']).optional(),
  parserStatus: z.enum(['ready', 'not_configured', 'unavailable']).optional(),
  investment: nftInvestmentIntentSchema.optional(),
})
export type NFTSearchIntent = z.infer<typeof nftSearchIntentSchema>
export type NFTNetwork = 'mainnet' | 'devnet'
export const nftResearchSchema = z.object({
  network: z.literal('mainnet'), query: z.string(), collection: z.string().optional(), collectionId: walletAddressSchema.optional(),
  source: z.literal('Helius Mainnet'), resolverSource: z.string().optional(), verified: z.boolean(),
  assetsChecked: z.number().int().nonnegative(), priceSource: z.literal('unavailable'),
  checkedAt: z.iso.datetime(), execution: z.literal('MAINNET_READ_ONLY'),
  assets: z.array(z.object({ mint: walletAddressSchema, network: z.literal('mainnet'), name: z.string(), image: z.string().nullable(),
    attributes: z.array(z.object({ name: z.string(), value: z.string() })), matchScore: z.number(), reasons: z.array(z.string()) })).max(3),
})
export type NFTResearch = z.infer<typeof nftResearchSchema>
export const nftCandidateSchema = z.object({
  id: z.string().min(1).max(150), provider: z.string().min(1).max(60),
  sourceNetwork: z.enum(['mainnet', 'devnet', 'mock']), mint: walletAddressSchema.nullable(),
  name: z.string().min(1).max(200), description: z.string().max(4000),
  image: z.string().max(2000).refine(value => isPublicHttpsUrl(value) || /^\/api\/nft-demo\/art\/[a-z0-9-]+$/.test(value)).nullable(), collection: z.string().max(120),
  attributes: z.array(z.object({ name: z.string().max(100), value: z.string().max(300) })).max(40),
  purchaseEligibility: z.object({ allowed: z.boolean(), reason: z.enum(['VERIFICATION_UNAVAILABLE', 'TOKEN_NOT_VERIFIED', 'MAINNET_READ_ONLY']),
    verificationKind: z.literal('independent') }).optional(),
  asset: z.object({ mint: walletAddressSchema, name: z.string().nullish(), description: z.preprocess(value => value ?? '', z.string()),
    image: z.string().nullish(), owner: walletAddressSchema, collectionAddress: walletAddressSchema.nullish(),
    collectionName: z.string().nullish(), attributes: z.preprocess(value => value ?? [], z.array(z.object({ name: z.string(), value: z.string() }))),
    network: z.literal('devnet'), verifiedAt: z.iso.datetime() }).optional(),
  marketplaceListing: z.object({ listingId: walletAddressSchema, mint: walletAddressSchema, seller: walletAddressSchema,
    priceLamports: units, currency: z.literal('SOL'), marketplace: z.literal('Tensor'), network: z.literal('devnet'),
    status: z.enum(['LISTED', 'SOLD', 'CANCELLED', 'INVALID']), listedAt: z.iso.datetime().optional() }).optional(),
  listing: z.object({ priceLamports: units, currency: z.literal('SOL'), seller: walletAddressSchema.nullable(),
    url: z.string().max(2000).refine(value => value === '' || isPublicHttpsUrl(value)), observedAt: z.iso.datetime() }),
  marketData: z.object({ collectionFloorLamports: units.optional(), lastSaleLamports: units.optional(),
    observedAt: z.iso.datetime() }).optional(),
  rarityScore: z.number().min(0).max(1).optional(), rarityRank: z.number().int().positive().optional(),
  marketFeatures: nftMarketFeaturesSchema.optional(),
  assessment: z.object({ score: z.number().min(0).max(100), risk: z.number().min(0).max(100),
    confidence: z.number().min(0).max(100), eligible: z.boolean(),
    factors: z.array(z.object({ name: z.string(), value: z.number(), weight: z.number() })),
    reasons: z.array(z.string()), warnings: z.array(z.string()) }).optional(),
  relevance: z.number().min(0).max(1).default(0), reasons: z.array(z.string().max(300)).max(10).default([]),
  warnings: z.array(z.string().max(300)).max(10).default([]),
})
export type NFTCandidate = z.infer<typeof nftCandidateSchema>
export const acquisitionRankingSchema = z.object({
  score: z.number().min(0).max(100), confidence: z.number().min(0).max(100),
  components: z.object({
    intentMatch: z.number().min(0).max(1).nullable(), preferenceMatch: z.number().min(0).max(1).nullable(),
    visualMatch: z.number().min(0).max(1).nullable(), rarity: z.number().min(0).max(1).nullable(),
    marketQuality: z.number().min(0).max(1).nullable(), priceFit: z.number().min(0).max(1).nullable(),
  }).strict(),
  marketFactors: z.object({
    activity: z.number().min(0).max(1).nullable(), liquidity: z.number().min(0).max(1).nullable(),
    priceAttractiveness: z.number().min(0).max(1).nullable(), momentum: z.number().min(0).max(1).nullable(),
    rarity: z.number().min(0).max(1).nullable(), riskQuality: z.number().min(0).max(1).nullable(),
    risk: z.number().min(0).max(100).nullable(),
  }).strict().optional(),
  reasons: z.array(z.string().max(300)).max(8),
}).strict()
export type AcquisitionRanking = z.infer<typeof acquisitionRankingSchema>
export const discoverySourceSchema = z.object({
  provider: z.string().min(1).max(60),
  status: z.enum(['AVAILABLE', 'UNAVAILABLE']),
  code: z.enum(['AUTHENTICATION_FAILED', 'ACCESS_FORBIDDEN', 'RATE_LIMITED', 'PROVIDER_UNAVAILABLE',
    'INVALID_RESPONSE', 'RESPONSE_TOO_LARGE', 'TIMEOUT', 'NO_DATA', 'DISABLED', 'AUTH_REQUIRED',
    'NETWORK_ERROR', 'SCHEMA_MISMATCH', 'NO_MATCH', 'RPC_UNSUPPORTED']).optional(),
  httpStatus: z.number().int().min(100).max(599).optional(),
})
/**
 * Per-operation diagnostics.
 *
 * `endpoint` is optional and must stay optional: RPC endpoints carry API keys in their query string,
 * so a diagnostic that requires one pressures callers into logging credentials. Operation names,
 * counts, timings and constant failure categories are the log-safe subset.
 */
export const nftProviderDiagnosticSchema = z.object({
  provider: z.string().min(1).max(60), endpoint: z.string().min(1).max(300).optional(),
  network: z.string().min(1).max(40), httpStatus: z.number().int().min(100).max(599).optional(),
  latencyMs: z.number().nonnegative(), receivedRows: z.number().int().nonnegative().optional(),
  acceptedRows: z.number().int().nonnegative().optional(), schemaRejectedRows: z.number().int().nonnegative().optional(),
  budgetRejectedRows: z.number().int().nonnegative().optional(), finalCandidateCount: z.number().int().nonnegative().optional(),
  failureCode: z.string().optional(),
  operation: z.string().min(1).max(40).optional(), category: z.string().min(1).max(40).optional(),
  timeoutSource: z.enum(['adapter', 'caller', 'client']).optional(), accountsRead: z.number().int().nonnegative().optional(),
})
export const discoveryReplySchema = z.object({
  id: z.uuid(), intent: nftSearchIntentSchema, candidates: z.array(nftCandidateSchema).max(10),
  status: z.enum(['MATCHED', 'NO_MATCH', 'DATA_UNAVAILABLE', 'INSUFFICIENT_DATA', 'NO_SAFE_PURCHASE',
    'COLLECTION_NOT_FOUND', 'COLLECTION_AMBIGUOUS', 'COLLECTION_UNRESOLVED', 'NO_ASSETS_FOUND', 'NO_DEVNET_LISTINGS',
    'PROVIDER_UNAVAILABLE', 'INSUFFICIENT_MARKET_DATA', 'MAINNET_READ_ONLY', 'PURCHASE_AVAILABLE']),
  research: nftResearchSchema.optional(),
  resolvedCollection: z.object({ name: z.string(), symbol: z.string(), collectionAddress: walletAddressSchema.optional(),
    source: z.string(), verified: z.boolean().optional() }).optional(),
  ambiguousCollections: z.array(z.object({ name: z.string(), symbol: z.string(), collectionAddress: walletAddressSchema.optional(),
    source: z.string(), verified: z.boolean().optional() })).optional(),
  diagnostics: z.array(nftProviderDiagnosticSchema).optional(),
  coverage: z.object({ listingsChecked: z.number().optional(), activitiesChecked: z.number().optional(), collectionsChecked: z.number().optional() }).optional(),
  transitions: z.array(z.object({ state: z.string(), at: z.iso.datetime() })).optional(),
  sources: z.array(discoverySourceSchema).default([]),
  ranking: acquisitionRankingSchema.optional(), message: z.string(), warnings: z.array(z.string()), expiresAt: z.iso.datetime(),
  intelligence: nftIntelligenceSchema.optional(),
})
export type DiscoveryReply = z.infer<typeof discoveryReplySchema>
export const walletAssociationSchema = z.object({ address: walletAddressSchema, provider: z.literal('phantom'),
  network: z.literal('devnet'), verified: z.literal(true), createdAt: z.iso.datetime(), lastUsedAt: z.iso.datetime() })
export type WalletAssociation = z.infer<typeof walletAssociationSchema>
export const assetPositionSchema = z.object({
  id: z.uuid(), userId: z.string(), walletAddress: walletAddressSchema, assetType: z.literal('NFT'),
  sourceAsset: nftCandidateSchema,   execution: z.object({ network: z.literal('devnet'), simulated: z.boolean(),
    mint: walletAddressSchema, transactionHash: z.string() }),
  acquisitionPriceLamports: units, acquisitionCurrency: z.literal('DEVNET_SOL'), acquisitionDate: z.iso.datetime(),
  ownership: z.enum(['verified', 'not_owned', 'unknown']), ownershipCheckedAt: z.iso.datetime().nullable(),
  valuation: z.object({ estimatedMarketValue: z.null(), unrealizedPnL: z.null(),
    note: z.string() }),
})
export type AssetPosition = z.infer<typeof assetPositionSchema>
export type AcquisitionQuote = import('./nftDemo.js').NftDemoQuote
export type ExecutionResult = import('./nftDemo.js').NftDemoReceipt
