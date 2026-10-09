# RWA chat settlement demo

This document describes the original payment-only flow. The current post-payment delivery,
quantity calculation, status model and runtime limitations are documented in
[Devnet asset delivery](DEVNET_ASSET_DELIVERY.md). New purchases now attempt delivery of
fractional, clearly labeled RWA test tokens; historical payment-only records are not automatically
assigned a fabricated quantity.

With a verified wallet on Devnet and an active RWA/ANY mandate, send:

`Tìm cho tôi một RWA công nghệ đáng mua trong khoảng 100 USD`

Na selects an already-approved candidate with a valid budget quote. USD wording uses USDC
as a reference; Jupiter's USDC-to-SOL quote determines the Devnet SOL demo amount. This is
not a fiat exchange or a mainnet purchase. Existing mandate rules enforce remaining budget,
category, expiry and vault balance. Missing conversion/approval/route must never invent a spend.

The chat automatically calls `/api/investment/rwa/chat-settle`. No manual settlement form or
test token minting is involved. `Chỉ tìm RWA công nghệ khoảng 100 USD` remains search-only.
Requests without budgets and conditional/quantity orders retain their existing behavior.

Selection, amount, owner and mandate instance are persisted before execution. Network retries
reuse the request ID and saved plan; the existing on-chain spend receipt prevents duplicate
settlement. The browser retains pending IDs across reloads. Use its check button after an
uncertain result rather than clearing browser storage and sending another request.

Confirmed replies say demo payment, not asset delivery. Request history stores the result and
signature; Vault history uses existing spend receipts/notes. Both panels refresh after a reply.
The agent pays fees and receipt rent; only the requested demo SOL amount leaves the vault.

No real RWA or synthetic SPL token is transferred. No Anchor, marketplace or deployment changes
are required. Tests use mocked market/execution responses; live Devnet settlement still needs
verification against the deployed agent and mandate.
