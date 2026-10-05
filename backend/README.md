# Proposal API

Current NFT chat: `/api/acquisition/discover`, `/quote`, `/submit`, `/orders/:id`, `/wallets`, `/wallets/challenge`, `/wallets/verify`, `/portfolio`. See [asset acquisition](../docs/ASSET_ACQUISITION.md) for configuration, security boundaries and the mainnet-read/Devnet-execution distinction. Legacy proposal/research APIs below remain available.

The existing proposal endpoints are retained. Product research adds `/api/research/search`,
`/api/research/twin` (GET/PATCH), and `/api/research/decisions`.
See [Na research](../docs/NA_RESEARCH.md) for live providers, server-only credentials, timeouts,
origin configuration, anonymous browser profiles and private persistent Twin storage.
Live research returns at most one selection after hard filtering and deterministic comparison. Missing search keys return no recommendation; DEV fixtures require explicit `SEARCH_PROVIDER_MODE=mock`. Configure any supported LLM (OpenAI, Anthropic, Gemini, Groq or local Ollama) separately from search. See [provider setup, failover and tests](../docs/NA_LLM_ROUTER.md). No AI credentials are needed for Authority demo or explicit mock research.
Research approvals pass the selected item to the authority review panel; the current Devnet contract cannot execute live purchases.

Từ root chạy `npm run dev:backend`; hoặc tại backend chạy `npm run dev`.
GET /api/health và POST /api/proposals/search. Request gồm text, image tùy chọn (mimeType + base64), scenario.
Request JSON tối đa 3 MiB, text 2000 ký tự, ảnh 2 MiB và kiểm tra MIME magic bytes.
Zod strict schemas từ @gobuy/shared. Không lưu request/image, không log body hoặc trả stack trace.
MockLLMProvider/MockMarketplaceAdapter hoạt động mặc định, không cần API key.
Không có ví backend, authorize endpoint, marketplace transaction hoặc mandate database.
Xem README gốc để chạy tests và cấu hình.

Extension clients pair through `/api/research/pair-code` and use origin-bound bearer sessions at `/api/extension`. Slow research uses `/jobs` and authenticated polling. All LLM failures retain deterministic search. See [v2 architecture](../docs/NA_ARCHITECTURE_V2.md).
