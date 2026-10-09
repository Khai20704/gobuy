//! Pure Na Vault rules for a genuine Tensor BuyLegacy purchase.
//!
//! These functions hold every decision the CPI purchase must pass: authorization validity, the
//! versioned policy limits, the fixed Tensor BuyLegacy account mapping, the price bound and the
//! SPL token postcondition. They are deliberately free of Solana runtime types so the same logic
//! can be unit tested on the host, mirrored by `shared/src/nftPurchaseAuthorization.ts`, and
//! reused by the Anchor handler.
//!
//! Every constant below was decoded from the installed, official SDK
//! `@tensor-foundation/marketplace@1.0.0` (`buyLegacy.d.ts` and a live account dump), not guessed:
//! the discriminator, the 24-account order, the writable/signer roles, the `["list_state", mint]`
//! PDA seeds, and the associated-token-account derivation.

/// Account layout version of `NftPurchaseAuthorization`. A different version is refused.
pub const PURCHASE_AUTH_VERSION: u8 = 1;
/// Account layout version of `NftPurchaseReceipt`.
pub const PURCHASE_RECEIPT_VERSION: u8 = 1;

/// Fixed Devnet Tensor Marketplace program id (`TCMPhJdwDryooaGtiocG1u3xcYbRpiJzb283XfCZsDp`).
pub const TENSOR_MARKETPLACE_PROGRAM: [u8; 32] = [
    6, 181, 239, 177, 117, 215, 128, 52, 108, 24, 250, 97, 245, 136, 25, 14, 89, 129, 196, 102,
    141, 101, 29, 103, 173, 115, 195, 110, 49, 24, 15, 223,
];
/// Classic SPL Token program id.
pub const SPL_TOKEN_PROGRAM: [u8; 32] = [
    6, 221, 246, 225, 215, 101, 161, 147, 217, 203, 225, 70, 206, 235, 121, 172, 28, 180, 133, 237,
    95, 91, 55, 145, 58, 140, 245, 133, 126, 255, 0, 169,
];
/// SPL Associated Token Account program id.
pub const ASSOCIATED_TOKEN_PROGRAM: [u8; 32] = [
    140, 151, 37, 143, 78, 36, 137, 241, 187, 61, 16, 41, 20, 142, 13, 131, 11, 90, 19, 153, 218,
    255, 16, 132, 4, 142, 123, 216, 219, 233, 248, 89,
];
/// Metaplex Token Metadata program id.
pub const TOKEN_METADATA_PROGRAM: [u8; 32] = [
    11, 112, 101, 177, 227, 209, 124, 69, 56, 157, 82, 127, 107, 4, 195, 205, 88, 184, 108, 115, 26,
    160, 253, 181, 73, 182, 209, 188, 3, 248, 41, 70,
];

/// Tensor ListState PDA seed: `["list_state", mint]` under the marketplace program.
pub const LIST_STATE_SEED: &[u8] = b"list_state";
/// Seeds for the versioned purchase authorization: `["nft-auth", mandate]`.
pub const NFT_AUTH_SEED: &[u8] = b"nft-auth";
/// Seeds for one immutable purchase receipt: `["purchase", mandate, order_id]`.
pub const PURCHASE_SEED: &[u8] = b"purchase";

/// `sha256("global:buy_legacy")[..8]` as produced by the official SDK.
pub const BUY_LEGACY_DISCRIMINATOR: [u8; 8] = [0x44, 0x7f, 0x2b, 0x08, 0xd4, 0x1f, 0xf9, 0x72];

/// The BuyLegacy instruction always carries exactly this many accounts; absent optionals are
/// represented by the marketplace program id itself (Tensor's own sentinel).
pub const BUY_LEGACY_ACCOUNTS: usize = 24;

pub const IX_FEE_VAULT: usize = 0;
pub const IX_BUYER: usize = 1;
pub const IX_BUYER_TA: usize = 2;
pub const IX_LIST_TA: usize = 3;
pub const IX_LIST_STATE: usize = 4;
pub const IX_MINT: usize = 5;
pub const IX_SELLER: usize = 6;
pub const IX_PAYER: usize = 7;
pub const IX_RENT_DESTINATION: usize = 10;
pub const IX_TOKEN_PROGRAM: usize = 11;
pub const IX_ASSOCIATED_TOKEN_PROGRAM: usize = 12;
pub const IX_MARKETPLACE_PROGRAM: usize = 13;
pub const IX_SYSTEM_PROGRAM: usize = 14;

/// Absorbs marketplace/broker fees on top of the listing price: 5% plus a fixed lamport floor
/// that covers associated-account rent the vault may create.
pub const PURCHASE_OVERHEAD_BPS: u64 = 500;
pub const PURCHASE_OVERHEAD_LAMPORTS: u64 = 5_000_000;
pub const BPS_DENOMINATOR: u64 = 10_000;

/// Reason a genuine purchase was refused. Codes are appended after the settlement rejections so
/// the existing `NaError` numbering and the shared TS union stay stable.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PurchaseRejection {
    AuthorizationNotActive,
    AuthorizationExpired,
    AuthorizationMismatch,
    AuthorizationBudgetExceeded,
    InvalidPurchaseOrder,
    InvalidListing,
    InvalidMarketplaceProgram,
    InvalidBuyer,
    InvalidBuyerTokenAccount,
    InvalidTensorAccounts,
    InvalidPrice,
    PurchaseNotDelivered,
    VaultDebitExceeded,
    UnsupportedTokenStandard,
}

impl PurchaseRejection {
    /// Stable code, mirroring the `NaError` variant order appended in `lib.rs`.
    pub const fn code(self) -> u8 {
        match self {
            PurchaseRejection::AuthorizationNotActive => 12,
            PurchaseRejection::AuthorizationExpired => 13,
            PurchaseRejection::AuthorizationMismatch => 14,
            PurchaseRejection::AuthorizationBudgetExceeded => 15,
            PurchaseRejection::InvalidPurchaseOrder => 16,
            PurchaseRejection::InvalidListing => 17,
            PurchaseRejection::InvalidMarketplaceProgram => 18,
            PurchaseRejection::InvalidBuyer => 19,
            PurchaseRejection::InvalidBuyerTokenAccount => 20,
            PurchaseRejection::InvalidTensorAccounts => 21,
            PurchaseRejection::InvalidPrice => 22,
            PurchaseRejection::PurchaseNotDelivered => 23,
            PurchaseRejection::VaultDebitExceeded => 24,
            PurchaseRejection::UnsupportedTokenStandard => 25,
        }
    }
}

/// The versioned purchase policy, reduced to the fields the rules need.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PurchasePolicy {
    pub version: u8,
    pub active: bool,
    pub mandate: [u8; 32],
    pub owner: [u8; 32],
    pub executor: [u8; 32],
    pub marketplace: [u8; 32],
    pub recipient: [u8; 32],
    pub max_total_debit_lamports: u64,
    pub spent_lamports: u64,
    pub expires_at: i64,
}

/// What a specific order must resolve to on chain.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TensorAccountExpectations {
    pub payer: [u8; 32],
    pub buyer: [u8; 32],
    pub buyer_token_account: [u8; 32],
    pub mint: [u8; 32],
    pub list_state: [u8; 32],
}

/// Parsed classic SPL token account, only the fields the postcondition needs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TokenAccountState {
    pub mint: [u8; 32],
    pub owner: [u8; 32],
    pub amount: u64,
}

impl TokenAccountState {
    /// Reads the first 72 bytes of a classic SPL token account. Short data is rejected.
    pub fn parse(data: &[u8]) -> Option<TokenAccountState> {
        if data.len() < 72 {
            return None;
        }
        let mut mint = [0u8; 32];
        let mut owner = [0u8; 32];
        mint.copy_from_slice(&data[0..32]);
        owner.copy_from_slice(&data[32..64]);
        let mut amount = [0u8; 8];
        amount.copy_from_slice(&data[64..72]);
        Some(TokenAccountState { mint, owner, amount: u64::from_le_bytes(amount) })
    }
}

/// Remaining authorization budget, or `None` when the stored state is corrupt.
pub fn authorization_remaining(policy: &PurchasePolicy) -> Option<u64> {
    policy.max_total_debit_lamports.checked_sub(policy.spent_lamports)
}

/// Upper bound the vault may be debited for a listing of `price` lamports. Covers marketplace and
/// broker fees plus any associated-token-account rent the marketplace creates for the buyer.
pub fn max_allowed_debit(price: u64) -> Option<u64> {
    let fee = price.checked_mul(PURCHASE_OVERHEAD_BPS)?.checked_div(BPS_DENOMINATOR)?;
    price.checked_add(fee)?.checked_add(PURCHASE_OVERHEAD_LAMPORTS)
}

/// BuyLegacy instruction data for a public SOL listing: discriminator, `max_amount`, then both
/// options set to `None` (no royalty override, no authorization data / cosigner payload).
pub fn buy_legacy_data(max_price_lamports: u64) -> alloc::vec::Vec<u8> {
    let mut data = alloc::vec::Vec::with_capacity(18);
    data.extend_from_slice(&BUY_LEGACY_DISCRIMINATOR);
    data.extend_from_slice(&max_price_lamports.to_le_bytes());
    data.push(0);
    data.push(0);
    data
}

/// An order id of all zeros is never a valid identity.
pub fn order_id_is_valid(order_id: &[u8; 16]) -> bool {
    *order_id != [0u8; 16]
}

/// The versioned authorization must name this mandate, owner, executor, marketplace and recipient,
/// be active, unexpired, and still hold budget. Returns the remaining authorization budget.
pub fn authorize_purchase(
    policy: &PurchasePolicy,
    mandate: &[u8; 32],
    owner: &[u8; 32],
    executor: &[u8; 32],
    marketplace: &[u8; 32],
    now: i64,
) -> Result<u64, PurchaseRejection> {
    if policy.version != PURCHASE_AUTH_VERSION {
        return Err(PurchaseRejection::AuthorizationMismatch);
    }
    if !policy.active {
        return Err(PurchaseRejection::AuthorizationNotActive);
    }
    if policy.mandate != *mandate
        || policy.owner != *owner
        || policy.executor != *executor
        || policy.marketplace != *marketplace
        || policy.recipient != *owner
    {
        return Err(PurchaseRejection::AuthorizationMismatch);
    }
    if now > policy.expires_at {
        return Err(PurchaseRejection::AuthorizationExpired);
    }
    match authorization_remaining(policy) {
        Some(0) => Err(PurchaseRejection::AuthorizationBudgetExceeded),
        Some(remaining) => Ok(remaining),
        None => Err(PurchaseRejection::AuthorizationBudgetExceeded),
    }
}

/// Validates the fixed BuyLegacy account mapping passed through `remaining_accounts`. The two
/// payer/buyer identities are pinned to the vault PDA and the mandate owner, and the marketplace,
/// token, ATA and metadata programs must be the exact fixed ids.
pub fn check_tensor_accounts(
    keys: &[[u8; 32]],
    expected: &TensorAccountExpectations,
) -> Result<(), PurchaseRejection> {
    if keys.len() < BUY_LEGACY_ACCOUNTS {
        return Err(PurchaseRejection::InvalidTensorAccounts);
    }
    if keys[IX_MARKETPLACE_PROGRAM] != TENSOR_MARKETPLACE_PROGRAM {
        return Err(PurchaseRejection::InvalidMarketplaceProgram);
    }
    if keys[IX_TOKEN_PROGRAM] != SPL_TOKEN_PROGRAM {
        return Err(PurchaseRejection::UnsupportedTokenStandard);
    }
    if keys[IX_ASSOCIATED_TOKEN_PROGRAM] != ASSOCIATED_TOKEN_PROGRAM {
        return Err(PurchaseRejection::InvalidTensorAccounts);
    }
    if keys[IX_PAYER] != expected.payer {
        return Err(PurchaseRejection::InvalidTensorAccounts);
    }
    if keys[IX_BUYER] != expected.buyer {
        return Err(PurchaseRejection::InvalidBuyer);
    }
    if keys[IX_MINT] != expected.mint {
        return Err(PurchaseRejection::InvalidListing);
    }
    if keys[IX_LIST_STATE] != expected.list_state {
        return Err(PurchaseRejection::InvalidListing);
    }
    if keys[IX_BUYER_TA] != expected.buyer_token_account {
        return Err(PurchaseRejection::InvalidBuyerTokenAccount);
    }
    // The fee vault must never be the vault that pays or the wallet that receives the NFT.
    if keys[IX_FEE_VAULT] == expected.payer || keys[IX_FEE_VAULT] == expected.buyer {
        return Err(PurchaseRejection::InvalidTensorAccounts);
    }
    Ok(())
}

/// The two receipts (mandate debit and authorization debit) must both fit and be non-zero.
pub fn settle_debits(
    price: u64,
    total_debit: u64,
    authorization_remaining: u64,
    mandate_remaining: u64,
) -> Result<(), PurchaseRejection> {
    if total_debit < price || total_debit == 0 {
        return Err(PurchaseRejection::InvalidPrice);
    }
    let ceiling = match max_allowed_debit(price) {
        Some(ceiling) => ceiling,
        None => return Err(PurchaseRejection::VaultDebitExceeded),
    };
    if total_debit > ceiling {
        return Err(PurchaseRejection::VaultDebitExceeded);
    }
    if total_debit > authorization_remaining {
        return Err(PurchaseRejection::AuthorizationBudgetExceeded);
    }
    if total_debit > mandate_remaining {
        return Err(PurchaseRejection::VaultDebitExceeded);
    }
    Ok(())
}

/// The buyer's token account must hold exactly one unit of the expected mint, owned by the buyer.
pub fn check_delivery(
    account: Option<TokenAccountState>,
    expected: &TensorAccountExpectations,
) -> Result<(), PurchaseRejection> {
    let account = account.ok_or(PurchaseRejection::PurchaseNotDelivered)?;
    if account.mint != expected.mint || account.owner != expected.buyer || account.amount != 1 {
        return Err(PurchaseRejection::PurchaseNotDelivered);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const MANDATE: [u8; 32] = [1u8; 32];
    const OWNER: [u8; 32] = [2u8; 32];
    const EXECUTOR: [u8; 32] = [3u8; 32];
    const VAULT: [u8; 32] = [4u8; 32];
    const MINT: [u8; 32] = [5u8; 32];
    const LIST_STATE: [u8; 32] = [6u8; 32];
    const BUYER_TA: [u8; 32] = [7u8; 32];
    const FEE_VAULT: [u8; 32] = [8u8; 32];
    const PRICE: u64 = 40_000_000;
    const NOW: i64 = 1_700_000_000;

    fn policy() -> PurchasePolicy {
        PurchasePolicy {
            version: PURCHASE_AUTH_VERSION,
            active: true,
            mandate: MANDATE,
            owner: OWNER,
            executor: EXECUTOR,
            marketplace: TENSOR_MARKETPLACE_PROGRAM,
            recipient: OWNER,
            max_total_debit_lamports: 1_000_000_000,
            spent_lamports: 0,
            expires_at: NOW + 3600,
        }
    }

    fn keys() -> alloc::vec::Vec<[u8; 32]> {
        let mut keys = alloc::vec![[9u8; 32]; BUY_LEGACY_ACCOUNTS];
        keys[IX_FEE_VAULT] = FEE_VAULT;
        keys[IX_BUYER] = OWNER;
        keys[IX_BUYER_TA] = BUYER_TA;
        keys[IX_MINT] = MINT;
        keys[IX_LIST_STATE] = LIST_STATE;
        keys[IX_PAYER] = VAULT;
        keys[IX_TOKEN_PROGRAM] = SPL_TOKEN_PROGRAM;
        keys[IX_ASSOCIATED_TOKEN_PROGRAM] = ASSOCIATED_TOKEN_PROGRAM;
        keys[IX_MARKETPLACE_PROGRAM] = TENSOR_MARKETPLACE_PROGRAM;
        keys
    }

    fn expectations() -> TensorAccountExpectations {
        TensorAccountExpectations {
            payer: VAULT,
            buyer: OWNER,
            buyer_token_account: BUYER_TA,
            mint: MINT,
            list_state: LIST_STATE,
        }
    }

    #[test]
    fn discriminator_and_data_match_the_official_sdk() {
        assert_eq!(BUY_LEGACY_DISCRIMINATOR, [0x44, 0x7f, 0x2b, 0x08, 0xd4, 0x1f, 0xf9, 0x72]);
        let data = buy_legacy_data(PRICE);
        assert_eq!(data.len(), 18);
        assert_eq!(&data[0..8], &BUY_LEGACY_DISCRIMINATOR);
        assert_eq!(u64::from_le_bytes(data[8..16].try_into().unwrap()), PRICE);
        assert_eq!(data[16], 0);
        assert_eq!(data[17], 0);
    }

    #[test]
    fn policy_must_match_every_bound_identity() {
        let mut wrong = policy();
        wrong.mandate = [0u8; 32];
        assert_eq!(
            authorize_purchase(&wrong, &MANDATE, &OWNER, &EXECUTOR, &TENSOR_MARKETPLACE_PROGRAM, NOW),
            Err(PurchaseRejection::AuthorizationMismatch)
        );
        let mut wrong = policy();
        wrong.recipient = [0u8; 32];
        assert_eq!(
            authorize_purchase(&wrong, &MANDATE, &OWNER, &EXECUTOR, &TENSOR_MARKETPLACE_PROGRAM, NOW),
            Err(PurchaseRejection::AuthorizationMismatch)
        );
        let mut wrong = policy();
        wrong.marketplace = [0u8; 32];
        assert_eq!(
            authorize_purchase(&wrong, &MANDATE, &OWNER, &EXECUTOR, &TENSOR_MARKETPLACE_PROGRAM, NOW),
            Err(PurchaseRejection::AuthorizationMismatch)
        );
        let mut wrong = policy();
        wrong.executor = [0u8; 32];
        assert_eq!(
            authorize_purchase(&wrong, &MANDATE, &OWNER, &EXECUTOR, &TENSOR_MARKETPLACE_PROGRAM, NOW),
            Err(PurchaseRejection::AuthorizationMismatch)
        );
        let mut wrong = policy();
        wrong.version = 2;
        assert_eq!(
            authorize_purchase(&wrong, &MANDATE, &OWNER, &EXECUTOR, &TENSOR_MARKETPLACE_PROGRAM, NOW),
            Err(PurchaseRejection::AuthorizationMismatch)
        );
    }

    #[test]
    fn inactive_expired_and_empty_authorizations_fail_closed() {
        let mut inactive = policy();
        inactive.active = false;
        assert_eq!(
            authorize_purchase(&inactive, &MANDATE, &OWNER, &EXECUTOR, &TENSOR_MARKETPLACE_PROGRAM, NOW),
            Err(PurchaseRejection::AuthorizationNotActive)
        );
        let expired = PurchasePolicy { expires_at: NOW - 1, ..policy() };
        assert_eq!(
            authorize_purchase(&expired, &MANDATE, &OWNER, &EXECUTOR, &TENSOR_MARKETPLACE_PROGRAM, NOW),
            Err(PurchaseRejection::AuthorizationExpired)
        );
        let empty = PurchasePolicy { spent_lamports: 1_000_000_000, ..policy() };
        assert_eq!(
            authorize_purchase(&empty, &MANDATE, &OWNER, &EXECUTOR, &TENSOR_MARKETPLACE_PROGRAM, NOW),
            Err(PurchaseRejection::AuthorizationBudgetExceeded)
        );
        let corrupt = PurchasePolicy { spent_lamports: 2_000_000_000, ..policy() };
        assert_eq!(authorization_remaining(&corrupt), None);
    }

    #[test]
    fn account_mapping_is_pinned_to_vault_buyer_and_listing() {
        assert_eq!(check_tensor_accounts(&keys(), &expectations()), Ok(()));

        let mut wrong_payer = keys();
        wrong_payer[IX_PAYER] = OWNER;
        assert_eq!(
            check_tensor_accounts(&wrong_payer, &expectations()),
            Err(PurchaseRejection::InvalidTensorAccounts)
        );

        let mut wrong_buyer = keys();
        wrong_buyer[IX_BUYER] = VAULT;
        assert_eq!(
            check_tensor_accounts(&wrong_buyer, &expectations()),
            Err(PurchaseRejection::InvalidBuyer)
        );

        let mut wrong_mint = keys();
        wrong_mint[IX_MINT] = LIST_STATE;
        assert_eq!(
            check_tensor_accounts(&wrong_mint, &expectations()),
            Err(PurchaseRejection::InvalidListing)
        );

        let mut wrong_list = keys();
        wrong_list[IX_LIST_STATE] = MINT;
        assert_eq!(
            check_tensor_accounts(&wrong_list, &expectations()),
            Err(PurchaseRejection::InvalidListing)
        );

        let mut wrong_ata = keys();
        wrong_ata[IX_BUYER_TA] = VAULT;
        assert_eq!(
            check_tensor_accounts(&wrong_ata, &expectations()),
            Err(PurchaseRejection::InvalidBuyerTokenAccount)
        );

        let mut wrong_market = keys();
        wrong_market[IX_MARKETPLACE_PROGRAM] = SPL_TOKEN_PROGRAM;
        assert_eq!(
            check_tensor_accounts(&wrong_market, &expectations()),
            Err(PurchaseRejection::InvalidMarketplaceProgram)
        );

        let mut wrong_token = keys();
        wrong_token[IX_TOKEN_PROGRAM] = TENSOR_MARKETPLACE_PROGRAM;
        assert_eq!(
            check_tensor_accounts(&wrong_token, &expectations()),
            Err(PurchaseRejection::UnsupportedTokenStandard)
        );

        let mut short = keys();
        short.truncate(23);
        assert_eq!(
            check_tensor_accounts(&short, &expectations()),
            Err(PurchaseRejection::InvalidTensorAccounts)
        );
    }

    #[test]
    fn debit_ceiling_covers_fees_and_rent_but_not_overspend() {
        let ceiling = max_allowed_debit(PRICE).unwrap();
        assert_eq!(ceiling, PRICE + 2_000_000 + PURCHASE_OVERHEAD_LAMPORTS);
        assert_eq!(settle_debits(PRICE, PRICE, 1_000_000_000, 1_000_000_000), Ok(()));
        assert_eq!(settle_debits(PRICE, ceiling, 1_000_000_000, 1_000_000_000), Ok(()));
        assert_eq!(
            settle_debits(PRICE, ceiling + 1, 1_000_000_000, 1_000_000_000),
            Err(PurchaseRejection::VaultDebitExceeded)
        );
        assert_eq!(
            settle_debits(PRICE, PRICE - 1, 1_000_000_000, 1_000_000_000),
            Err(PurchaseRejection::InvalidPrice)
        );
        assert_eq!(
            settle_debits(PRICE, PRICE, PRICE - 1, 1_000_000_000),
            Err(PurchaseRejection::AuthorizationBudgetExceeded)
        );
        assert_eq!(
            settle_debits(PRICE, PRICE, 1_000_000_000, PRICE - 1),
            Err(PurchaseRejection::VaultDebitExceeded)
        );
    }

    #[test]
    fn delivery_requires_one_unit_of_the_expected_mint_owned_by_the_buyer() {
        let mut raw = [0u8; 165];
        raw[0..32].copy_from_slice(&MINT);
        raw[32..64].copy_from_slice(&OWNER);
        raw[64..72].copy_from_slice(&1u64.to_le_bytes());
        let parsed = TokenAccountState::parse(&raw).unwrap();
        assert_eq!(parsed, TokenAccountState { mint: MINT, owner: OWNER, amount: 1 });
        assert_eq!(check_delivery(Some(parsed), &expectations()), Ok(()));
        assert_eq!(check_delivery(None, &expectations()), Err(PurchaseRejection::PurchaseNotDelivered));

        let zero = TokenAccountState { amount: 0, ..parsed };
        assert_eq!(check_delivery(Some(zero), &expectations()), Err(PurchaseRejection::PurchaseNotDelivered));
        let wrong_owner = TokenAccountState { owner: VAULT, ..parsed };
        assert_eq!(check_delivery(Some(wrong_owner), &expectations()), Err(PurchaseRejection::PurchaseNotDelivered));
        let wrong_mint = TokenAccountState { mint: LIST_STATE, ..parsed };
        assert_eq!(check_delivery(Some(wrong_mint), &expectations()), Err(PurchaseRejection::PurchaseNotDelivered));
        assert_eq!(TokenAccountState::parse(&raw[0..40]), None);
    }

    #[test]
    fn order_identity_rejects_all_zero_ids() {
        assert!(order_id_is_valid(&[1u8; 16]));
        assert!(!order_id_is_valid(&[0u8; 16]));
    }

    #[test]
    fn rejection_codes_are_stable_and_do_not_collide_with_settlement_codes() {
        assert_eq!(PurchaseRejection::AuthorizationNotActive.code(), 12);
        assert_eq!(PurchaseRejection::UnsupportedTokenStandard.code(), 25);
        // Settlement codes occupy 1..=11; purchase codes must start after them.
        assert!(PurchaseRejection::AuthorizationNotActive.code() > 11);
    }
}
