# Tensor Mainnet research (no execution)

Set `TENSOR_API_KEY` in `backend/.env`, then restart the backend. This is a Tensor Developer API credential, not the Helius key. Never put it in frontend environment variables. Existing Devnet RPC and execution settings remain unchanged.

The read-only adapter resolves a collection slug/ID using `GET /api/v1/collections/find_collection?filter=...`, then requests `GET /api/v1/mint/collection` using the returned `collId`, `onlyListings=true`, SOL currency and `ListingPriceAsc` or `ListingPriceDesc`. It reads up to 50 rows; response metadata reports the coverage. It has no transaction endpoint, wallet, signer or RPC client. API authentication/schema failures do not become a claim that a collection does not exist.

Examples:
- `Tìm NFT rẻ nhất collection y00ts`
- `Tìm NFT đắt nhất collection y00ts`

Devnet candidates and Mainnet candidates are not price-compared. Mainnet provides a read-only fallback when no Devnet candidate was selected. Mainnet cards show `MAINNET · Chỉ xem, không mua được`, observation time, Tensor source link and a Mainnet Explorer link. No acquisition score is manufactured from listing price alone. Highest asking price is not an investment valuation or highest historical sale.

The frontend disables purchasing, automatic acquisition and policy-increase prompts for Mainnet results. The backend separately rejects Mainnet in prepare and submit, even if a caller bypasses the UI. A marketplace collection verification badge never grants Mainnet purchase authority.

Validation uses deterministic API fixtures because this workspace has no Tensor API key. Live y00ts results, prices and the current production response shape still require a successful authenticated API check; do not claim the screenshot price is current. Missing configuration displays an explicit warning.

Official references:
- https://dev.tensor.trade/reference/findcollection
- https://dev.tensor.trade/reference/getmintsbycollid
- https://dev.tensor.trade/reference/quickstart
