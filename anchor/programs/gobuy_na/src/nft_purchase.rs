//! Genuine NFT purchase: Na Vault pays Tensor through an Anchor CPI and the original NFT is
//! delivered straight to the mandate owner's associated token account.
//!
//! Shape of one purchase, signed only by the executor:
//!   * `payer`  (BuyLegacy account 7) is the vault PDA, signed here with its own seeds.
//!   * `buyer`  (BuyLegacy account 1) is `mandate.owner`, so `buyerTa` is the owner's ATA.
//!   * the vault pays; the wallet receives the NFT. No settlement transfer happens first.
//!
//! Everything is checked before the CPI, and the debit and token ownership are checked after it.
//! Any failure reverts the whole transaction, including the receipt account.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;

use crate::mandate_rules;
use crate::nft_purchase_rules as rules;
use crate::{Mandate, NaError, MANDATE_SEED, VAULT_SEED};

/// The one marketplace this program will ever call. No arbitrary CPI target is reachable.
pub fn tensor_program_id() -> Pubkey {
    Pubkey::new_from_array(rules::TENSOR_MARKETPLACE_PROGRAM)
}

pub fn token_program_id() -> Pubkey {
    Pubkey::new_from_array(rules::SPL_TOKEN_PROGRAM)
}

pub fn associated_token_program_id() -> Pubkey {
    Pubkey::new_from_array(rules::ASSOCIATED_TOKEN_PROGRAM)
}

/// Canonical Tensor list state for a mint: `["list_state", mint]` under the marketplace program.
pub fn list_state_address(mint: &Pubkey) -> Result<Pubkey> {
    Ok(Pubkey::find_program_address(
        &[rules::LIST_STATE_SEED, mint.as_ref()],
        &tensor_program_id(),
    )
    .0)
}

/// Canonical classic-SPL associated token account for `owner` and `mint`.
pub fn associated_token_address(owner: &Pubkey, mint: &Pubkey) -> Result<Pubkey> {
    Ok(Pubkey::find_program_address(
        &[owner.as_ref(), token_program_id().as_ref(), mint.as_ref()],
        &associated_token_program_id(),
    )
    .0)
}

/// Versioned, owner-approved policy for genuine original-NFT purchases.
///
/// Deliberately a separate account: existing mandates were created as settlement authorizations and
/// must never be silently reinterpreted as permission to buy from arbitrary sellers. A mandate with
/// no such account simply cannot reach the purchase instruction.
#[account]
#[derive(InitSpace)]
pub struct NftPurchaseAuthorization {
    pub version: u8,
    pub mandate: Pubkey,
    pub owner: Pubkey,
    pub executor: Pubkey,
    pub marketplace: Pubkey,
    pub recipient: Pubkey,
    pub max_total_debit_lamports: u64,
    pub spent_lamports: u64,
    pub expires_at: i64,
    pub active: bool,
    pub created_at: i64,
    pub bump: u8,
}

/// One immutable, unique receipt per purchased order. `init` on its PDA is the replay guard: the
/// same order can never settle twice, and a failed CPI rolls the receipt back with the rest.
#[account]
#[derive(InitSpace)]
pub struct NftPurchaseReceipt {
    pub version: u8,
    pub mandate: Pubkey,
    pub authorization: Pubkey,
    pub owner: Pubkey,
    pub executor: Pubkey,
    pub mint: Pubkey,
    pub listing: Pubkey,
    pub marketplace: Pubkey,
    pub price_lamports: u64,
    pub total_debit_lamports: u64,
    pub order_id: [u8; 16],
    pub timestamp: i64,
    pub bump: u8,
}

#[event]
pub struct NftPurchaseAuthorizationCreated {
    pub mandate: Pubkey,
    pub owner: Pubkey,
    pub executor: Pubkey,
    pub marketplace: Pubkey,
    pub recipient: Pubkey,
    pub max_total_debit_lamports: u64,
    pub expires_at: i64,
    pub version: u8,
    pub created_at: i64,
}

#[event]
pub struct NftPurchaseAuthorizationClosed {
    pub mandate: Pubkey,
    pub owner: Pubkey,
    pub refunded_lamports: u64,
    pub timestamp: i64,
}

#[event]
pub struct NftPurchased {
    pub mandate: Pubkey,
    pub owner: Pubkey,
    pub executor: Pubkey,
    pub mint: Pubkey,
    pub listing: Pubkey,
    pub marketplace: Pubkey,
    pub price_lamports: u64,
    pub total_debit_lamports: u64,
    pub order_id: [u8; 16],
    pub timestamp: i64,
}
/// Owner-signed, one-time approval of a versioned original-NFT purchase policy.
///
/// This is the explicit user approval the settlement mandate never gave. It names the allowed
/// marketplace, the authorized executor, the exact recipient wallet, the maximum total SOL the
/// vault may ever be debited under it, and its expiry.
pub fn create_nft_purchase_authorization(
    ctx: Context<CreateNftPurchaseAuthorization>,
    max_total_debit_lamports: u64,
    expires_at: i64,
    marketplace: Pubkey,
    executor: Pubkey,
    recipient: Pubkey,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let mandate = &ctx.accounts.mandate;
    require!(mandate.active && !mandate.closed, NaError::MandateNotActive);
    require_keys_eq!(executor, mandate.executor, NaError::InvalidOwner);
    require_keys_eq!(recipient, mandate.owner, NaError::InvalidOwner);
    require_keys_eq!(marketplace, tensor_program_id(), NaError::InvalidMarketplaceProgram);
    require!(max_total_debit_lamports > 0, NaError::InvalidAmount);
    require!(expires_at > now, NaError::MandateExpired);
    require!(
        max_total_debit_lamports <= mandate.remaining_lamports(),
        NaError::BudgetExceeded
    );
    let mandate_key = mandate.key();
    let owner_key = mandate.owner;
    let authorization = &mut ctx.accounts.nft_authorization;
    authorization.version = rules::PURCHASE_AUTH_VERSION;
    authorization.mandate = mandate_key;
    authorization.owner = owner_key;
    authorization.executor = executor;
    authorization.marketplace = marketplace;
    authorization.recipient = recipient;
    authorization.max_total_debit_lamports = max_total_debit_lamports;
    authorization.spent_lamports = 0;
    authorization.expires_at = expires_at;
    authorization.active = true;
    authorization.created_at = now;
    authorization.bump = ctx.bumps.nft_authorization;
    emit!(NftPurchaseAuthorizationCreated {
        mandate: mandate_key,
        owner: owner_key,
        executor,
        marketplace,
        recipient,
        max_total_debit_lamports,
        expires_at,
        version: rules::PURCHASE_AUTH_VERSION,
        created_at: now,
    });
    Ok(())
}

/// Owner-only revocation. Closing removes the only path to `buy_nft_from_mandate`; immutable
/// purchase receipts survive, so history and replay protection are unaffected.
pub fn close_nft_purchase_authorization(
    ctx: Context<CloseNftPurchaseAuthorization>,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let mandate_key = ctx.accounts.mandate.key();
    let owner_key = ctx.accounts.owner.key();
    let refunded = ctx.accounts.nft_authorization.to_account_info().lamports();
    emit!(NftPurchaseAuthorizationClosed {
        mandate: mandate_key,
        owner: owner_key,
        refunded_lamports: refunded,
        timestamp: now,
    });
    Ok(())
}

/// The genuine purchase. The vault pays Tensor through a `buy_legacy` CPI signed with the vault
/// seeds; the original NFT settles into the owner's associated token account.
pub fn buy_nft_from_mandate(
    ctx: Context<BuyNftFromMandate>,
    order_id: [u8; 16],
    expected_mint: Pubkey,
    max_price_lamports: u64,
) -> Result<()> {
    require!(rules::order_id_is_valid(&order_id), NaError::InvalidPurchaseOrder);
    require!(max_price_lamports > 0, NaError::InvalidPrice);

    let now = Clock::get()?.unix_timestamp;
    let rent_floor = Rent::get()?.minimum_balance(0);

    let mandate_key = ctx.accounts.mandate.key();
    let owner_key = ctx.accounts.mandate.owner;
    let mandate_active = ctx.accounts.mandate.active;
    let mandate_closed = ctx.accounts.mandate.closed;
    let mandate_expires_at = ctx.accounts.mandate.expires_at;
    let mandate_category = ctx.accounts.mandate.allowed_category;
    let mandate_max_budget = ctx.accounts.mandate.max_budget_lamports;
    let mandate_spent = ctx.accounts.mandate.spent_lamports;
    let vault_bump = ctx.accounts.mandate.vault_bump;
    let vault_key = ctx.accounts.vault.key();
    let executor_key = ctx.accounts.executor.key();
    let authorization_key = ctx.accounts.nft_authorization.key();

    // Mandate: the same rules `spend_from_mandate` enforces, re-applied here.
    require!(mandate_active && !mandate_closed, NaError::MandateNotActive);
    require!(!mandate_rules::is_expired(mandate_expires_at, now), NaError::MandateExpired);
    require!(
        mandate_rules::category_allowed(mandate_category, mandate_rules::CATEGORY_NFT),
        NaError::InvalidCategory
    );
    require_keys_eq!(executor_key, ctx.accounts.mandate.executor, NaError::InvalidOwner);

    // Versioned purchase authorization: explicit user approval, never inferred from the mandate.
    let policy = rules::PurchasePolicy {
        version: ctx.accounts.nft_authorization.version,
        active: ctx.accounts.nft_authorization.active,
        mandate: ctx.accounts.nft_authorization.mandate.to_bytes(),
        owner: ctx.accounts.nft_authorization.owner.to_bytes(),
        executor: ctx.accounts.nft_authorization.executor.to_bytes(),
        marketplace: ctx.accounts.nft_authorization.marketplace.to_bytes(),
        recipient: ctx.accounts.nft_authorization.recipient.to_bytes(),
        max_total_debit_lamports: ctx.accounts.nft_authorization.max_total_debit_lamports,
        spent_lamports: ctx.accounts.nft_authorization.spent_lamports,
        expires_at: ctx.accounts.nft_authorization.expires_at,
    };
    let authorization_remaining = rules::authorize_purchase(
        &policy,
        &mandate_key.to_bytes(),
        &owner_key.to_bytes(),
        &executor_key.to_bytes(),
        &tensor_program_id().to_bytes(),
        now,
    )
    .map_err(NaError::from)?;

    // Budget, expiry and vault balance, exactly as the settlement path checks them.
    let verdict = mandate_rules::authorize_spend(
        &mandate_rules::MandatePolicy {
            active: mandate_active,
            closed: mandate_closed,
            expires_at: mandate_expires_at,
            allowed_category: mandate_category,
            max_budget_lamports: mandate_max_budget,
            spent_lamports: mandate_spent,
        },
        max_price_lamports,
        mandate_rules::CATEGORY_NFT,
        now,
        ctx.accounts.vault.lamports(),
        rent_floor,
    )
    .map_err(NaError::from)?;
    let mandate_remaining = mandate_max_budget
        .checked_sub(mandate_spent)
        .ok_or(NaError::AmountOverflow)?;
    let _ = verdict;

    // Verified listing: the mint must be the requested one and its canonical Tensor list state.
    let listing = list_state_address(&expected_mint)?;
    let buyer_token_account = associated_token_address(&owner_key, &expected_mint)?;
    let remaining = ctx.remaining_accounts;
    require!(
        remaining.len() >= rules::BUY_LEGACY_ACCOUNTS,
        NaError::InvalidTensorAccounts
    );
    let mut keys: Vec<[u8; 32]> = Vec::with_capacity(rules::BUY_LEGACY_ACCOUNTS);
    for account in remaining.iter().take(rules::BUY_LEGACY_ACCOUNTS) {
        keys.push(account.key().to_bytes());
    }
    let expectations = rules::TensorAccountExpectations {
        payer: vault_key.to_bytes(),
        buyer: owner_key.to_bytes(),
        buyer_token_account: buyer_token_account.to_bytes(),
        mint: expected_mint.to_bytes(),
        list_state: listing.to_bytes(),
    };
    rules::check_tensor_accounts(&keys, &expectations).map_err(NaError::from)?;

    // The vault pays: `payer` is signed with the vault PDA seeds through invoke_signed.
    let mut metas: Vec<AccountMeta> = Vec::with_capacity(rules::BUY_LEGACY_ACCOUNTS);
    for (index, account) in remaining.iter().take(rules::BUY_LEGACY_ACCOUNTS).enumerate() {
        let is_signer = index == rules::IX_PAYER;
        if account.is_writable {
            metas.push(AccountMeta::new(*account.key, is_signer));
        } else {
            metas.push(AccountMeta::new_readonly(*account.key, is_signer));
        }
    }
    let instruction = Instruction {
        program_id: tensor_program_id(),
        accounts: metas,
        data: rules::buy_legacy_data(max_price_lamports),
    };
    let account_infos = &remaining[..rules::BUY_LEGACY_ACCOUNTS];
    let vault_seeds: &[&[u8]] = &[VAULT_SEED, mandate_key.as_ref(), &[vault_bump]];
    let vault_before = ctx.accounts.vault.lamports();
    invoke_signed(&instruction, account_infos, &[vault_seeds])?;

    // Postconditions: the real debit is measured, then bounded and receipted.
    let vault_after = ctx.accounts.vault.lamports();
    let total_debit = vault_before
        .checked_sub(vault_after)
        .ok_or(NaError::AmountOverflow)?;
    rules::settle_debits(
        max_price_lamports,
        total_debit,
        authorization_remaining,
        mandate_remaining,
    )
    .map_err(NaError::from)?;

    let delivered = {
        let data = ctx.remaining_accounts[rules::IX_BUYER_TA].try_borrow_data()?;
        rules::TokenAccountState::parse(&data)
    };
    rules::check_delivery(delivered, &expectations).map_err(NaError::from)?;

    let receipt = &mut ctx.accounts.purchase_receipt;
    receipt.version = rules::PURCHASE_RECEIPT_VERSION;
    receipt.mandate = mandate_key;
    receipt.authorization = authorization_key;
    receipt.owner = owner_key;
    receipt.executor = executor_key;
    receipt.mint = expected_mint;
    receipt.listing = listing;
    receipt.marketplace = tensor_program_id();
    receipt.price_lamports = max_price_lamports;
    receipt.total_debit_lamports = total_debit;
    receipt.order_id = order_id;
    receipt.timestamp = now;
    receipt.bump = ctx.bumps.purchase_receipt;

    ctx.accounts.mandate.spent_lamports = mandate_spent
        .checked_add(total_debit)
        .ok_or(NaError::AmountOverflow)?;
    ctx.accounts.nft_authorization.spent_lamports = policy
        .spent_lamports
        .checked_add(total_debit)
        .ok_or(NaError::AmountOverflow)?;

    emit!(NftPurchased {
        mandate: mandate_key,
        owner: owner_key,
        executor: executor_key,
        mint: expected_mint,
        listing,
        marketplace: tensor_program_id(),
        price_lamports: max_price_lamports,
        total_debit_lamports: total_debit,
        order_id,
        timestamp: now,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct CreateNftPurchaseAuthorization<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        seeds = [MANDATE_SEED, owner.key().as_ref()],
        bump = mandate.bump,
        has_one = owner
    )]
    pub mandate: Account<'info, Mandate>,
    #[account(
        init,
        payer = owner,
        space = 8 + NftPurchaseAuthorization::INIT_SPACE,
        seeds = [rules::NFT_AUTH_SEED, mandate.key().as_ref()],
        bump
    )]
    pub nft_authorization: Account<'info, NftPurchaseAuthorization>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CloseNftPurchaseAuthorization<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        seeds = [MANDATE_SEED, owner.key().as_ref()],
        bump = mandate.bump,
        has_one = owner
    )]
    pub mandate: Account<'info, Mandate>,
    #[account(
        mut,
        close = owner,
        has_one = owner,
        seeds = [rules::NFT_AUTH_SEED, mandate.key().as_ref()],
        bump = nft_authorization.bump
    )]
    pub nft_authorization: Account<'info, NftPurchaseAuthorization>,
}

#[derive(Accounts)]
#[instruction(order_id: [u8; 16], expected_mint: Pubkey, max_price_lamports: u64)]
pub struct BuyNftFromMandate<'info> {
    /// Executor authorized by the owner; pays fees and the receipt rent.
    #[account(mut, address = mandate.executor @ NaError::InvalidOwner)]
    pub executor: Signer<'info>,
    #[account(
        mut,
        seeds = [MANDATE_SEED, mandate.owner.as_ref()],
        bump = mandate.bump
    )]
    pub mandate: Account<'info, Mandate>,
    #[account(
        mut,
        seeds = [rules::NFT_AUTH_SEED, mandate.key().as_ref()],
        bump = nft_authorization.bump
    )]
    pub nft_authorization: Account<'info, NftPurchaseAuthorization>,
    /// CHECK: vault PDA recorded in the mandate; re-checked in the handler and used as the
    /// BuyLegacy `payer` signed with these seeds.
    #[account(mut, seeds = [VAULT_SEED, mandate.key().as_ref()], bump = mandate.vault_bump)]
    pub vault: UncheckedAccount<'info>,
    // init (never init_if_needed): one order_id can only ever produce one receipt.
    #[account(
        init,
        payer = executor,
        space = 8 + NftPurchaseReceipt::INIT_SPACE,
        seeds = [rules::PURCHASE_SEED, mandate.key().as_ref(), order_id.as_ref()],
        bump
    )]
    pub purchase_receipt: Account<'info, NftPurchaseReceipt>,
    pub system_program: Program<'info, System>,
}
