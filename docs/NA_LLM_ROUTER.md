# Na: independent AI providers and live search

Na's intent extraction and grounded explanations now use `StructuredLLMProvider` → `RoutedStructuredLLMProvider` → `LLMRouter.generate()`. The router calls OpenAI, Anthropic, Gemini, Groq or optional local Ollama. Prompts and Na's identity are shared; adapters only translate requests, responses and provider errors.

The existing `SearchAggregator` still queries independent live sources concurrently: Brave Web Search, eBay Browse, Magic Eden and optional OpenAI web search. Verification, ranking, Commerce Twin, the secure payment boundary and Phantom/Anchor Devnet flows remain in place. There is no OpenAI SDK dependency in the repository: the previous direct Responses HTTP call was moved out of the structured business interface into `ai/providers/OpenAIProvider.ts`.

## Configure and run

Edit **backend/.env** yourself using [backend/.env.example](../backend/.env.example) as a reference. Existing `.env` files have not been modified. Never put these settings in frontend files or `VITE_*` variables. At least one LLM and one live search source are needed for full live research. Two configured LLMs are needed to demonstrate cloud failover.

Example using Gemini first and Groq second:

```dotenv
SEARCH_PROVIDER_MODE=real
LLM_PROVIDER_ORDER=gemini,groq,openai,ollama
GEMINI_API_KEY=your_server_side_key
GEMINI_MODEL=gemini-2.5-flash
GROQ_API_KEY=your_server_side_key
GROQ_MODEL=llama-3.3-70b-versatile
BRAVE_SEARCH_API_KEY=your_server_side_search_key
```

Keep actual key values private. Model defaults are configurable examples, not a guarantee of availability in your account. A search API key is separate from an LLM API key. An eBay production Browse OAuth token can be used for physical-product offers; Magic Eden requires enabling its adapter and supplying an exact collection symbol. Brave discovers source pages; pages lacking sufficient price/product evidence remain leads.

From the existing repository root, in two terminals:

```powershell
npm run dev:backend
```

```powershell
npm run dev
```

Open `http://localhost:5173/na`. Try `Find Jordan 1 Chicago under 100 USD`. Startup logs show the configured priority and each enabled provider's status. `configured` for cloud services means a key/model is present, not that billing or access has been verified. Only Ollama receives a free, bounded reachability/model probe at startup. Missing keys never prevent the HTTP server from starting.

To run the existing offline fixtures, explicitly use `SEARCH_PROVIDER_MODE=mock`. This uses the labeled deterministic development parser and synthetic listings, without calling any LLM. Real mode never switches to mock listings. All-provider failures use a labeled deterministic parser; structured search bypasses the LLM entirely. Authority demo remains independent and needs no AI API keys.

### Gemini

Create a key in [Google AI Studio](https://aistudio.google.com/apikey), following [Google's API-key instructions](https://ai.google.dev/gemini-api/docs/api-key). Put it in `GEMINI_API_KEY`, set `GEMINI_MODEL`, and include `gemini` in `LLM_PROVIDER_ORDER`. Restart the backend. The adapter uses the Generate Content REST API, sends the key in a server-side header, requests JSON schema output, and validates locally with Zod. For the default `gemini-2.5-flash`, thinking is disabled so the small structured output budget is available for the result; other model overrides keep their own defaults. See [Gemini thinking configuration](https://ai.google.dev/gemini-api/docs/generate-content/thinking).

### Groq

Create a key in [Groq Console](https://console.groq.com/keys), following the [Groq quickstart](https://console.groq.com/docs/quickstart). Set `GROQ_API_KEY`, `GROQ_MODEL`, and include `groq` in the priority. The default model uses JSON object mode with the shared schema in the prompt. Zod validation and repair are required because JSON mode alone does not enforce a schema. See [Groq structured outputs](https://console.groq.com/docs/structured-outputs).

### Ollama

Install/start Ollama using its [official quickstart](https://docs.ollama.com/quickstart), then install a local model, for example:

```powershell
ollama pull qwen2.5:7b
```

Use your already-installed model if preferred. Configure:

```dotenv
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=qwen2.5:7b
OLLAMA_CONTEXT_WINDOW_TOKENS=8192
LLM_PROVIDER_ORDER=openai,gemini,groq,ollama
```

Keep the local server running (`ollama serve` if it is not already running). Before generation, `/api/tags` must be reachable and list the chosen model. An unavailable endpoint is skipped after about one second. The router also bounds adapters that ignore cancellation. Models are never downloaded automatically. An empty `OLLAMA_MODEL` disables this adapter. Its `/api/chat` call uses non-streaming schema output; see [Ollama chat API](https://docs.ollama.com/api/chat) and [installed models API](https://docs.ollama.com/api/tags). Ollama is optional in production and does not supply live Internet data by itself.

## Environment reference

| Variable | Default / meaning |
| --- | --- |
| `LLM_PROVIDER_ORDER` | `openai,gemini,groq,ollama`; only listed providers are eligible, in this order |
| `OPENAI_API_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY` | Optional individually; each cloud adapter requires its corresponding key |
| `OPENAI_MODEL` | `gpt-4o-mini` |
| `GEMINI_MODEL` | `gemini-2.5-flash` |
| `GROQ_MODEL` | `llama-3.3-70b-versatile` |
| `OLLAMA_BASE_URL` | `http://localhost:11434`; server configuration only, never model/user output |
| `OLLAMA_MODEL` | Empty; disables local fallback until explicitly set |
| `*_CONTEXT_WINDOW_TOKENS` | Optional declared context capacity; built-in cloud defaults apply only to their exact default models |
| `OLLAMA_CONTEXT_WINDOW_TOKENS` | `8192`; also sent to Ollama as `num_ctx` |
| `LLM_REQUEST_TIMEOUT_MS` | `30000` per attempt, capped at 30000 |
| `LLM_TOTAL_TIMEOUT_MS` | `120000` total per logical generation, including repairs/failover; capped at 120000 |
| `LLM_FAILURE_THRESHOLD` | `3` failed provider requests before opening its circuit |
| `LLM_COOLDOWN_SECONDS` | `60` before one half-open recovery request |
| `LLM_TIMEOUT_MS` | Legacy alias, used only when `LLM_REQUEST_TIMEOUT_MS` is absent |
| `SEARCH_FAILURE_THRESHOLD`, `SEARCH_COOLDOWN_SECONDS` | Separate search circuits; defaults `3`, `60` |
| `BRAVE_SEARCH_API_KEY`, `EBAY_ACCESS_TOKEN`, `MAGIC_EDEN_ENABLED` | Independent live sources, as described in [research guide](NA_RESEARCH.md) |
| `OPENAI_SEARCH_MODEL`, `OPENAI_SEARCH_TIMEOUT_MS` | Existing optional search adapter; `gpt-5.5`, `45000` |

Structured explanation selection has a separate 10-second total budget and may retain deterministic evidence-based reasons. The browser allows five minutes for the bounded research/failover/refresh sequence. A very slow set of providers can exhaust the total budget before every provider is attempted. Production reverse-proxy timeouts must allow the intended request duration.

## Reliability and safe output

- Quota, HTTP 429, provider credentials/access, timeouts, connection failures, HTTP 5xx and unavailable models advance to the next configured provider. Missing providers are skipped. Adapters classify provider responses without retaining raw error bodies.
- Generic application errors, invalid internal requests/schema, GoBuy validation failures and authorization/transaction failures are not retried on another provider. A model refusal is also not routed around.
- A failed circuit becomes `OPEN` at the threshold. Further calls skip it. After cooldown, exactly one request enters `HALF_OPEN`; success closes the circuit, failure reopens it. Circuits are independent between AI and search.
- JSON is parsed and checked against the existing Zod schemas before business logic. One repair attempt is allowed for malformed JSON, schema violations or ungrounded explanation choices. Persistent invalid output can fall over to the next provider. Transaction validation remains outside this repair path.
- Context-length errors do not consume the quota circuit. Compaction removes only messages explicitly marked as redundant and discardable. System messages, raw user messages, the latest request, normalized intent, budget, quantity, selected evidence and transaction state are retained. After at most one reduced-context retry, only a provider with a known larger declared window is eligible. If safe compaction is impossible, the router proceeds directly to a larger window or returns `LLM_CONTEXT_TOO_LARGE`. It never truncates financial constraints. Ollama additionally uses a conservative byte-size check to avoid silent server truncation; this can reject prompts a model-specific tokenizer might fit.
- Every adapter receives an independent copy of the normalized request. No provider-specific thread IDs are used. Session-owned cached research stores messages, intent, authorization, selected evidence and purchase state; cross-session or expired IDs are rejected. Existing Commerce Twin persistence is separate.
- An explicit BUY budget, currency and quantity are extracted by deterministic backend rules. Unrecognized/ambiguous budget syntax cannot create spending authority. Repeated explicit maxima use the lower limit. Supported numeric phrases include `under`, `maximum`, `budget`, `tối đa`, `dưới`, with SOL/USDC/USD/VND/EUR/GBP. Use an explicit decimal and currency, for example `Maximum 1 SOL`. BUY product/variant terms also retain the literal request parser's constraints. This intentionally favors blocking unsupported phrasing over granting inferred authority.
- The existing payment service still refreshes the selected product, binds seller/variant/order/destination, computes exact lamports, checks the final total against the original maximum, requires secure-layer approval, and enforces idempotency. No LLM can submit a transaction or modify these parameters.

When all eligible AI providers fail, the router raises this internal error. The intent layer catches it, continues with deterministic parsing, and adds the warning ?AI reasoning is temporarily unavailable. Search and on-chain validation are still available.? Structured search never calls a model:

Internal router error (not the normal research HTTP response):

```json
{"error":{"code":"ALL_LLM_PROVIDERS_UNAVAILABLE","retryable":true,"message":"Na's AI providers are temporarily unavailable. Please try again shortly."}}
```

The existing frontend displays that safe message. Successful failover remains invisible in conversation. Na does not claim to be a different assistant, and no provider-generated prose becomes product records. If only optional explanation generation fails, existing deterministic reasons remain clearly labeled; no invented explanation is returned.

Logs include only operation name, configured provider/model, success/failure, elapsed time, category and failover count. They do not include prompts, API keys, raw provider messages, auth headers, wallet keys or seed phrases. Circuit state is inspectable server-side through `router.status()`; it is not exposed as a public credentials endpoint.

## Verify automatic fallback

The automated suite uses fake transport responses and requires no real credentials or credits:

Verified for this refactor: `npm run lint` (workspace TypeScript checks plus test type checking), **67/67 Node tests**, `npm run build` (shared, backend and frontend), and **12/12 headless Edge browser tests** passed. Windows sandbox restrictions required running tsx tests and Vite/Playwright outside the sandbox. Production builds completed with non-fatal annotation warnings from the installed Zod dependency. No real AI credentials, live checkout, on-chain transfer or deployment were exercised.

```powershell
node --import tsx --test backend/tests/llmRouter.test.ts
npm run lint
npm test
npm run build
$env:PLAYWRIGHT_CHANNEL = 'msedge'
npm run test:e2e
```

Covered cases include OpenAI success; 429/quota → Gemini; OpenAI/Gemini outage → installed Ollama; all-provider failure; malformed JSON/schema repair; state/financial constraint preservation; 1 SOL maximum against a fallback suggesting 1.8 SOL; independent Brave retrieval during an OpenAI outage; context compaction/larger-window selection; circuit recovery/concurrency; ignored cancellation; missing local models; sanitized HTTP errors; and application errors that must not fail over. Existing search, verification, ranking, wallet/transaction, shared-contract and browser suites remain applicable.

For a manual cloud check, configure valid Gemini and an independent search source in `backend/.env`, then use a separate PowerShell terminal to launch with temporary process overrides (no `.env` edits needed):

```powershell
$env:LLM_PROVIDER_ORDER = 'openai,gemini,groq,ollama'
$env:OPENAI_API_KEY = 'invalid-demo-key'
npm run dev:backend
```

Send a normal FIND request in Na. Logs should show OpenAI credentials failure followed by Gemini success; the UI should show Na's ordinary research response. This manual check uses actual Gemini/search quota. The exact 429 and quota-exhaustion cases are covered automatically without exhausting anyone's account. Stop the test backend and close that terminal to discard its environment overrides. Never put keys in chat or force real purchases to test failover.

## Buying and remaining limits

**Adding an AI key does not connect real checkout.** `createResearchService()` still has no production `AuthorizedPaymentLayer` attached. A BUY request currently reports `BLOCKED` and makes no SOL transfer. The existing Authority demo is a separate Devnet workflow; its wallet signing and on-chain constraints were not changed. For real purchases, a merchant/order integration and an authenticated, durable, idempotent payment adapter are still required. No wallet secrets or new signing permissions were added.

Live account/model access and a running local model were not verified with real credentials in this implementation. Search evidence quality and existing provider-specific limitations still apply. Model overrides must support their adapter's JSON mode/schema and have truthful context metadata. The router is intentionally in-process: circuit state and research conversation caches reset on restart and are not shared across replicas. User history is retained rather than summarized by another model; very long protected context can therefore require a new, shorter conversation. Semantic reasoning quality is not guaranteed by JSON validation, so final financial approval remains deterministic and external to the LLM.

## File inventory for this refactor

Created:

- `backend/src/ai/LLMProvider.ts`, `LLMRouter.ts`, `context.ts`, `createLLMRouter.ts`
- `backend/src/ai/errors/classifyProviderError.ts`
- `backend/src/ai/providers/OpenAIProvider.ts`, `GeminiProvider.ts`, `GroqProvider.ts`, `OllamaProvider.ts`, `http.ts`
- `backend/src/adapters/llm/RoutedStructuredLLMProvider.ts`
- `backend/src/services/CircuitBreaker.ts`
- `backend/src/services/ai/spendingConstraints.ts`
- `backend/tests/llmRouter.test.ts`
- `docs/NA_LLM_ROUTER.md`

Modified from the existing working tree (which already contained uncommitted research work):

- `backend/src/adapters/llm/StructuredLLMProvider.ts`: pure provider-independent business interface
- `backend/src/application/createResearchService.ts`, `NaResearchService.ts`: composition, independent setup guidance and normalized conversation state
- `backend/src/services/ai/intentExtractor.ts`, `explainRecommendations.ts`: schema validators, deterministic constraints and shared router calls
- `backend/src/services/search/SearchAggregator.ts`: per-source circuits, preserving concurrent source isolation/deduplication
- `backend/src/config/env.ts`, `backend/src/app.ts`: provider configuration and safe API errors
- `backend/.env.example`, `.env.example`, `README.md`, `backend/README.md`, `docs/NA_RESEARCH.md`: setup and architecture documentation
- `frontend/src/services/api/research.ts`, `frontend/src/features/na/components/ResearchResults.tsx`: request timeout and provider-independent setup text
- `backend/tests/research.test.ts`, `frontend/e2e/research.spec.ts`, `playwright.config.ts`: adapter test migration, safe status coverage and offline browser-test configuration

Remaining direct OpenAI calls are isolated in `ai/providers/OpenAIProvider.ts` and the preserved optional search adapter `services/search/OpenAIWebSearchProvider.ts`. `createLLMRouter.ts` and `createResearchService.ts` are composition/configuration only. No OpenAI calls remain in intent, explanation, ranking, verification, purchase or wallet business logic. The existing scenario-based mock `adapters/llm/LLMProvider.ts` is unchanged for Authority demo.

API implementation references: [OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs), [Gemini Generate Content](https://ai.google.dev/api/generate-content), [Groq Structured Outputs](https://console.groq.com/docs/structured-outputs), [Ollama Chat](https://docs.ollama.com/api/chat).

## Anthropic

Set server-only `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, and include `anthropic` in `LLM_PROVIDER_ORDER`. The Messages adapter validates JSON locally, rejects truncated/refused output, and uses the common circuit breaker. See [Claude API authentication](https://platform.claude.com/docs/en/manage-claude/authentication).
