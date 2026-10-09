# Tensor CPI verification and safe SBF build

Status: the CPI implementation was reviewed account by account and audited against the installed
official Tensor SDK. One real compile error was found and fixed. The Anchor program has **not**
been compiled for the SBF target and **no** CPI has been executed. Nothing was deployed, no wallet
was used, no SOL was spent and no private key was read or exported.

| Claim | State |
| --- | --- |
| Tensor `payer` (BuyLegacy account 7) is the Vault PDA | verified (source + official SDK) |
| Tensor `buyer` (account 1) is `mandate.owner` | verified |
| The agent signs the outer transaction; the Vault signs the CPI | verified |
| The NFT is delivered to the owner's ATA | verified |
| Tensor BuyLegacy account order matches the official SDK | verified (24/24, installed SDK) |
| Tensor program id and discriminator are the real ones | verified |
| PDAs and seeds are unchanged | verified (no seed or `declare_id!` change) |
| The Rust program type-checks against anchor-lang 1.2.0 | partially: rule modules only (see below) |
| The Rust program compiles to SBF | **not verified** |
| A CPI succeeds on a validator or Devnet | **not verified, and not claimed** |

---

## CPI_PAYER_VERIFICATION

### The question

Does the genuine purchase pay Tensor from the Na Vault PDA, or does it accidentally reach the
user's Phantom wallet?

### The answer: the Vault PDA pays. The wallet is not in the instruction at all.

BuyLegacy's `payer` is account index **7**. In `nft_purchase_rules.rs`:

```rust
pub const IX_PAYER: usize = 7;
```

and in `nft_purchase.rs`, `buy_nft_from_mandate` builds the expectations it will enforce:

```rust
let expectations = rules::TensorAccountExpectations {
    payer: vault_key.to_bytes(),          // <- the Vault PDA
    buyer: owner_key.to_bytes(),          // <- mandate.owner
    buyer_token_account: buyer_token_account.to_bytes(),
    mint: expected_mint.to_bytes(),
    list_state: listing.to_bytes(),
};
rules::check_tensor_accounts(&keys, &expectations)?;
```

and `check_tensor_accounts` in `nft_purchase_rules.rs` refuses anything else:

```rust
if keys[IX_PAYER] != expected.payer {
    return Err(PurchaseRejection::InvalidTensorAccounts);
}
if keys[IX_BUYER] != expected.buyer {
    return Err(PurchaseRejection::InvalidBuyer);
}
if keys[IX_BUYER_TA] != expected.buyer_token_account {
    return Err(PurchaseRejection::InvalidBuyerTokenAccount);
}
if keys[IX_MINT] != expected.mint || keys[IX_LIST_STATE] != expected.list_state {
    return Err(PurchaseRejection::InvalidListing);
}
```

`vault_key` comes from `ctx.accounts.vault.key()`, and the accounts struct binds that account to
the mandate's own vault PDA:

```rust
#[account(mut, seeds = [VAULT_SEED, mandate.key().as_ref()], bump = mandate.vault_bump)]
pub vault: UncheckedAccount<'info>,
```

So the only account that may occupy slot 7 is `["vault", mandate]` — the same PDA the existing
settlement path funds and spends from. It can never be a Phantom wallet, and it is a different
account from the buyer at slot 1 (`mandate.owner`).

### The Vault signs the CPI

`payer` is the only account the program marks as a signer, and the Vault seeds are the only signer
seeds handed to `invoke_signed`:

```rust
for (index, account) in remaining.iter().take(rules::BUY_LEGACY_ACCOUNTS).enumerate() {
    let is_signer = index == rules::IX_PAYER;      // only slot 7
    if account.is_writable {
        metas.push(AccountMeta::new(*account.key, is_signer));
    } else {
        metas.push(AccountMeta::new_readonly(*account.key, is_signer));
    }
}
...
let vault_seeds: &[&[u8]] = &[VAULT_SEED, mandate_key.as_ref(), &[vault_bump]];
invoke_signed(&instruction, account_infos, &[vault_seeds])?;
```

The client deliberately passes every Tensor account as a non-signer, which is the correct shape: a
PDA cannot sign the outer transaction, so `gobuy_na` re-marks slot 7 as a signer inside the CPI
with the Vault seeds.

### The agent signs the outer transaction, not the wallet

```rust
#[account(mut, address = mandate.executor @ NaError::InvalidOwner)]
pub executor: Signer<'info>,
```

`executor` is the only `Signer` in `BuyNftFromMandate` and must equal `mandate.executor`. The
mandate owner's wallet appears only as a public key (`mandate.owner`), never as a signer.

### The NFT goes to the owner's associated token account

Slot 2 (`buyerTa`) is pinned to the classic associated token account of the owner for the exact
mint, derived on chain:

```rust
pub fn associated_token_address(owner: &Pubkey, mint: &Pubkey) -> Result<Pubkey> {
    Ok(Pubkey::find_program_address(
        &[owner.as_ref(), token_program_id().as_ref(), mint.as_ref()],
        &associated_token_program_id(),
    ).0)
}
```

The postcondition re-reads that account after the CPI and requires exactly one unit of the expected
mint owned by the buyer:

```rust
let delivered = {
    let data = ctx.remaining_accounts[rules::IX_BUYER_TA].try_borrow_data()?;
    rules::TokenAccountState::parse(&data)
};
rules::check_delivery(delivered, &expectations)?;
```

### Cross-checked against the installed official SDK

`@tensor-foundation/marketplace@1.0.0` is installed in this repo. Its generated client declares
BuyLegacy's account list and roles, and the runtime resolves a signer only when an account is
supplied as a `TransactionSigner`:

```js
function getAccountMetaFactory(programAddress, optionalAccountStrategy) {
  return (account) => {
    if (!account.value) {
      return Object.freeze({ address: programAddress, role: AccountRole.READONLY });
    }
    const writableRole = account.isWritable ? AccountRole.WRITABLE : AccountRole.READONLY;
    return Object.freeze({
      address: expectAddress(account.value),
      role: isTransactionSigner(account.value) ? upgradeRoleToSigner(writableRole) : writableRole,
      ...
```

Among the 24 BuyLegacy accounts, `payer` is the only `WritableSignerAccount`. Absent optional
accounts become the marketplace program id itself, read-only and not a signer — which is exactly
what the client sends and what the Rust `is_signer = index == IX_PAYER` reproduces.

**Conclusion: the CPI payer is the Vault PDA, and no code change was needed for the payer.** The
real defect found in this step was unrelated to the payer (see RUST_COMPATIBILITY).
---

## RUST_COMPATIBILITY

### Declared versions agree with each other

| Place | Version |
| --- | --- |
| `anchor/programs/gobuy_na/Cargo.toml` | `anchor-lang = "=1.2.0"` |
| `anchor/Cargo.lock` | `anchor-lang 1.2.0` plus the whole `anchor-* 1.2.0` family |
| `anchor/Anchor.toml` | `anchor_version = "1.2.0"` |
| `frontend/package.json` | `@anchor-lang/core 1.2.0` |

`anchor-lang` 1.2.0 declares `edition = "2021"` and `rust-version = "1.89"`. The Rust toolchain on
this machine is `rustc 1.98.1`, which satisfies that minimum. The lock also pins
`borsh 1.8.1`, `bytemuck 1.25.2` and `anchor-lang-idl 0.1.4`.

### The Solana imports resolve

The lock contains **no `solana-program` crate at all** — Anchor 1.2.0 was built on the modular
Solana 3.x crates. Every Solana path used by `nft_purchase.rs` still resolves, because
`anchor-lang 1.2.0` re-exports them:

```rust
pub mod solana_program {
    pub use { solana_account_info as account_info, solana_clock as clock, ... };
    pub mod instruction { pub use solana_instruction::*; }          // AccountMeta, Instruction
    pub mod program {
        pub use { solana_cpi::*, solana_invoke::{invoke, invoke_signed, ...} };
    }
    pub mod rent { pub use solana_sysvar::rent::*; }
}
```

and `system_program.rs` provides both `pub fn transfer` and `pub struct Transfer`. `Clock` and
`Rent` are exported by `anchor_lang::prelude` (lines 594 and 598 of `anchor-lang/src/lib.rs`), so
`Clock::get()?` and `Rent::get()?` resolve. `anchor_lang::system_program::{transfer, Transfer}`
resolves too.

### The defect found and fixed

`anchor/programs/gobuy_na/src/nft_purchase_rules.rs` returns `alloc::vec::Vec<u8>`:

```rust
pub fn buy_legacy_data(max_price_lamports: u64) -> alloc::vec::Vec<u8> {
    let mut data = alloc::vec::Vec::with_capacity(18);
```

`alloc` is **not** part of the Rust extern prelude — unlike `core` and `std`, which are. Nothing in
the crate declared it, and `anchor-lang` does not re-export it into its consumers' scope. The
compiler confirmed it:

```
error[E0433]: cannot find module or crate `alloc` in this scope
   --> nft_purchase_rules.rs:179:52
    = help: add `extern crate alloc` to use the `alloc` crate
```

This is a genuine compile error that would have failed the SBF build. It was fixed with one line in
the crate root:

```rust
// `alloc` is not part of the Rust extern prelude (`core` and `std` are), yet the pure rule
// modules return `alloc::vec::Vec<u8>` for instruction data. Declaring the crate once here puts
// the `alloc` path in scope for every module of this program.
extern crate alloc;
```

`extern crate alloc;` is valid whether or not `std` is linked, so it is safe on the SBF target. The
fix does not touch `declare_id!`, any seed, any account layout or any error code.

### Toolchain required for the SBF build

The Anchor 1.2.0 CLI depends on `solana-cli-config ^3.0.14`, `solana-client ^3.0.14`,
`solana-rpc-client ^3.0.14` and `solana-sbpf ^0.13.1`. The matching release line is **Agave
(Solana) CLI v3.0.14**, which is what the CI workflow pins. A 2.x Solana CLI would not match the
program's dependency graph or the SBF std it was linked against.

### What is not verified

The rule modules type-check, but the crate as a whole has **not** been compiled: the `#[program]`
macro expansion, the `Accounts` derives and the `idl-build` path are only exercised by a real
`cargo build-sbf`, which needs the SBF platform-tools that are not installed here. Do not read the
rule-module type-check as a successful program build.

---

## SECURITY_REVIEW

### The purchase path, check by check

| Check | Where | What it enforces |
| --- | --- | --- |
| Order identity | `order_id_is_valid` | an all-zero 16-byte order id is refused |
| Price floor | `require!(max_price_lamports > 0)` | no zero-price purchase |
| Mandate active | `require!(mandate_active && !mandate_closed)` | a cancelled or closed mandate cannot buy |
| Mandate expiry | `mandate_rules::is_expired` | an expired mandate cannot buy |
| Mandate category | `category_allowed(allowed_category, CATEGORY_NFT)` | a non-NFT mandate cannot buy |
| Executor identity | `require_keys_eq!(executor, mandate.executor)` plus the `address = mandate.executor` constraint | only the owner-chosen agent may drive the purchase |
| Authorization version | `policy.version == PURCHASE_AUTH_VERSION` | a future layout is never reinterpreted |
| Authorization active | `PurchaseRejection::AuthorizationNotActive` | revocation closes the only path |
| Authorization binding | mandate, owner, executor, marketplace, and `recipient == owner` | the approval cannot be replayed across mandates, wallets, agents or marketplaces |
| Authorization expiry | `now > policy.expires_at` | time-boxed |
| Authorization budget | `authorization_remaining(policy)` | per-approval ceiling |
| Mandate budget and vault balance | `mandate_rules::authorize_spend` | never exceeds `max_budget_lamports − spent_lamports`, and never dips below the rent floor |
| Listing validation | `list_state_address(&expected_mint)` | the list state must be the canonical `["list_state", mint]` PDA of the requested mint |
| Mint validation | `check_tensor_accounts` | `keys[IX_MINT]` must equal the requested mint and `keys[IX_LIST_STATE]` its canonical PDA |
| Marketplace validation | `check_tensor_accounts` | `keys[IX_MARKETPLACE_PROGRAM]` must be the fixed Tensor program id |
| Token standard | `check_tensor_accounts` | `keys[IX_TOKEN_PROGRAM]` must be the classic SPL Token program |
| Payer validation | `check_tensor_accounts` | `keys[IX_PAYER]` must be the mandate's Vault PDA |
| Buyer validation | `check_tensor_accounts` | `keys[IX_BUYER]` must be `mandate.owner` and `keys[IX_BUYER_TA]` its ATA for the mint |
| Fee-vault separation | `check_tensor_accounts` | the fee vault may never be the payer or the recipient |
| Replay protection | `init` on `["purchase", mandate, order_id]` | one receipt per order forever; `init`, never `init_if_needed` |
| Atomicity | `init` receipt + post-CPI `require!`s | any failure reverts the receipt, both `spent_lamports` updates and the whole CPI |
| Debit measurement | `vault_before − vault_after` in `settle_debits` | the real debit is measured, not assumed |
| Debit ceiling | `max_allowed_debit` = price + 5% + 5,000,000 lamports | the treasury pays at most the listing price plus bounded overhead |
| Debit floor | `total_debit < price` → `InvalidPrice` | a purchase that debits less than the authorized price aborts |
| Delivery | `check_delivery` | after the CPI the ATA must hold exactly one unit of the expected mint owned by the buyer |
| Receipt integrity | `NftPurchaseReceipt` written only after every postcondition passes | history is only recorded for a purchase that provably happened |

### Answers to the specific questions

*Mandate authorization.* A settlement mandate is deliberately **not** treated as permission to buy
from arbitrary sellers. `buy_nft_from_mandate` requires a separate owner-signed
`NftPurchaseAuthorization` PDA at `["nft-auth", mandate]` that names the marketplace, executor,
recipient and a total debit ceiling, and is bounded by the mandate's own remaining budget at
creation time. A mandate with no such account cannot reach the purchase instruction at all.

*Total spending limits.* Two independent budgets are enforced before the CPI (`authorize_purchase`
for the authorization, `authorize_spend` for the mandate) and both are re-checked against the
measured debit after it. `settle_debits` fails closed on overflow rather than wrapping.

*Listing and mint validation.* The mint is an instruction argument and its canonical Tensor list
state is derived on chain; the supplied accounts must match both. A listing for any other mint is
refused.

*Order replay protection.* The receipt PDA is keyed by `(mandate, order_id)` and created with
`init`, so the same order can never settle twice — and because the receipt is inside the same
transaction as the CPI, a failed CPI cannot leave a receipt behind.

*Atomic delivery verification.* `check_delivery` reads the buyer's token account after the CPI and
requires mint, owner and `amount == 1` to be exactly right. Anything else aborts the transaction,
which is why the error message tells the user that no SOL was taken: it is literally true.

### Residual findings and hardening recommendations

None of these is a live vulnerability; they are listed so the next reviewer does not have to
rediscover them.

1. **`check_tensor_accounts` pins only a subset of the 24 slots.** It pins the fee vault, the
   marketplace, token and ATA programs, the payer, the buyer, the buyer's ATA, the mint and the
   list state. It does not pin `listTa` (3), the seller (6), `rentDestination` (10), `metadata`
   (15), `edition` (16), the two token records (17, 18) or the authorization-rules slots (19–22).
   Those are left to Tensor's own validation. The blast radius is contained: the payer is pinned,
   so only the vault can pay; the buyer's ATA is pinned to the owner, so the NFT cannot be
   redirected; the mint and list state are pinned, so a different asset cannot be bought.
   Recommendation: pin `listTa`, the seller, `rentDestination`, `metadata` and `edition` as well,
   for defence in depth.

2. **CPI writability is taken from the caller's account infos, not a fixed table.** The `metas`
   loop calls `AccountMeta::new(...)` only when `account.is_writable`. That can only *reduce*
   privilege relative to the outer transaction, so it cannot escalate; the worst case is a
   guaranteed failure because a required writable account was declared read-only. No funds are at
   risk. Recommendation: leave as is, or validate writability against the reviewed table for
   clearer failures.

3. **`receipt.price_lamports` records the authorized ceiling, not the settled listing price.**
   `total_debit_lamports` records the real debit. The pairing is fail-closed in both directions: if
   the ceiling is above the true listing price, the debit falls below it and `settle_debits`
   rejects with `InvalidPrice`; if it is below, Tensor's own `maxAmount` cap rejects the CPI. The
   ceiling can therefore only ever be equal to the listing price for a purchase that succeeds.
   Recommendation: rename the field (or document it) so the receipt is not read as the listing
   price.

4. **`let _ = verdict;`** discards the `spent_after` returned by `authorize_spend` and recomputes
   it later from the measured debit. That is deliberate and correct — the returned value is
   pre-CPI and would be wrong — but it reads like a dropped result. Recommendation: comment it.

5. **Readability nit:** `TokenAccountState::parse` does not verify the account is owned by the SPL
   Token program. It does not need to, because `buyerTa` is pinned to the derived ATA and the
   fields read are mint, owner and amount. Worth a short comment so a future reader does not add an
   unnecessary owner check or, worse, remove the address pin believing the parse is the guard.

### Guardrails respected

No deployment, no upgrade, no live purchase, no SOL spent, no private key read or exported, no PDA
or seed changed, no live worker enabled, no demo minting. `declare_id!` still reads
`CHjdqooB7TrussJoZoboFP5TtdCspoHtvPpqoshbr5zE` and the CI pins that value when verifying the
artifact.
---

## BUILD_ENVIRONMENT

### What is available on this machine

| Tool | State |
| --- | --- |
| `cargo` / `rustc` / `rustup` | present, `1.98.1` (satisfies the 1.89 MSRV) |
| `node` / `npm` | present |
| `solana` (Agave CLI) | **absent** |
| `anchor` (Anchor CLI) | **absent** |
| MSVC linker (`link.exe`) | **absent** |
| MinGW (`gcc`, `ld`) | **absent** |
| Visual Studio / Build Tools | **not installed** (`vswhere` returns nothing) |
| Docker / Podman | **absent** |
| WSL | present, and deliberately not used |

### Why a host `cargo check` is impossible here

`cargo check` still has to build and link procedural-macro crates (`anchor-syn`,
`anchor-attribute-*`) as host executables, and that needs a C linker. This machine has none, so
the run fails before reaching this program's own code:

```
error: linker `link.exe` not found
note: the msvc targets depend on the msvc linker but `link.exe` was not found
```

The project's own `anchor/README.md` already documents this. Installing MSVC Build Tools or a
MinGW toolchain would be a large local installation and was avoided, as required.

### What *is* possible locally, and was used

`rustc --emit=metadata` performs full name resolution, macro expansion and type checking but never
links. That is enough to type-check the two pure rule modules, which contain every budget, expiry,
category, authorization and Tensor-account decision. It is wired up as:

```
npm run typecheck:anchor-rules
```

`anchor/host-typecheck/main.rs` mirrors the crate root (`extern crate alloc;`) and includes the two
rule modules through `#[path]`. This check found the `alloc` error and now passes with zero errors.
It is a fast guard, not a substitute for a real build.

### The chosen build environment

**GitHub Actions, `ubuntu-latest`, via the new `.github/workflows/anchor-ci.yml`.** It is a real
Linux runner with a linker and the SBF platform-tools, it needs no WSL and no large local install,
and it matches what the task prefers.

Pinned versions, each derived rather than guessed:

| Pin | Value | Why |
| --- | --- | --- |
| Rust toolchain | `1.89.0` | `anchor-lang 1.2.0` declares `rust-version = "1.89"` |
| Agave (Solana) CLI | `v3.0.14` | the Anchor 1.2.0 CLI depends on `solana-cli-config ^3.0.14` |
| SBF platform-tools | `v1.52` | bundled Rust 1.89.0 supports Anchor's MSRV and edition 2024 |
| Node | runner default | the existing repo scripts |

The workflow:

* installs the pinned toolchain with `rustup` (no third-party action) and the Agave CLI from the
  official `https://release.anza.xyz/v3.0.14/install` endpoint;
* runs `node scripts/verify-tensor-constants.mjs`;
* installs platform-tools `v1.52` and logs host Rust/Cargo, builder version, selected tools and bundled Rust/Cargo;
* runs `cargo build-sbf --tools-version v1.52 --verbose --manifest-path anchor/programs/gobuy_na/Cargo.toml --sbf-out-dir anchor/target/deploy -- --locked`
  to compile the SBF bytecode;
* records the actual Cargo executable selected through rustup and checks that `anchor/Cargo.lock` is unchanged;
* verifies the compiled artifact still contains the existing program id bytes;
* records a SHA-256 of the artifact;
* **then** runs `cargo test --manifest-path anchor/Cargo.toml --all-targets --locked` (host unit tests);
* uploads `build-logs/**` and `anchor/target/deploy/*.so` as a 30-day artifact.

The SBF build deliberately runs *before* the host tests: the compiled artifact is the primary
deliverable, so a failing host test still leaves a `.so` and its logs to inspect. The artifact
upload step uses `if: always()` for the same reason.

### First CI failure: edition 2024

The first GitHub Actions run failed parsing `block-buffer-0.12.1/Cargo.toml` with Cargo
1.84.0. The host Rust 1.89.0 pin does not control SBF compilation:
[Agave v3.0.14's toolchain code](https://github.com/anza-xyz/agave/blob/v3.0.14/platform-tools-sdk/cargo-build-sbf/src/toolchain.rs)
defaults to platform-tools v1.51 (Rust 1.84.1) and links a separate rustup toolchain.
The builder invokes Cargo with that explicit toolchain override.

The workflow now uses the supported `--tools-version v1.52` override.
[The v1.52 release](https://github.com/anza-xyz/platform-tools/releases/tag/v1.52) supplies
Rust 1.89.0 / LLVM 20, meeting Anchor 1.2.0's minimum as well as edition 2024 support.
Exact bundled Cargo version and executable are recorded at runtime; the builder's
`--version` output still describes its default v1.51, not the selected override.
An explicit installation and executable check prevent silently continuing with an older fallback.
Host metadata is checked with `--locked` before SBF compilation, and both compilation and
host tests use `--locked`. No dependency versions or lockfile entries were changed.

This fix remains **unverified on GitHub Actions** until the updated workflow passes.
Program identity, PDA seeds, CPI, authorization, backend purchasing and completed orders
are unchanged. No deployment, wallet operation or transaction is part of this fix.

It has `permissions: contents: read`, **never** deploys, **never** upgrades, **never** signs a
transaction, and needs **no** wallet keypair, private key, RPC credential or repository secret. Only
official `actions/checkout` and `actions/upload-artifact` are used.

---

## FILES_CHANGED

| File | Change |
| --- | --- |
| `anchor/programs/gobuy_na/src/lib.rs` | **Fix.** Added `extern crate alloc;` so `alloc::vec::Vec<u8>` in the rule module resolves. Nothing else touched: no seed, no `declare_id!`, no account layout, no error code. |
| `.github/workflows/anchor-ci.yml` | **New.** Pinned, no-deploy, secret-free SBF build and test workflow. |
| `scripts/verify-tensor-constants.mjs` | **New.** Reusable cross-check of the Tensor constants across the Rust rules, the shared contract, the backend client layout and (when installed) the official SDK. |
| `scripts/verify-sbf-program-id.mjs` | **New.** Proves a compiled `.so` still carries the existing program id bytes. |
| `anchor/host-typecheck/main.rs` | **New.** Linker-free host type-check of the pure rule modules. |
| `package.json` | **New scripts.** `verify:tensor-constants` and `typecheck:anchor-rules`. |
| `docs/CPI_VERIFICATION.md` | **New.** This report. |

**No** change to: `declare_id!`, `Anchor.toml`'s program id, any PDA seed, any mandate or Vault
account, any completed order, any backend configuration, or any environment file.

---

## TEST_RESULTS

Everything below was executed on this machine. Nothing is inferred.

### Passed

| Check | Command | Result |
| --- | --- | --- |
| Tensor constant cross-check (Rust ↔ shared ↔ backend layout ↔ official SDK) | `node scripts/verify-tensor-constants.mjs` | **88 / 88 passed** |
| Rule-module type-check | `npm run typecheck:anchor-rules` | **0 errors** (57 dead-code warnings, expected in a call-free shim) |
| TypeScript lint, all five workspaces + test tsconfig | `npm run lint` | **exit 0** |
| Full test suite | `npm test` | **exit 0 — 354 tests, 354 pass, 0 fail, 0 cancelled, 0 skipped** |
| CI workflow parses and honours its safety invariants | one-off `node` check (deleted after use) | **28 / 28 passed** — valid YAML, 10 steps, pinned toolchains, build before tests, only official actions, and no deploy / upgrade / transfer / keypair / secret in any executable step |
| `scripts/verify-sbf-program-id.mjs` accepts only a genuine artifact | one-off `node` check (deleted after use) | **18 / 18 passed** — exits 0 on an ELF carrying the id (at offset 64 and at offset 4100), exits 1 on a wrong id / empty file / non-ELF / missing file, exits 2 on bad arguments or a non-32-byte id |

The suite independently corroborates the CPI review. These existing tests pass, and each one
asserts a property this report claims:

* `the purchase instruction puts the vault in the payer slot the program signs with invoke_signed`
* `the verified BuyLegacy shape is accepted and the vault loses signer privilege`
* `a swapped payer, changed price, short account list or extra payload is refused before signing`
* `the approval instruction matches the Anchor account order exactly`
* `live purchase execution is off unless explicitly enabled`
* `a new order can never fall back to the DEMO autonomous flow`
* `Tensor SDK instruction bridge preserves account roles and exact instruction bytes`

### Not run, and therefore not claimed

| Check | Why |
| --- | --- |
| `cargo test --manifest-path anchor/Cargo.toml` (host) | needs a linker, which this machine does not have |
| `cargo build-sbf` | needs the Agave CLI and SBF platform-tools, not installed |
| Any CPI against a validator or Devnet | out of scope by instruction, and it needs the built program |
| The GitHub Actions workflow itself | it has not been pushed or triggered yet |

**No CPI execution has been tested. No claim of a working purchase is made anywhere in this
report.** `cargo test` and `cargo build-sbf` still have to run on the Linux runner, and the workflow
is written so that its first run reports honestly.

---

## REMAINING_BLOCKERS

1. **The program has never been compiled.** This is the primary blocker and the reason for the
   workflow. The rule modules type-check, but the `#[program]` macro expansion, the `Accounts`
   derives and the IDL generation have never been exercised. The first CI run must be treated as
   the real compile check, and further errors are likely.
2. **No CPI has been executed.** Even a green SBF build only proves the program compiles; it proves
   nothing about the CPI executing successfully against Tensor's on-chain program.
3. **Local Rust builds are impossible on this machine.** No linker, no Solana toolchain. The
   linker-free metadata check is a partial substitute and covers only the pure modules.
4. **`solana-test-validator` with Tensor's Devnet program is not available.** A controlled CPI test
   needs either Tensor's program loaded into a local validator or a Devnet dry run, both out of
   scope here.
5. **Deployment provenance is still unverified.** The source has never been shown to match the
   binary at `CHjdqooB7TrussJoZoboFP5TtdCspoHtvPpqoshbr5zE`. A successful build of this source
   does not establish that equivalence, and the workflow deliberately cannot deploy or upgrade.
6. **Optional hardening not applied.** The `check_tensor_accounts` coverage gap and the
   `receipt.price_lamports` naming described in SECURITY_REVIEW are recorded but intentionally not
   changed, because altering account validation without a build to test it would be riskier than
   documenting it first.

---

## NEXT_STEPS

Ordered so that each step is only taken once the previous one has actually passed.

1. **Push the workflow and run it.** Confirm `cargo test` passes on Linux, then fix whatever
   `cargo build-sbf` reports. Expect more compile errors than the one `alloc` defect that a
   linker-free check could find.
2. **Read the uploaded artifact and logs.** Confirm `gobuy_na.so` is produced, that
   `verify-sbf-program-id.mjs` passes, and record the SHA-256.
3. **Add the Rust unit tests to the local loop if a linker ever becomes available.** Until then,
   treat CI as the only place the rule tests genuinely execute.
4. **Then, and only then, test the CPI against a controlled validator** — Tensor's program loaded
   locally, or a Devnet simulation with a wallet the operator controls — against a listing that is
   public, SOL-priced, unexpired and cosigner-free. Verify the vault debit and the NFT arriving in
   the owner's ATA before enabling anything live.
5. **Consider the hardening items** in SECURITY_REVIEW, with the build in place and a validator
   available to test the changes.
6. **Resolve deployment provenance separately.** Recover the original source commit, toolchain and
   deployment record for the existing Devnet program before any upgrade is even considered.

Until step 4 succeeds, live worker enablement, live purchases and demo minting all stay off.
