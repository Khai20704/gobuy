import { purchaseIntentSchema, searchIntentSchema, type PurchaseIntent, type SearchIntent } from '@gobuy/shared'

export function toSearchIntent(input: PurchaseIntent): SearchIntent {
  const intent = purchaseIntentSchema.parse(input)
  return searchIntentSchema.parse({ action: 'FIND', product: intent.query.slice(0, 300),
    keywords: intent.query.match(/[\p{L}\p{N}][\p{L}\p{N}-]*/gu)?.slice(0, 12).map(s => s.slice(0, 80)) ?? [],
    category: intent.assetType.toLowerCase(), maxPrice: intent.budget?.amount, currency: intent.budget?.currency,
    collectionSymbol: intent.preferences?.collectionSymbol,
    preferences: { authentic: intent.preferences?.authentic, reputableSeller: intent.preferences?.reputableSeller, riskLevel: intent.preferences?.riskLevel },
  })
}
export function toPurchaseIntent(requestId: string, query: string, intent: SearchIntent): PurchaseIntent {
  return purchaseIntentSchema.parse({ requestId, query, assetType: intent.collectionSymbol || intent.category === 'nft' ? 'NFT'
    : intent.category === 'rwa' ? 'RWA' : 'PHYSICAL',
    ...(intent.maxPrice !== undefined && intent.currency ? { budget: { amount: intent.maxPrice, currency: intent.currency } } : {}),
    preferences: { collectionSymbol: intent.collectionSymbol, authentic: intent.preferences.authentic, reputableSeller: intent.preferences.reputableSeller, riskLevel: intent.preferences.riskLevel },
  })
}
