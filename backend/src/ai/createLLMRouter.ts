import { env } from '../config/env.js'
import { LLMRouter } from './LLMRouter.js'
import { OpenAIProvider } from './providers/OpenAIProvider.js'
import { AnthropicProvider } from './providers/AnthropicProvider.js'
import { GeminiProvider } from './providers/GeminiProvider.js'
import { GroqProvider } from './providers/GroqProvider.js'
import { OllamaProvider } from './providers/OllamaProvider.js'

export function createLLMRouter(config = env) {
  const providers = {
    openai: new OpenAIProvider(config.OPENAI_API_KEY, config.OPENAI_MODEL, undefined, config.OPENAI_CONTEXT_WINDOW_TOKENS),
    anthropic: new AnthropicProvider(config.ANTHROPIC_API_KEY, config.ANTHROPIC_MODEL),
    gemini: new GeminiProvider(config.GEMINI_API_KEY, config.GEMINI_MODEL, undefined, config.GEMINI_CONTEXT_WINDOW_TOKENS),
    groq: new GroqProvider(config.GROQ_API_KEY, config.GROQ_MODEL, undefined, config.GROQ_CONTEXT_WINDOW_TOKENS),
    ollama: new OllamaProvider(config.OLLAMA_BASE_URL, config.OLLAMA_MODEL, undefined, config.OLLAMA_CONTEXT_WINDOW_TOKENS),
  }
  const router = new LLMRouter(config.LLM_PROVIDER_ORDER.map(name => providers[name]), {
    requestTimeoutMs: config.LLM_REQUEST_TIMEOUT_MS ?? config.LLM_TIMEOUT_MS ?? 30000,
    totalTimeoutMs: config.LLM_TOTAL_TIMEOUT_MS, failureThreshold: config.LLM_FAILURE_THRESHOLD,
    cooldownMs: config.LLM_COOLDOWN_SECONDS * 1000,
    logger: event => console.info('[Na LLM Router]', JSON.stringify(event)),
  })
  console.info('[Na LLM Router] Priority:', config.LLM_PROVIDER_ORDER.join(' -> '))
  void router.reportAvailability()
  return router
}
