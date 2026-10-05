//! Pure Na Vault mandate rules.
//!
//! These functions hold every budget/expiry/category/ownership decision that a purchase must
//! pass. They are deliberately pure so the same logic can be unit tested on the host, mirrored
//! by `shared/src/mandate.ts` for the UI, and reused by the Anchor handlers.
//!
//! The mirror is advisory. The program is the final guardrail: the UI or the AI can be wrong,
//! tampered with, or offline, and the vault still refuses an out-of-mandate spend.

use core::fmt;

/// No category restriction. The mandate still caps amount, expiry and destination.
pub const CATEGORY_ANY: u8 = 0;
/// NFT purchases.
pub const CATEGORY_NFT: u8 = 1;
/// RWA purchases. Kept for parity with the app; RWA execution remains disabled.
pub const CATEGORY_RWA: u8 = 2;

/// Reason a spend or an owner action was refused. Names match the shared TS union so the
/// frontend can translate a program error into a readable message.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Rejection {
    MandateNotActive,
    MandateExpired,
    BudgetExceeded,
    InsufficientVaultBalance,
    InvalidOwner,
    InvalidVault,
    InvalidCategory,
    InvalidAmount,
    AmountOverflow,
}

impl Rejection {
    /// Stable code used by the Anchor `NaError` enum and by the shared TS union.
    pub const fn code(self) -> u8 {
        match self {
            Rejection::MandateNotActive => 1,
            Rejection::MandateExpired => 2,
            Rejection::BudgetExceeded => 3,
            Rejection::InsufficientVaultBalance => 4,
            Rejection::InvalidOwner => 5,
            Rejection::InvalidVault => 6,
            Rejection::InvalidCategory => 7,
            Rejection::InvalidAmount => 8,
            Rejection::AmountOverflow => 9,
        }
    }
}

impl fmt::Display for Rejection {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let text = match self {
            Rejection::MandateNotActive => "MandateNotActive",
            Rejection::MandateExpired => "MandateExpired",
            Rejection::BudgetExceeded => "BudgetExceeded",
            Rejection::InsufficientVaultBalance => "InsufficientVaultBalance",
            Rejection::InvalidOwner => "InvalidOwner",
            Rejection::InvalidVault => "InvalidVault",
            Rejection::InvalidCategory => "InvalidCategory",
            Rejection::InvalidAmount => "InvalidAmount",
            Rejection::AmountOverflow => "AmountOverflow",
        };
        formatter.write_str(text)
    }
}

/// The subset of mandate state the rules need. Kept separate from the Anchor account so the
/// rules stay testable without a runtime.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MandatePolicy {
    pub active: bool,
    pub closed: bool,
    pub expires_at: i64,
    pub allowed_category: u8,
    pub max_budget_lamports: u64,
    pub spent_lamports: u64,
}

pub fn is_valid_category(category: u8) -> bool {
    (CATEGORY_ANY..=CATEGORY_RWA).contains(&category)
}

/// A category is allowed when the mandate is unrestricted or names exactly that category.
pub fn category_allowed(allowed_category: u8, requested_category: u8) -> bool {
    is_valid_category(requested_category)
        && (allowed_category == CATEGORY_ANY || allowed_category == requested_category)
}

pub fn is_expired(expires_at: i64, now: i64) -> bool {
    now > expires_at
}

/// Authorized minus already spent. `None` only if the stored state is corrupt.
pub fn remaining_budget(policy: &MandatePolicy) -> Option<u64> {
    policy
        .max_budget_lamports
        .checked_sub(policy.spent_lamports)
}

/// Lamports the vault may release, never dropping below the rent floor that keeps the
/// system-owned vault account alive.
pub fn spendable_vault_lamports(vault_lamports: u64, rent_floor: u64) -> u64 {
    vault_lamports.saturating_sub(rent_floor)
}

/// Refund handed back to the owner when the mandate is cancelled or reclaimed.
pub fn refundable_lamports(vault_lamports: u64, rent_floor: u64) -> u64 {
    spendable_vault_lamports(vault_lamports, rent_floor)
}

/// Validation shared by `create_mandate`. A mandate must be positive, must not already be
/// expired, and must name a category the program understands.
pub fn validate_create(
    max_budget_lamports: u64,
    expires_at: i64,
    allowed_category: u8,
    now: i64,
) -> Result<(), Rejection> {
    if max_budget_lamports == 0 {
        return Err(Rejection::InvalidAmount);
    }
    if expires_at <= now {
        return Err(Rejection::MandateExpired);
    }
    if !is_valid_category(allowed_category) {
        return Err(Rejection::InvalidCategory);
    }
    Ok(())
}

/// The single spending decision. Returns the new `spent_lamports` on success.
///
/// Order matters and mirrors the reject precedence documented in the UI:
/// inactive -> expired -> amount -> category -> budget -> vault balance.
pub fn authorize_spend(
    policy: &MandatePolicy,
    amount_lamports: u64,
    category: u8,
    now: i64,
    vault_lamports: u64,
    rent_floor: u64,
) -> Result<u64, Rejection> {
    if policy.closed || !policy.active {
        return Err(Rejection::MandateNotActive);
    }
    if is_expired(policy.expires_at, now) {
        return Err(Rejection::MandateExpired);
    }
    if amount_lamports == 0 {
        return Err(Rejection::InvalidAmount);
    }
    if !category_allowed(policy.allowed_category, category) {
        return Err(Rejection::InvalidCategory);
    }
    let remaining = match remaining_budget(policy) {
        Some(remaining) => remaining,
        None => return Err(Rejection::AmountOverflow),
    };
    if amount_lamports > remaining {
        return Err(Rejection::BudgetExceeded);
    }
    if amount_lamports > spendable_vault_lamports(vault_lamports, rent_floor) {
        return Err(Rejection::InsufficientVaultBalance);
    }
    policy
        .spent_lamports
        .checked_add(amount_lamports)
        .ok_or(Rejection::AmountOverflow)
}

/// Owner-only actions. Declared as account constraints in Anchor as well, so both layers agree.
pub fn authorize_owner(mandate_owner: &[u8; 32], caller: &[u8; 32]) -> Result<(), Rejection> {
    if mandate_owner != caller {
        return Err(Rejection::InvalidOwner);
    }
    Ok(())
}

/// The supplied vault account must be the one recorded in the mandate.
pub fn authorize_vault(
    mandate_vault: &[u8; 32],
    supplied_vault: &[u8; 32],
) -> Result<(), Rejection> {
    if mandate_vault != supplied_vault {
        return Err(Rejection::InvalidVault);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SOL: u64 = 1_000_000_000;
    const RENT_FLOOR: u64 = 890_880;
    const NOW: i64 = 1_700_000_000;

    fn policy(
        active: bool,
        expires_at: i64,
        category: u8,
        max_budget: u64,
        spent: u64,
    ) -> MandatePolicy {
        MandatePolicy {
            active,
            closed: false,
            expires_at,
            allowed_category: category,
            max_budget_lamports: max_budget,
            spent_lamports: spent,
        }
    }

    fn funded_vault(policy: &MandatePolicy) -> u64 {
        policy.max_budget_lamports - policy.spent_lamports + RENT_FLOOR
    }

    // Test 1: budget 1 SOL, spend 0.2 SOL passes and leaves 0.8 SOL.
    #[test]
    fn test_1_spend_within_budget_passes() {
        let mandate = policy(true, NOW + 3600, CATEGORY_NFT, SOL, 0);
        let spent = authorize_spend(
            &mandate,
            200_000_000,
            CATEGORY_NFT,
            NOW,
            funded_vault(&mandate),
            RENT_FLOOR,
        ).unwrap();
        assert_eq!(spent, 200_000_000);
        let after = MandatePolicy {
            spent_lamports: spent,
            ..mandate
        };
        assert_eq!(remaining_budget(&after), Some(800_000_000));
    }

    // Test 2: 0.8 spent + 0.3 request on a 1 SOL budget is rejected.
    #[test]
    fn test_2_over_budget_rejected() {
        let mandate = policy(true, NOW + 3600, CATEGORY_NFT, SOL, 800_000_000);
        assert_eq!(remaining_budget(&mandate), Some(200_000_000));
        assert_eq!(
            authorize_spend(
                &mandate,
                300_000_000,
                CATEGORY_NFT,
                NOW,
                funded_vault(&mandate),
                RENT_FLOOR
            ),
            Err(Rejection::BudgetExceeded)
        );
    }

    // Test 3: an expired mandate refuses every spend.
    #[test]
    fn test_3_expired_rejected() {
        let mandate = policy(true, NOW - 1, CATEGORY_NFT, SOL, 0);
        assert!(is_expired(mandate.expires_at, NOW));
        assert_eq!(
            authorize_spend(
                &mandate,
                100_000_000,
                CATEGORY_NFT,
                NOW,
                funded_vault(&mandate),
                RENT_FLOOR
            ),
            Err(Rejection::MandateExpired)
        );
        // The expiry boundary itself is still valid: now == expires_at.
        let boundary = policy(true, NOW, CATEGORY_NFT, SOL, 0);
        assert!(
            authorize_spend(
                &boundary,
                100_000_000,
                CATEGORY_NFT,
                NOW,
                funded_vault(&boundary),
                RENT_FLOOR
            ).is_ok()
        );
    }

    // Test 4: a cancelled (inactive) mandate refuses every spend.
    #[test]
    fn test_4_inactive_rejected() {
        let mandate = policy(false, NOW + 3600, CATEGORY_NFT, SOL, 0);
        assert_eq!(
            authorize_spend(
                &mandate,
                100_000_000,
                CATEGORY_NFT,
                NOW,
                funded_vault(&mandate),
                RENT_FLOOR
            ),
            Err(Rejection::MandateNotActive)
        );
        let closed = MandatePolicy {
            closed: true,
            ..mandate
        };
        assert_eq!(
            authorize_spend(
                &closed,
                1,
                CATEGORY_NFT,
                NOW,
                funded_vault(&closed),
                RENT_FLOOR
            ),
            Err(Rejection::MandateNotActive)
        );
    }

    // Test 5: cancel/withdraw by anyone other than the owner is rejected, and a substituted
    // vault account is rejected.
    #[test]
    fn test_5_wrong_owner_or_vault_rejected() {
        let owner = [7u8; 32];
        let attacker = [9u8; 32];
        assert_eq!(authorize_owner(&owner, &owner), Ok(()));
        assert_eq!(
            authorize_owner(&owner, &attacker),
            Err(Rejection::InvalidOwner)
        );
        assert_eq!(authorize_vault(&owner, &owner), Ok(()));
        assert_eq!(
            authorize_vault(&owner, &attacker),
            Err(Rejection::InvalidVault)
        );
    }

    // Test 6: cancelling stops spending and returns every unspent lamport.
    #[test]
    fn test_6_cancel_refunds_and_deactivates() {
        let mandate = policy(true, NOW + 3600, CATEGORY_NFT, SOL, 600_000_000);
        let vault = funded_vault(&mandate);
        let refund = refundable_lamports(vault, RENT_FLOOR);
        assert_eq!(refund, 400_000_000);
        let cancelled = MandatePolicy {
            active: false,
            ..mandate
        };
        assert_eq!(
            authorize_spend(&cancelled, 1, CATEGORY_NFT, NOW, vault, RENT_FLOOR),
            Err(Rejection::MandateNotActive)
        );
        // Nothing is lost: refund plus spend plus rent equals the original funding.
        assert_eq!(
            refund + cancelled.spent_lamports + RENT_FLOOR,
            SOL + RENT_FLOOR
        );
    }

    // Test 7: Na can never move more lamports than were actually funded into the vault,
    // even when the recorded budget is larger.
    #[test]
    fn test_7_cannot_spend_beyond_funded_vault() {
        let mandate = policy(true, NOW + 3600, CATEGORY_ANY, 5 * SOL, 0);
        let only_funded = 150_000_000 + RENT_FLOOR;
        assert_eq!(
            spendable_vault_lamports(only_funded, RENT_FLOOR),
            150_000_000
        );
        assert_eq!(
            authorize_spend(
                &mandate,
                200_000_000,
                CATEGORY_NFT,
                NOW,
                only_funded,
                RENT_FLOOR
            ),
            Err(Rejection::InsufficientVaultBalance)
        );
        assert!(
            authorize_spend(
                &mandate,
                150_000_000,
                CATEGORY_NFT,
                NOW,
                only_funded,
                RENT_FLOOR
            ).is_ok()
        );
    }

    #[test]
    fn category_rules_respect_the_mandate() {
        let nft_only = policy(true, NOW + 3600, CATEGORY_NFT, SOL, 0);
        assert_eq!(
            authorize_spend(
                &nft_only,
                1,
                CATEGORY_RWA,
                NOW,
                funded_vault(&nft_only),
                RENT_FLOOR
            ),
            Err(Rejection::InvalidCategory)
        );
        assert_eq!(
            authorize_spend(&nft_only, 1, 9, NOW, funded_vault(&nft_only), RENT_FLOOR),
            Err(Rejection::InvalidCategory)
        );
        let any = policy(true, NOW + 3600, CATEGORY_ANY, SOL, 0);
        assert!(category_allowed(CATEGORY_ANY, CATEGORY_RWA));
        assert_eq!(
            authorize_spend(&any, 1, CATEGORY_RWA, NOW, funded_vault(&any), RENT_FLOOR),
            Ok(1)
        );
    }

    #[test]
    fn create_mandate_validates_budget_expiry_and_category() {
        assert_eq!(
            validate_create(0, NOW + 60, CATEGORY_NFT, NOW),
            Err(Rejection::InvalidAmount)
        );
        assert_eq!(
            validate_create(SOL, NOW, CATEGORY_NFT, NOW),
            Err(Rejection::MandateExpired)
        );
        assert_eq!(
            validate_create(SOL, NOW - 1, CATEGORY_NFT, NOW),
            Err(Rejection::MandateExpired)
        );
        assert_eq!(
            validate_create(SOL, NOW + 60, 5, NOW),
            Err(Rejection::InvalidCategory)
        );
        assert_eq!(validate_create(SOL, NOW + 60, CATEGORY_ANY, NOW), Ok(()));
    }

    #[test]
    fn zero_amount_and_corrupt_state_fail_closed() {
        let mandate = policy(true, NOW + 3600, CATEGORY_NFT, SOL, 0);
        assert_eq!(
            authorize_spend(
                &mandate,
                0,
                CATEGORY_NFT,
                NOW,
                funded_vault(&mandate),
                RENT_FLOOR
            ),
            Err(Rejection::InvalidAmount)
        );
        let corrupt = MandatePolicy {
            spent_lamports: SOL + 1,
            ..mandate
        };
        assert_eq!(remaining_budget(&corrupt), None);
        assert_eq!(
            authorize_spend(
                &corrupt,
                1,
                CATEGORY_NFT,
                NOW,
                funded_vault(&mandate),
                RENT_FLOOR
            ),
            Err(Rejection::AmountOverflow)
        );
    }

    #[test]
    fn rejection_codes_are_stable_for_the_client() {
        assert_eq!(Rejection::MandateNotActive.code(), 1);
        assert_eq!(Rejection::MandateExpired.code(), 2);
        assert_eq!(Rejection::BudgetExceeded.code(), 3);
        assert_eq!(Rejection::InsufficientVaultBalance.code(), 4);
        assert_eq!(Rejection::InvalidOwner.code(), 5);
        assert_eq!(Rejection::InvalidVault.code(), 6);
        assert_eq!(Rejection::InvalidCategory.code(), 7);
        assert_eq!(Rejection::MandateNotActive.to_string(), "MandateNotActive");
    }
}
