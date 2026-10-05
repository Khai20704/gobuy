import { MongoTwinStore } from '../persistence/MongoTwinStore.js'
import { storageMode } from '../persistence/mongo.js'
import { resolve } from 'node:path'
import { rankingWeightsSchema } from '@gobuy/shared'
import { env } from '../config/env.js'
import { createLLMRouter } from '../ai/createLLMRouter.js'
import { RoutedStructuredLLMProvider } from '../adapters/llm/RoutedStructuredLLMProvider.js'
import { IntentExtractor } from '../services/ai/intentExtractor.js'
import { SearchAggregator } from '../services/search/SearchAggregator.js'
import { SerpApiProvider } from '../services/search/SerpApiProvider.js'
import { EbayProvider } from '../services/search/EbayProvider.js'
import { MagicEdenProvider } from '../services/search/MagicEdenProvider.js'
import { MockSearchProvider } from '../services/search/MockSearchProvider.js'
import { MockSneakerProvider } from '../services/search/MockSneakerProvider.js'
import { OndoProvider } from '../services/search/OndoProvider.js'
import { OpenAIWebSearchProvider } from '../services/search/OpenAIWebSearchProvider.js'
import { SolExchangeRates } from '../services/currency/SolExchangeRates.js'
import { FileTwinStore } from '../services/twin/TwinStore.js'
import { NaResearchService } from './NaResearchService.js'

export function createResearchService() {
  const mock = env.SEARCH_PROVIDER_MODE === 'mock'
  const providers = mock ? [new MockSearchProvider(), new MockSneakerProvider()] : [
    new OpenAIWebSearchProvider(env.OPENAI_API_KEY, env.OPENAI_SEARCH_MODEL, env.OPENAI_SEARCH_TIMEOUT_MS),
    new SerpApiProvider(env.SERPAPI_KEY), new EbayProvider(env.EBAY_ACCESS_TOKEN, env.EBAY_MARKETPLACE_ID),
    new MagicEdenProvider(env.MAGIC_EDEN_ENABLED, env.MAGIC_EDEN_API_KEY), new OndoProvider(env.ONDO_DATA_URL),
  ]
  const router = createLLMRouter()
  // Mock stays offline. Live outages fall back to deterministic intent extraction and live adapters.
  const llm = mock ? undefined : new RoutedStructuredLLMProvider(router)
  return new NaResearchService(new IntentExtractor(llm), new SearchAggregator(providers, env.SEARCH_TIMEOUT_MS, {
    failureThreshold: env.SEARCH_FAILURE_THRESHOLD, cooldownMs: env.SEARCH_COOLDOWN_SECONDS * 1000,
  }),
    storageMode() === 'mongo' ? new MongoTwinStore() : new FileTwinStore(resolve(env.TWIN_DATA_DIR)), { mode: mock ? 'mock' : 'real', llm, rates: new SolExchangeRates(env.COINGECKO_API_KEY),
      weights: env.RANKING_WEIGHTS_JSON ? rankingWeightsSchema.parse(JSON.parse(env.RANKING_WEIGHTS_JSON)) : undefined })
}
