# Metaplex Core demo deliveries

New autonomous NFT orders use `METAPLEX_CORE`. The asset standard, metadata URI
and image URI are captured before payment and copied into the immutable delivery
plan. Existing orders without a standard keep their historical delivery path;
no migration or remint is performed. RWA issuance is unchanged.

Set `NFT_DEMO_PUBLIC_URL` to a durable HTTPS origin serving the existing public
`/api/acquisition/delivery-metadata/:id` route. Set `NFT_DEMO_IMAGE_URL` to a
durable HTTPS GoBuy DEMO image, preferably PNG. Both must remain available after
local processes stop. A persistent reverse proxy with a stable domain or a
persistently hosted copy of the metadata route is required. IPFS HTTPS gateways
can host the image; this implementation does not upload metadata to IPFS.
Quick Tunnel and known temporary ngrok/loca.lt URLs are rejected for Core.
URL validation cannot prove that an operator will keep a host running.

The worker checks unauthenticated metadata and image GETs before signing. It
requires the exact name/image, DEMO-NFT symbol and simulated-NFT label. Changing
environment configuration does not rewrite an already reserved Core order.
Fix hosting for its frozen URLs before retrying. Historical Token-2022 metadata
behavior is preserved.

Core verification reads the Core asset account, its owning program, recipient,
name and URI. It never uses an SPL associated token account. Delivery completion
is separate from Phantom visibility, which remains unverified.

## Isolated manual visibility test (not executed during implementation)

1. Use a separate test MongoDB database, dedicated Devnet agent, new test wallet,
   and new test order. Do not copy or operate on the delivered Bodega order.
   Keep `DEVNET_DELIVERY_LIVE_ENABLED=false` while setting up.
2. Configure durable metadata hosting and a demo PNG. Check unauthenticated GET
   responses: JSON 200, image 200 with image/png, and the absolute HTTPS image
   URL in JSON. Ensure metadata clearly says GoBuy DEMO, not the original NFT.
3. Obtain explicit authorization for the isolated Devnet test and its fees.
   Fund only the test agent/vault with Devnet SOL. Only then permit delivery in
   this isolated environment; never enable the worker against the real database.
4. Use the normal purchase flow once. Record its payment, immutable Core plan,
   asset address and delivery signature. Verify confirmed transaction status,
   Core program ownership, asset owner, name and URI through Devnet RPC.
5. Connect the exact recipient in Phantom Testnet Mode with Solana Devnet.
   Record Phantom version, time, refresh result and hidden/spam view result.
   Report visibility as PASS only when the collectible is actually displayed;
   otherwise UNKNOWN/FAIL for visibility even if on-chain ownership is verified.
6. Disable live delivery again. Preserve the signed attempt and completion for
   audit. Do not retry by creating another order or asset just to force indexing.

Core improves NFT-standard compatibility; Phantom Devnet indexing/display is
not guaranteed. No test here authorizes a transaction in the existing database.
