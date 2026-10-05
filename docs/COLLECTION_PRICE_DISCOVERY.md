# Collection price discovery

Requests such as “Mua NFT rẻ nhất của collection y00ts” can search without a SOL budget. The intent carries `priceDiscoveryOnly: true`; its numeric search ceiling is never spending authority. The quote endpoint rejects this intent until the user provides an explicit maximum. Lowest-price ranking compares integer listing prices, and collection resolution remains provider-scoped: no substitution for a missing collection and no claim of global cheapest.

The UI compares the discovered listing price with the current signed policy's per-transaction, remaining total and remaining UTC daily limits. If the price alone exceeds the remaining allowance it asks whether the user wants to increase limits. The user must open the spending panel, review the new limits and sign with Phantom. Chat agreement does not mutate policy. Backend reservations also explain limit failures and require a newly signed policy; rejected reservations leave limits and counters unchanged.

Listing prices exclude fees. No invented 0.01 SOL buffer or simulated total is presented as a real quote. A budget-only follow-up preserves collection and clears the discovery-only flag without excluding the original cheapest NFT. Execution still revalidates policy and price.

Existing blockers remain: independent Devnet NFT verification has no integrated production source and the on-chain autonomous vault is not deployed. Finding a price or signing a higher policy does not bypass either blocker. This change does not enable autonomous execution.
