//! Linker-free host type-check of the pure Na Vault rule modules.
//!
//! The rule modules (`mandate_rules.rs`, `nft_purchase_rules.rs`) hold every budget, expiry,
//! category, authorization and Tensor-account decision the program makes, and they deliberately
//! avoid all Solana runtime types so the same logic is testable off chain. On a machine with no
//! C linker and no Solana toolchain this is the only way to type-check Rust locally:
//!
//! ```text
//! npm run typecheck:anchor-rules
//! ```
//!
//! `rustc --emit=metadata` performs full name resolution, macro expansion and type checking but
//! never links, so it needs neither `link.exe` nor the SBF platform-tools. It is a quick guard,
//! not a substitute for `cargo test` and `cargo build-sbf` on a Linux runner (see
//! `.github/workflows/anchor-ci.yml`).
//!
//! The two declarations below mirror the crate root in `programs/gobuy_na/src/lib.rs`: `alloc`
//! is not in the Rust extern prelude, so the crate root declares it for the rule modules that
//! return `alloc::vec::Vec<u8>`.
#![allow(unexpected_cfgs)]
#![allow(dead_code)]

extern crate alloc;

#[path = "../programs/gobuy_na/src/mandate_rules.rs"]
mod mandate_rules;

#[path = "../programs/gobuy_na/src/nft_purchase_rules.rs"]
mod nft_purchase_rules;

fn main() {}
