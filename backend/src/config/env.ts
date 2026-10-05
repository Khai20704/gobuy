import { solanaConfig } from '@gobuy/shared'
import { z } from 'zod'
const optionalText = z.preprocess(value => typeof value === 'string' && !value.trim() ? undefined : value, z.string().trim().optional())
const model = (fallback: string) => z.preprocess(value => typeof value === 'string' && !value.trim() ? undefined : value, z.string().trim().min(1).default(fallback))
const contextWindow = z.preprocess(value => value === '' ? undefined : value, z.coerce.number().int().min(1024).max(10000000).optional())
const providerName = z.enum(['openai', 'anthropic', 'gemini', 'groq', 'ollama'])
const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  HOST: z.string().default('127.0.0.1'),
  SEARCH_PROVIDER_MODE: z.enum(['auto', 'real', 'mock']).default('real'),
  BRAVE_SEARCH_API_KEY: z.string().trim().optional(),
  SERPAPI_KEY: optionalText,
  EBAY_ACCESS_TOKEN: z.string().trim().optional(),
  EBAY_MARKETPLACE_ID: z.string().regex(/^EBAY_[A-Z]{2,8}$/).default('EBAY_US'),
  // Magic Eden is used only by the separate legacy /api/research provider, never NFT acquisition.
  MAGIC_EDEN_ENABLED: z.enum(['true', 'false']).default('false').transform(value => value === 'true'),
  MAGIC_EDEN_API_KEY: z.string().trim().optional(),
  HELIUS_API_KEY: optionalText,
  HELIUS_NETWORK: z.literal('devnet').default('devnet'),
  NFT_MARKETPLACE_PROVIDER: z.literal('tensor').default('tensor'),
  NFT_ASSET_PROVIDER: z.literal('helius').default('helius'),
  DEMO_MODE: z.literal('true').default('true'),
  OPENAI_API_KEY: z.string().trim().optional(),
  OPENAI_MODEL: model('gpt-4o-mini'),
  ANTHROPIC_API_KEY: optionalText,
  ANTHROPIC_MODEL: model('claude-sonnet-4-5'),
  ONDO_DATA_URL: optionalText,
  GEMINI_API_KEY: optionalText,
  GEMINI_MODEL: model('gemini-2.5-flash'),
  GROQ_API_KEY: optionalText,
  GROQ_MODEL: model('llama-3.3-70b-versatile'),
  OLLAMA_BASE_URL: model('http://localhost:11434').refine(value => {
    try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash }
    catch { return false }
  }, 'Use an HTTP(S) Ollama server URL without credentials'),
  OLLAMA_MODEL: optionalText,
  OPENAI_CONTEXT_WINDOW_TOKENS: contextWindow,
  GEMINI_CONTEXT_WINDOW_TOKENS: contextWindow,
  GROQ_CONTEXT_WINDOW_TOKENS: contextWindow,
  OLLAMA_CONTEXT_WINDOW_TOKENS: contextWindow,
  LLM_PROVIDER_ORDER: z.string().default('openai,anthropic,gemini,groq,ollama')
    .transform(value => value.split(',').map(name => name.trim().toLowerCase()))
    .pipe(z.array(providerName).min(1).refine(value => new Set(value).size === value.length, 'Duplicate provider in LLM_PROVIDER_ORDER')),
  LLM_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(100).max(30000).optional(),
  LLM_TOTAL_TIMEOUT_MS: z.coerce.number().int().min(100).max(120000).default(120000),
  LLM_FAILURE_THRESHOLD: z.coerce.number().int().min(1).max(20).default(3),
  LLM_COOLDOWN_SECONDS: z.coerce.number().int().min(1).max(3600).default(60),
  SEARCH_FAILURE_THRESHOLD: z.coerce.number().int().min(1).max(20).default(3),
  SEARCH_COOLDOWN_SECONDS: z.coerce.number().int().min(1).max(3600).default(60),
  OPENAI_SEARCH_MODEL: z.string().min(1).default('gpt-5.5'),
  OPENAI_SEARCH_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(45000),
  COINGECKO_API_KEY: z.string().trim().optional(),
  SEARCH_TIMEOUT_MS: z.coerce.number().int().min(100).max(15000).default(8000),
  // Legacy alias. LLM_REQUEST_TIMEOUT_MS takes precedence.
  LLM_TIMEOUT_MS: z.coerce.number().int().min(100).max(30000).optional(),
  TWIN_DATA_DIR: z.string().min(1).default('.data/commerce-twins'),
  RANKING_WEIGHTS_JSON: z.string().optional(),
  APP_ORIGINS: z.string().default('http://localhost:5173,http://127.0.0.1:5173').transform(value => value.split(',').map(origin => origin.trim()).filter(Boolean))
    .pipe(z.array(z.url().refine(value => { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && url.origin === value }, 'Use an exact HTTP(S) origin'))),
})
export const env = envSchema.parse(process.env)

export const solana = solanaConfig(process.env)
