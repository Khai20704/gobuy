import { nftSearchIntentSchema, type NFTCandidate, type NFTSearchIntent } from '@gobuy/shared'
import { words, type NFTIntentParser } from './discovery.js'
import { budgetExpression, normalizeIntentText, investmentRequest, explicitPriorities, extractCollectionQuery, extractNamedCollectionQuery } from './intentLanguage.js'

export type NaConversationState = {
  currentPrompt: string
  currentIntent: NFTSearchIntent
  selectedCandidate?: NFTCandidate
  previousMints: string[]
  messages: { role: 'user' | 'na'; text: string }[]
}
type ResolvedConversationInput = { prompt: string; intent: NFTSearchIntent; previousMints: string[]; contextual: boolean }
type ConversationInputResult = ResolvedConversationInput | { error: string }

const normalized = (text: string) => words(text).join(' ')

function addSelectedToExclusions(state: NaConversationState) {
  const mint = state.selectedCandidate?.mint
  const mints = mint ? [...new Set([...state.currentIntent.excludedMints, ...state.previousMints, mint])] : [...new Set(state.currentIntent.excludedMints)]
  return mints.slice(-20)
}

export async function resolveConversationInput(text: string, state: NaConversationState | undefined,
  parser: NFTIntentParser): Promise<ConversationInputResult> {
  const phrase = normalized(text)
  if (!state) return { prompt: text, intent: await parser.parse(text), previousMints: [] as string[], contextual: false }

  const budgets = [...normalizeIntentText(text).matchAll(budgetExpression)]
  if (!budgets.length && (explicitPriorities(text).includes('price') || /\b(dat nhat|gia cao nhat|most expensive|highest price)\b/.test(phrase))
    && (extractCollectionQuery(text) ?? extractNamedCollectionQuery(text))) {
    return { prompt: text, intent: await parser.parse(text), previousMints: [], contextual: false }
  }
  const budgetOnly = budgets.length > 0 && /^(?:\s|[.,!?]|actually|now|ok|okay|vay|thi|doi|lai|ngan sach|budget|la|con|cho|tui|toi|minh|nha|nhe|thoi)*$/.test(
    normalizeIntentText(text).replace(budgetExpression, '').trim())
  // A new subject with a budget must replace the old request, not just edit its price.
  if (budgets.length && !budgetOnly) return { prompt: text, intent: await parser.parse(text), previousMints: [], contextual: false }
  if (budgetOnly) {
    const budgetIntent = await parser.parse(text)
    return { prompt: state.currentPrompt, intent: nftSearchIntentSchema.parse({ ...state.currentIntent,
      maximumLamports: budgetIntent.maximumLamports, maxPriceSol: budgetIntent.maxPriceSol, priceDiscoveryOnly: false,
      action: 'SEARCH', excludedMints: state.currentIntent.priceDiscoveryOnly ? [] : addSelectedToExclusions(state),
    }), previousMints: addSelectedToExclusions(state), contextual: true }
  }
  if (state.currentIntent.priceDiscoveryOnly) {
    if (/^(thu lai|tim lai|kiem tra lai|retry|try again)[.!?]*$/.test(phrase)) {
      return { prompt: state.currentPrompt, intent: state.currentIntent, previousMints: state.previousMints, contextual: true }
    }
    return { prompt: text, intent: await parser.parse(text), previousMints: [], contextual: false }
  }
  const inheritedBudget = `${Number(state.currentIntent.maximumLamports) / 1e9} SOL`
  if (investmentRequest(text)) return { prompt: text, intent: await parser.parse(`${text} max ${inheritedBudget}`), previousMints: [], contextual: false }
  // Short answers to the research clarification explicitly switch to an observable criterion.
  if (state.currentIntent.requestKind === 'investment_research'
    && /\b(gia thap|re nhat|gia re|cheapest|lowest price|do hiem|hiem nhat|rarity|rarest)\b/.test(phrase)) {
    const criterion = /\b(hiem|rarity|rarest)\b/.test(phrase) ? 'rarest' : 'cheapest'
    const intent = await parser.parse(`Find NFT ${criterion} max ${inheritedBudget}`)
    return { prompt: text, intent, previousMints: [], contextual: false }
  }
  // Refinements carry preferences and budget, never a previous instruction to buy.
  state = { ...state, currentIntent: { ...state.currentIntent, action: 'SEARCH' } }

  if (/^(thu lai|tim lai|kiem tra lai|retry|try again)[.!?]*$/.test(phrase)) {
    return { prompt: state.currentPrompt, intent: state.currentIntent, previousMints: state.previousMints, contextual: true }
  }

  if (/\b(find another|another one|tim cai khac|tim lua chon khac|tim khac)\b/.test(phrase)) {
    return { prompt: state.currentPrompt, intent: nftSearchIntentSchema.parse({
      ...state.currentIntent, excludedMints: addSelectedToExclusions(state),
    }), previousMints: addSelectedToExclusions(state), contextual: true }
  }

  if (/\b(more rare|rarer|hiem hon|hiem nua)\b/.test(phrase)) {
    const excludedMints = addSelectedToExclusions(state)
    return { prompt: state.currentPrompt, intent: nftSearchIntentSchema.parse({
      ...state.currentIntent, priorities: [...new Set([...state.currentIntent.priorities, 'rarity'])],
      excludedMints,
    }), previousMints: excludedMints, contextual: true }
  }

  if (/\b(too colorful|too colourful|qua sac so|nhieu mau qua)\b/.test(phrase)) {
    const excludedMints = addSelectedToExclusions(state)
    return { prompt: state.currentPrompt, intent: nftSearchIntentSchema.parse({
      ...state.currentIntent, priorities: [...new Set([...state.currentIntent.priorities, 'visual'])],
      avoidTerms: [...new Set([...state.currentIntent.avoidTerms, 'colorful', 'colourful', 'sac so'])],
      excludedMints,
    }), previousMints: excludedMints, contextual: true }
  }

  if (/\b(darker|more dark|toi hon|toi mau hon)\b/.test(phrase)) {
    const excludedMints = addSelectedToExclusions(state)
    return { prompt: state.currentPrompt, intent: nftSearchIntentSchema.parse({
      ...state.currentIntent, terms: [...new Set([...state.currentIntent.terms, 'dark'])].slice(0, 12),
      priorities: [...new Set([...state.currentIntent.priorities, 'visual'])], excludedMints,
    }), previousMints: excludedMints, contextual: true }
  }

  if (/\b(dont care about rarity|don t care about rarity|do not care about rarity|khong can hiem|khong uu tien hiem)\b/.test(phrase)) {
    return { prompt: state.currentPrompt, intent: nftSearchIntentSchema.parse({
      ...state.currentIntent, priorities: state.currentIntent.priorities.filter(priority => priority !== 'rarity'),
    }), previousMints: state.previousMints, contextual: true }
  }

  if (/\b(cheaper|less expensive|re hon)\b/.test(phrase) && state.selectedCandidate) {
    const currentPrice = BigInt(state.selectedCandidate.listing.priceLamports)
    const maximumLamports = currentPrice > 0n ? (currentPrice - 1n).toString() : '0'
    const excludedMints = addSelectedToExclusions(state)
    return { prompt: state.currentPrompt, intent: nftSearchIntentSchema.parse({
      ...state.currentIntent, maximumLamports, priorities: [...new Set([...state.currentIntent.priorities, 'price'])],
      excludedMints,
    }), previousMints: excludedMints, contextual: true }
  }

  return { prompt: text, intent: await parser.parse(`${text} max ${inheritedBudget}`), previousMints: [] as string[], contextual: false }
}
