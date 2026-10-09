#![allow(unexpected_cfgs)]
//! GoBuy Na Vault: the on-chain spending mandate that limits what Na may spend.
//!
//! The owner signs exactly once to create and fund the mandate. After that the vault, not the
//! wallet, is the source of funds: Na may trigger eligible spends autonomously, and the program
//! refuses anything outside the authorized budget, category, destination or expiry.
//!
//! The remaining balance of the owner's Phantom wallet is never reachable from this program.

use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};

// `alloc` is not part of the Rust extern prelude (`core` and `std` are), yet the pure rule
// modules return `alloc::vec::Vec<u8>` for instruction data. Declaring the crate once here puts
// the `alloc` path in scope for every module of this program.
extern crate alloc;

pub mod mandate_rules;
pub mod nft_purchase;
pub mod nft_purchase_rules;

use mandate_rules::{
    authorize_owner, authorize_spend, authorize_vault, refundable_lamports, validate_create,
    MandatePolicy, Rejection,
};
use nft_purchase::{
    BuyNftFromMandate, CloseNftPurchaseAuthorization, CreateNftPurchaseAuthorization,
};
use nft_purchase_rules::PurchaseRejection;

// Existing Devnet deployment identity. Source-to-deployed-binary provenance is not yet verified.
declare_id!("CHjdqooB7TrussJoZoboFP5TtdCspoHtvPpqoshbr5zE");

/// Seeds for the mandate state account: ["mandate", owner].
pub const MANDATE_SEED: &[u8] = b"mandate";
/// Seeds for the vault lamport account: ["vault", mandate].
pub const VAULT_SEED: &[u8] = b"vault";
/// Seeds for one spend receipt: ["spend", mandate, spend_id].
pub const SPEND_SEED: &[u8] = b"spend";
/// Seeds for the versioned original-NFT purchase authorization: ["nft-auth", mandate].
pub const NFT_AUTH_SEED: &[u8] = nft_purchase_rules::NFT_AUTH_SEED;
/// Seeds for one immutable genuine purchase receipt: ["purchase", mandate, order_id].
pub const PURCHASE_SEED: &[u8] = nft_purchase_rules::PURCHASE_SEED;

#[program]
pub mod gobuy_na {
    use super::*;

    /// Owner-signed setup. Creates the mandate, derives the vault PDA and funds it with the
    /// authorized budget plus the rent floor that keeps the vault account alive.
    pub fn create_mandate(
        ctx: Context<CreateMandate>,
        max_budget_lamports: u64,
        expires_at: i64,
        allowed_category: u8,
        recipient: Pubkey,
        executor: Pubkey,
    ) -> Result<()> {
        require!(executor != Pubkey::default(), NaError::InvalidOwner);
        let now = Clock::get()?.unix_timestamp;
        validate_create(max_budget_lamports, expires_at, allowed_category, now)
            .map_err(NaError::from)?;
        require!(recipient != Pubkey::default(), NaError::InvalidOwner);
        require!(
            recipient != ctx.accounts.mandate.key() && recipient != ctx.accounts.vault.key(),
            NaError::InvalidVault
        );
        let system_program = ctx.accounts.system_program.to_account_info();
        let rent_floor = Rent::get()?.minimum_balance(0);
        let funding = max_budget_lamports
            .checked_add(rent_floor)
            .ok_or(NaError::AmountOverflow)?;
        let mandate = &mut ctx.accounts.mandate;
        mandate.owner = ctx.accounts.owner.key();
        mandate.executor = executor;
        mandate.vault = ctx.accounts.vault.key();
        mandate.recipient = recipient;
        mandate.max_budget_lamports = max_budget_lamports;
        mandate.spent_lamports = 0;
        mandate.expires_at = expires_at;
        mandate.allowed_category = allowed_category;
        mandate.active = true;
        mandate.closed = false;
        mandate.created_at = now;
        mandate.bump = ctx.bumps.mandate;
        mandate.vault_bump = ctx.bumps.vault;
        // The single Phantom authorization: move the authorized amount under the vault's control.
        transfer(
            CpiContext::new(
                system_program,
                Transfer {
                    from: ctx.accounts.owner.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                },
            ),
            funding,
        )?;
        emit!(MandateCreated {
            owner: mandate.owner,
            mandate: mandate.key(),
            vault: mandate.vault,
            recipient,
            max_budget_lamports,
            expires_at,
            allowed_category,
            created_at: now,
        });
        Ok(())
    }

    /// Agent-signed, rule-bounded spend. The vault PDA signs the transfer, so Na never needs
    /// the owner's key. Every limit is enforced here before a single lamport moves, and
    /// `spent_lamports` is only updated after the transfer succeeds.
    pub fn spend_from_mandate(
        ctx: Context<SpendFromMandate>,
        amount_lamports: u64,
        category: u8,
        spend_id: [u8; 16],
        asset_hash: [u8; 32],
    ) -> Result<()> {
        require!(spend_id != [0u8; 16], NaError::InvalidSpendId);
        let now = Clock::get()?.unix_timestamp;
        let rent_floor = Rent::get()?.minimum_balance(0);
        let vault_lamports = ctx.accounts.vault.lamports();
        let mandate_key = ctx.accounts.mandate.key();
        let owner_key = ctx.accounts.mandate.owner;
        let recipient_key = ctx.accounts.recipient.key();
        let vault_bump = ctx.accounts.mandate.vault_bump;
        let policy = MandatePolicy {
            active: ctx.accounts.mandate.active,
            closed: ctx.accounts.mandate.closed,
            expires_at: ctx.accounts.mandate.expires_at,
            allowed_category: ctx.accounts.mandate.allowed_category,
            max_budget_lamports: ctx.accounts.mandate.max_budget_lamports,
            spent_lamports: ctx.accounts.mandate.spent_lamports,
        };
        // Seeds already bind the vault, and the recorded key is checked again as a second layer.
        authorize_vault(
            &ctx.accounts.mandate.vault.to_bytes(),
            &ctx.accounts.vault.key().to_bytes(),
        ).map_err(NaError::from)?;
        let spent_after = authorize_spend(
            &policy,
            amount_lamports,
            category,
            now,
            vault_lamports,
            rent_floor,
        ).map_err(NaError::from)?;
        let remaining_after = policy
            .max_budget_lamports
            .checked_sub(spent_after)
            .ok_or(NaError::AmountOverflow)?;
        let vault_seeds: &[&[u8]] = &[VAULT_SEED, mandate_key.as_ref(), &[vault_bump]];
        transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.recipient.to_account_info(),
                },
                &[vault_seeds],
            ),
            amount_lamports,
        )?;
        let record = &mut ctx.accounts.spend_record;
        record.mandate = mandate_key;
        record.owner = owner_key;
        record.spend_id = spend_id;
        record.asset_hash = asset_hash;
        record.amount_lamports = amount_lamports;
        record.category = category;
        record.recipient = recipient_key;
        record.spent_before = policy.spent_lamports;
        record.spent_after = spent_after;
        record.remaining_after = remaining_after;
        record.timestamp = now;
        record.bump = ctx.bumps.spend_record;
        // Only now that the transfer succeeded does the budget move.
        ctx.accounts.mandate.spent_lamports = spent_after;
        emit!(MandateSpend {
            mandate: mandate_key,
            owner: owner_key,
            recipient: recipient_key,
            amount_lamports,
            spent_before: policy.spent_lamports,
            spent_after,
            remaining_after,
            category,
            timestamp: now,
        });
        Ok(())
    }

    /// Owner-only revocation. Stops every future spend and returns the unused budget.
    pub fn cancel_mandate(ctx: Context<CancelMandate>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let rent_floor = Rent::get()?.minimum_balance(0);
        let mandate_key = ctx.accounts.mandate.key();
        let owner_key = ctx.accounts.mandate.owner;
        require!(ctx.accounts.mandate.active, NaError::MandateNotActive);
        authorize_owner(
            &ctx.accounts.mandate.owner.to_bytes(),
            &ctx.accounts.owner.key().to_bytes(),
        ).map_err(NaError::from)?;
        authorize_vault(
            &ctx.accounts.mandate.vault.to_bytes(),
            &ctx.accounts.vault.key().to_bytes(),
        ).map_err(NaError::from)?;
        ctx.accounts.mandate.active = false;
        ctx.accounts.mandate.closed_at = now;
        let refund = refundable_lamports(ctx.accounts.vault.lamports(), rent_floor);
        if refund > 0 {
            let vault_bump = ctx.accounts.mandate.vault_bump;
            let vault_seeds: &[&[u8]] = &[VAULT_SEED, mandate_key.as_ref(), &[vault_bump]];
            transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.system_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.vault.to_account_info(),
                        to: ctx.accounts.owner.to_account_info(),
                    },
                    &[vault_seeds],
                ),
                refund,
            )?;
        }
        emit!(MandateCancelled {
            mandate: mandate_key,
            owner: owner_key,
            refunded_lamports: refund,
            timestamp: now,
        });
        Ok(())
    }

    /// Owner-only reclaim of anything left in the vault once the mandate is inactive or expired.
    /// Closes the mandate account so a new mandate can be created for the same owner.
    pub fn withdraw_remaining(ctx: Context<WithdrawRemaining>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let mandate_key = ctx.accounts.mandate.key();
        let owner_key = ctx.accounts.mandate.owner;
        let expired = mandate_rules::is_expired(ctx.accounts.mandate.expires_at, now);
        require!(
            !ctx.accounts.mandate.active || expired,
            NaError::MandateStillActive
        );
        authorize_owner(
            &ctx.accounts.mandate.owner.to_bytes(),
            &ctx.accounts.owner.key().to_bytes(),
        ).map_err(NaError::from)?;
        authorize_vault(
            &ctx.accounts.mandate.vault.to_bytes(),
            &ctx.accounts.vault.key().to_bytes(),
        ).map_err(NaError::from)?;
        let refund = ctx.accounts.vault.lamports();
        if refund > 0 {
            let vault_bump = ctx.accounts.mandate.vault_bump;
            let vault_seeds: &[&[u8]] = &[VAULT_SEED, mandate_key.as_ref(), &[vault_bump]];
            transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.system_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.vault.to_account_info(),
                        to: ctx.accounts.owner.to_account_info(),
                    },
                    &[vault_seeds],
                ),
                refund,
            )?;
        }
        ctx.accounts.mandate.closed = true;
        ctx.accounts.mandate.active = false;
        ctx.accounts.mandate.closed_at = now;
        emit!(MandateClosed {
            mandate: mandate_key,
            owner: owner_key,
            refunded_lamports: refund,
            timestamp: now,
        });
        Ok(())
    }

    /// Owner-signed approval of a versioned original-NFT purchase policy. This is the explicit
    /// approval the settlement mandate never carried: it names the marketplace, executor,
    /// recipient and the maximum total SOL the vault may ever be debited under it.
    pub fn create_nft_purchase_authorization(
        ctx: Context<CreateNftPurchaseAuthorization>,
        max_total_debit_lamports: u64,
        expires_at: i64,
        marketplace: Pubkey,
        executor: Pubkey,
        recipient: Pubkey,
    ) -> Result<()> {
        nft_purchase::create_nft_purchase_authorization(
            ctx,
            max_total_debit_lamports,
            expires_at,
            marketplace,
            executor,
            recipient,
        )
    }

    /// Owner-only revocation of the purchase authorization.
    pub fn close_nft_purchase_authorization(
        ctx: Context<CloseNftPurchaseAuthorization>,
    ) -> Result<()> {
        nft_purchase::close_nft_purchase_authorization(ctx)
    }

    /// Genuine Devnet NFT purchase. The vault PDA pays Tensor through a `buy_legacy` CPI; the
    /// original NFT is delivered to the mandate owner's associated token account.
    pub fn buy_nft_from_mandate(
        ctx: Context<BuyNftFromMandate>,
        order_id: [u8; 16],
        expected_mint: Pubkey,
        max_price_lamports: u64,
    ) -> Result<()> {
        nft_purchase::buy_nft_from_mandate(ctx, order_id, expected_mint, max_price_lamports)
    }
}

#[derive(Accounts)]
pub struct CreateMandate<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        init,
        payer = owner,
        space = 8 + Mandate::INIT_SPACE,
        seeds = [MANDATE_SEED, owner.key().as_ref()],
        bump
    )]
    pub mandate: Account<'info, Mandate>,
    /// CHECK: program-derived vault PDA. It carries no data and holds only mandate lamports, so
    /// the funding transfer is what brings it into existence.
    #[account(mut, seeds = [VAULT_SEED, mandate.key().as_ref()], bump)]
    pub vault: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(amount_lamports: u64, category: u8, spend_id: [u8; 16], asset_hash: [u8; 32])]
pub struct SpendFromMandate<'info> {
    /// Executor authorized by the owner; also pays receipt rent and fees.
    #[account(mut, address = mandate.executor @ NaError::InvalidOwner)]
    pub payer: Signer<'info>,
    #[account(
        mut,
        seeds = [MANDATE_SEED, mandate.owner.as_ref()],
        bump = mandate.bump
    )]
    pub mandate: Account<'info, Mandate>,
    /// CHECK: vault PDA recorded in the mandate; re-checked in the handler.
    #[account(mut, seeds = [VAULT_SEED, mandate.key().as_ref()], bump = mandate.vault_bump)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: the single destination the owner authorized at mandate creation.
    #[account(mut, address = mandate.recipient)]
    pub recipient: UncheckedAccount<'info>,
    // init (never init_if_needed): one spend_id can only ever produce one receipt.
    #[account(
        init,
        payer = payer,
        space = 8 + SpendRecord::INIT_SPACE,
        seeds = [SPEND_SEED, mandate.key().as_ref(), spend_id.as_ref()],
        bump
    )]
    pub spend_record: Account<'info, SpendRecord>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CancelMandate<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        mut,
        has_one = owner,
        seeds = [MANDATE_SEED, owner.key().as_ref()],
        bump = mandate.bump
    )]
    pub mandate: Account<'info, Mandate>,
    /// CHECK: vault PDA recorded in the mandate; re-checked in the handler.
    #[account(mut, seeds = [VAULT_SEED, mandate.key().as_ref()], bump = mandate.vault_bump)]
    pub vault: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct WithdrawRemaining<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        mut,
        close = owner,
        has_one = owner,
        seeds = [MANDATE_SEED, owner.key().as_ref()],
        bump = mandate.bump
    )]
    pub mandate: Account<'info, Mandate>,
    /// CHECK: vault PDA recorded in the mandate; re-checked in the handler.
    #[account(mut, seeds = [VAULT_SEED, mandate.key().as_ref()], bump = mandate.vault_bump)]
    pub vault: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// On-chain mandate state. Deliberately small: the category is a `u8` and no free-form string is
/// ever stored, so the account stays cheap and cannot be used to smuggle data.
#[account]
#[derive(InitSpace)]
pub struct Mandate {
    pub owner: Pubkey,
    pub vault: Pubkey,
    pub recipient: Pubkey,
    pub max_budget_lamports: u64,
    pub spent_lamports: u64,
    pub expires_at: i64,
    pub allowed_category: u8,
    pub active: bool,
    pub closed: bool,
    pub created_at: i64,
    pub closed_at: i64,
    pub bump: u8,
    pub vault_bump: u8,
    pub executor: Pubkey,
}

impl Mandate {
    /// Remaining authorized budget. Used by clients; the program recomputes it on every spend.
    pub fn remaining_lamports(&self) -> u64 {
        self.max_budget_lamports.saturating_sub(self.spent_lamports)
    }
}

/// One immutable receipt per authorized spend: the transaction history for the dashboard.
#[account]
#[derive(InitSpace)]
pub struct SpendRecord {
    pub mandate: Pubkey,
    pub owner: Pubkey,
    pub recipient: Pubkey,
    pub spend_id: [u8; 16],
    pub asset_hash: [u8; 32],
    pub amount_lamports: u64,
    pub spent_before: u64,
    pub spent_after: u64,
    pub remaining_after: u64,
    pub category: u8,
    pub timestamp: i64,
    pub bump: u8,
}

#[event]
pub struct MandateCreated {
    pub owner: Pubkey,
    pub mandate: Pubkey,
    pub vault: Pubkey,
    pub recipient: Pubkey,
    pub max_budget_lamports: u64,
    pub expires_at: i64,
    pub allowed_category: u8,
    pub created_at: i64,
}

#[event]
pub struct MandateSpend {
    pub mandate: Pubkey,
    pub owner: Pubkey,
    pub recipient: Pubkey,
    pub amount_lamports: u64,
    pub spent_before: u64,
    pub spent_after: u64,
    pub remaining_after: u64,
    pub category: u8,
    pub timestamp: i64,
}

#[event]
pub struct MandateCancelled {
    pub mandate: Pubkey,
    pub owner: Pubkey,
    pub refunded_lamports: u64,
    pub timestamp: i64,
}

#[event]
pub struct MandateClosed {
    pub mandate: Pubkey,
    pub owner: Pubkey,
    pub refunded_lamports: u64,
    pub timestamp: i64,
}

#[error_code]
pub enum NaError {
    #[msg("The mandate is not active")]
    MandateNotActive,
    #[msg("The mandate has expired")]
    MandateExpired,
    #[msg("The purchase exceeds the remaining authorized budget")]
    BudgetExceeded,
    #[msg("The vault does not hold enough lamports for this spend")]
    InsufficientVaultBalance,
    #[msg("Only the mandate owner can do this")]
    InvalidOwner,
    #[msg("The supplied vault does not belong to this mandate")]
    InvalidVault,
    #[msg("This mandate does not allow that category")]
    InvalidCategory,
    #[msg("The amount is not valid")]
    InvalidAmount,
    #[msg("Lamport arithmetic overflowed")]
    AmountOverflow,
    #[msg("The spend id is missing")]
    InvalidSpendId,
    #[msg("Reclaim the remaining funds before creating a new mandate")]
    MandateStillActive,
    #[msg("Unexpected transaction failure")]
    TransactionFailed,
    #[msg("The NFT purchase authorization is not active")]
    PurchaseAuthorizationNotActive,
    #[msg("The NFT purchase authorization has expired")]
    PurchaseAuthorizationExpired,
    #[msg("The NFT purchase authorization does not match this mandate, owner, executor or marketplace")]
    PurchaseAuthorizationMismatch,
    #[msg("The purchase exceeds the authorized NFT purchase budget")]
    PurchaseAuthorizationBudgetExceeded,
    #[msg("The purchase order identity is missing")]
    InvalidPurchaseOrder,
    #[msg("The listing does not match the requested mint")]
    InvalidListing,
    #[msg("The marketplace program is not the verified Tensor program")]
    InvalidMarketplaceProgram,
    #[msg("The NFT buyer is not the mandate owner")]
    InvalidBuyer,
    #[msg("The NFT destination is not the owner's associated token account")]
    InvalidBuyerTokenAccount,
    #[msg("The Tensor BuyLegacy account list is invalid")]
    InvalidTensorAccounts,
    #[msg("The purchase price is not valid")]
    InvalidPrice,
    #[msg("The NFT was not delivered to the buyer")]
    PurchaseNotDelivered,
    #[msg("The vault debit exceeds the authorized purchase amount")]
    VaultDebitExceeded,
    #[msg("Only classic SPL Token non-fungible assets are supported")]
    UnsupportedTokenStandard,
}

/// Purchase rejections map onto the appended error variants in the same order, so their numeric
/// codes (12..=25) stay stable and the shared client union can name every refusal exactly.
impl From<PurchaseRejection> for NaError {
    fn from(rejection: PurchaseRejection) -> Self {
        match rejection {
            PurchaseRejection::AuthorizationNotActive => NaError::PurchaseAuthorizationNotActive,
            PurchaseRejection::AuthorizationExpired => NaError::PurchaseAuthorizationExpired,
            PurchaseRejection::AuthorizationMismatch => NaError::PurchaseAuthorizationMismatch,
            PurchaseRejection::AuthorizationBudgetExceeded => {
                NaError::PurchaseAuthorizationBudgetExceeded
            }
            PurchaseRejection::InvalidPurchaseOrder => NaError::InvalidPurchaseOrder,
            PurchaseRejection::InvalidListing => NaError::InvalidListing,
            PurchaseRejection::InvalidMarketplaceProgram => NaError::InvalidMarketplaceProgram,
            PurchaseRejection::InvalidBuyer => NaError::InvalidBuyer,
            PurchaseRejection::InvalidBuyerTokenAccount => NaError::InvalidBuyerTokenAccount,
            PurchaseRejection::InvalidTensorAccounts => NaError::InvalidTensorAccounts,
            PurchaseRejection::InvalidPrice => NaError::InvalidPrice,
            PurchaseRejection::PurchaseNotDelivered => NaError::PurchaseNotDelivered,
            PurchaseRejection::VaultDebitExceeded => NaError::VaultDebitExceeded,
            PurchaseRejection::UnsupportedTokenStandard => NaError::UnsupportedTokenStandard,
        }
    }
}

impl From<Rejection> for NaError {
    fn from(rejection: Rejection) -> Self {
        match rejection {
            Rejection::MandateNotActive => NaError::MandateNotActive,
            Rejection::MandateExpired => NaError::MandateExpired,
            Rejection::BudgetExceeded => NaError::BudgetExceeded,
            Rejection::InsufficientVaultBalance => NaError::InsufficientVaultBalance,
            Rejection::InvalidOwner => NaError::InvalidOwner,
            Rejection::InvalidVault => NaError::InvalidVault,
            Rejection::InvalidCategory => NaError::InvalidCategory,
            Rejection::InvalidAmount => NaError::InvalidAmount,
            Rejection::AmountOverflow => NaError::AmountOverflow,
        }
    }
}

#[cfg(test)]
mod mandate_account_tests {
    use super::*;

    #[test]
    fn remaining_lamports_never_underflows() {
        let mandate = Mandate {
            owner: Pubkey::default(),
            vault: Pubkey::default(),
            recipient: Pubkey::default(),
            max_budget_lamports: 1_000_000_000,
            spent_lamports: 400_000_000,
            expires_at: 0,
            allowed_category: mandate_rules::CATEGORY_NFT,
            active: true,
            closed: false,
            created_at: 0,
            closed_at: 0,
            bump: 255,
            vault_bump: 254,
            executor: Pubkey::default(),
        };
        assert_eq!(mandate.remaining_lamports(), 600_000_000);
        let corrupt = Mandate {
            spent_lamports: 2_000_000_000,
            ..mandate
        };
        assert_eq!(corrupt.remaining_lamports(), 0);
    }

    #[test]
    fn rejection_maps_onto_the_program_error_codes() {
        assert!(matches!(
            NaError::from(Rejection::BudgetExceeded),
            NaError::BudgetExceeded
        ));
        assert!(matches!(
            NaError::from(Rejection::InvalidVault),
            NaError::InvalidVault
        ));
        assert_eq!(Rejection::MandateNotActive.code(), 1);
    }
}
