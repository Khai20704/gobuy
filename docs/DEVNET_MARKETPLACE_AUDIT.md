# Original NFT Devnet marketplace audit

Observed: 2026-10-09T12:12:27.157Z; starting slot 509174636; genesis EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG.

RESULT: Five real Tensor Devnet listings passed unsigned BuyLegacy simulation. The current autonomous Vault payment path does NOT purchase them. The separate Tensor executor requires the purchaser wallet signature and pays from that wallet. No transactions were signed or submitted. No application/order data was changed.

Scanned 552 ListState accounts; 223 met public SOL/expiry/price filters. 214 lacked matching Metaplex metadata and 1 were excluded by standard checks. Missing metadata may include other asset standards, not necessarily invalid listings. Five cheapest supported results were examined. This is not a liquidity census of all Solana marketplaces.

Program deployment (live getAccountInfo, executable=true):

- TCMPhJdwDryooaGtiocG1u3xcYbRpiJzb283XfCZsDp: executable=true; owner=BPFLoaderUpgradeab1e11111111111111111111111
- TAMM6ub33ij1mbetoMyVBLeKY5iP41i4UPUJQGkhfsg: executable=true; owner=BPFLoaderUpgradeab1e11111111111111111111111
- TSWAPaqyCSx2KABk68Shruf4rp7CxcNi8hAsbdwmHbN: executable=true; owner=BPFLoaderUpgradeab1e11111111111111111111111

Only TCOMP Marketplace BuyLegacy is integrated for real purchases. TAMM purchase instructions are not integrated. TSWAP is documented as shared escrow, not the current listing venue. Magic Eden and Tensor Mainnet adapters are read-only Mainnet discovery and were excluded; the mock adapter is excluded. Devnet deployment of other venues was not established.

All five below are DISCOVERABLE, LISTED and EXECUTABLE in unsigned simulation as the specified purchaser. EXECUTABLE is time-dependent, not a guarantee of future confirmation or Na Vault authorization. Token standard is classic SPL Token with Metaplex NonFungible metadata, supply=1, decimals=0. Listing custody held one NFT; simulation output held one original mint in recipient 9dJL3iVoECg6yaAeCoF3wKBPbkJkQE1WEucKm2fZUcAE.

## Bodega Monke #5

- Mint: 76REGf6ukL6Soer1D6TkvAnf6bXejEiFhvaNa2RaT1er
- Listing: 6fadBjikjQpzRHGcQJnvPHZ6wAyFZuR9tQntRT9rhJdn
- Seller: GAP7adkjSA7tA4T3GRjavr8jzCPsTtJuyHfxH95m2Hs3
- Price: 0.04 Devnet SOL (excludes fees/rent)
- Program: TCMPhJdwDryooaGtiocG1u3xcYbRpiJzb283XfCZsDp
- Standard: NonFungible / classic SPL Token
- Metadata: 5fP9vBjf6T7cvRTE9ef4LkZZbwzfnjRzHPaQ2zkbK1q
- Simulation: err=null, compute units=79467, recipient amount=1

## PMM Buy Test Monke

- Mint: 8819YvyKCSWidbudUQeAMPxH34Ga1z4Y2CUeiv6aNTUp
- Listing: 6q9bQC7DeGA6ZV7Zbo8T2nJsdZjenf25N2WjEnEq3Arf
- Seller: GAP7adkjSA7tA4T3GRjavr8jzCPsTtJuyHfxH95m2Hs3
- Price: 0.04 Devnet SOL (excludes fees/rent)
- Program: TCMPhJdwDryooaGtiocG1u3xcYbRpiJzb283XfCZsDp
- Standard: NonFungible / classic SPL Token
- Metadata: GWhxALkrwZFt7pUWApHrmatjbSCEG7yjAT6huNoYFTgZ
- Simulation: err=null, compute units=77967, recipient amount=1

## Bus Stop Monke #4

- Mint: 8DCtuAaLqNqvxo27bb6Vd1vSo4vBED99BmJU5qLLgdvR
- Listing: CyRrNfTeXJfK6rjcThEF3gyYDBQAPYinkowFU4aYcRT
- Seller: GAP7adkjSA7tA4T3GRjavr8jzCPsTtJuyHfxH95m2Hs3
- Price: 0.04 Devnet SOL (excludes fees/rent)
- Program: TCMPhJdwDryooaGtiocG1u3xcYbRpiJzb283XfCZsDp
- Standard: NonFungible / classic SPL Token
- Metadata: sDuQSLAdeHRrMEqFoXdaq53QYh4pzpaSUk7CU6AAyi9
- Simulation: err=null, compute units=83967, recipient amount=1

## Alley Cat Monke #10

- Mint: 9tNuYX5AActooMRRhZxXogbsxt9Mb4t99HmTiu6ccVs7
- Listing: 74NTHnFSUtNPjEaxpxPyvGSjrCiXocv8L2muQErzr696
- Seller: GAP7adkjSA7tA4T3GRjavr8jzCPsTtJuyHfxH95m2Hs3
- Price: 0.04 Devnet SOL (excludes fees/rent)
- Program: TCMPhJdwDryooaGtiocG1u3xcYbRpiJzb283XfCZsDp
- Standard: NonFungible / classic SPL Token
- Metadata: HGBPvGttX1aih4dihwh46hnorsCWBoqANVmyKCJuMNcS
- Simulation: err=null, compute units=71967, recipient amount=1

## Street Corner Monke #8

- Mint: B1LfPV5uKT16qcJsNWTrNcdbvQ67LUxYhbTcf8omW3fk
- Listing: 7HvbsVww1WH8g8SnogyQNXWWnQVgCGWs2mzANrDVKzAT
- Seller: GAP7adkjSA7tA4T3GRjavr8jzCPsTtJuyHfxH95m2Hs3
- Price: 0.04 Devnet SOL (excludes fees/rent)
- Program: TCMPhJdwDryooaGtiocG1u3xcYbRpiJzb283XfCZsDp
- Standard: NonFungible / classic SPL Token
- Metadata: BK5VQ6uhnP5JbgSFxdCE8o99B7bmsPtH4ajyqXjAkpQN
- Simulation: err=null, compute units=74967, recipient amount=1

## Limitations and next action

The audit constructed unsigned instructions directly with the existing adapter, not TensorDevnetExecutor.prepare (which persists a quote). It bypassed HTTP authentication, Helius discovery and UI selection; these end-to-end prerequisites were not tested. No agent secret key was read or used. sigVerify=false means simulation proves instruction execution and destination state, not authorization to spend a wallet. The built instruction requires the purchaser signature. Core/Token-2022/WNS marketplace purchases and AMM pools remain UNSUPPORTED by GoBuy.

The original Bodega listing still exists separately from the delivered GoBuy demo replacement. Its prior 0.04 SOL settlement payment is not a Tensor purchase receipt; this audit does not authorize paying again or modifying that order.

For a future original purchase, expose/use the existing wallet-signed Tensor flow with fresh listing and budget checks. To buy autonomously from a mandate, implement a separate reviewed marketplace execution path with enforced price, recipient, NFT identity and atomic exchange; the current settlement-and-demo flow cannot substitute for it. These are future changes, not executed in this audit.

Sources: https://dev.tensor.trade/docs/overview ; https://dev.tensor.trade/docs/program-changes ; https://github.com/tensor-foundation/marketplace . Raw RPC and simulation evidence: DEVNET_MARKETPLACE_AUDIT.json. NFT names are on-chain metadata, not proof of creator authenticity or Mainnet collection membership.
