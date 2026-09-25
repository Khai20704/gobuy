#![allow(unexpected_cfgs)]
use anchor_lang::prelude::*;
use solana_sha256_hasher::hashv;
#[cfg(test)]
mod hash_tests;
pub mod rules;

// Undeployed sentinel, NOT a GoBuy deployment ID. Replace via npm run anchor:configure.
declare_id!("11111111111111111111111111111111");

#[program]
pub mod gobuy_na {
    use super::*;

    pub fn initialize_mandate(ctx: Context<InitializeMandate>, input: MandateInput) -> Result<()> {
        validate_policy(&input)?;
        let m = &mut ctx.accounts.mandate;
        m.owner = ctx.accounts.owner.key();
        m.version = 1;
        m.bump = ctx.bumps.mandate;
        m.apply(input);
        Ok(())
    }

    pub fn update_mandate(
        ctx: Context<UpdateMandate>,
        input: MandateInput,
        expected_version: u64,
    ) -> Result<()> {
        validate_policy(&input)?;
        let m = &mut ctx.accounts.mandate;
        require_eq!(m.version, expected_version, NaError::ConcurrentUpdate);
        m.version = m.version.checked_add(1).ok_or(NaError::VersionOverflow)?;
        m.apply(input);
        Ok(())
    }

    pub fn authorize_proposal(
        ctx: Context<AuthorizeProposal>,
        input: ProposalInput,
        mandate_version: u64,
    ) -> Result<()> {
        require!(
            input.proposal_id != [0; 16] && input.amount > 0 && input.expires_at > 0,
            NaError::MalformedProposal
        );
        require!(
            (1..=2).contains(&input.asset_type)
                && (1..=2).contains(&input.marketplace)
                && (1..=2).contains(&input.currency),
            NaError::MalformedProposal
        );
        // Hash binds all normalized instruction fields; there is no approved argument.
        require!(
            proposal_digest(&input) == input.proposal_hash,
            NaError::HashMismatch
        );
        let m = &ctx.accounts.mandate;
        let timestamp = Clock::get()?.unix_timestamp;
        let (checks, reason_code) = rules::evaluate(
            rules::Policy {
                max_amount: m.max_amount,
                currency: m.currency,
                asset_type: m.asset_type,
                marketplace: m.marketplace,
                require_verified_seller: m.require_verified_seller,
                autonomy: m.autonomy,
            },
            rules::Facts {
                amount: input.amount,
                currency: input.currency,
                asset_type: input.asset_type,
                marketplace: input.marketplace,
                seller_claimed_verified: input.seller_claimed_verified,
                expires_at: input.expires_at,
            },
            mandate_version,
            m.version,
            timestamp,
        );
        // Rule failures return success so a durable REJECTED record is committed.
        let record = &mut ctx.accounts.action_record;
        record.mandate = m.key();
        record.owner = m.owner;
        record.proposal_id = input.proposal_id;
        record.proposal_hash = input.proposal_hash;
        record.mandate_version = mandate_version;
        record.current_version = m.version;
        record.approved = checks == rules::ALL_CHECKS;
        record.reason_code = reason_code;
        record.checks = checks;
        record.timestamp = timestamp;
        record.bump = ctx.bumps.action_record;
        Ok(())
    }
}

fn validate_policy(input: &MandateInput) -> Result<()> {
    require!(
        input.max_amount > 0
            && input.currency == 1
            && (1..=2).contains(&input.asset_type)
            && (1..=2).contains(&input.marketplace),
        NaError::InvalidPolicy
    );
    let expected = hashv(&[
        b"gobuy:policy:v1",
        &input.max_amount.to_le_bytes(),
        &[
            input.currency,
            input.asset_type,
            input.marketplace,
            input.require_verified_seller as u8,
            input.autonomy as u8,
        ],
    ])
    .to_bytes();
    require!(expected == input.policy_hash, NaError::HashMismatch);
    Ok(())
}

pub fn proposal_digest(input: &ProposalInput) -> [u8; 32] {
    hashv(&[
        b"gobuy:proposal:v1",
        &input.proposal_id,
        &input.amount.to_le_bytes(),
        &[
            input.currency,
            input.asset_type,
            input.marketplace,
            input.seller_claimed_verified as u8,
        ],
        &input.asset_id_hash,
        &input.evidence_hash,
        &input.metadata_hash,
        &input.expires_at.to_le_bytes(),
    ])
    .to_bytes()
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct MandateInput {
    pub max_amount: u64,
    pub currency: u8,
    pub asset_type: u8,
    pub marketplace: u8,
    pub require_verified_seller: bool,
    pub autonomy: bool,
    pub policy_hash: [u8; 32],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ProposalInput {
    pub proposal_id: [u8; 16],
    pub amount: u64,
    pub currency: u8,
    pub asset_type: u8,
    pub marketplace: u8,
    pub seller_claimed_verified: bool,
    pub asset_id_hash: [u8; 32],
    pub evidence_hash: [u8; 32],
    pub metadata_hash: [u8; 32],
    pub expires_at: i64,
    pub proposal_hash: [u8; 32],
}

#[derive(Accounts)]
pub struct InitializeMandate<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(init, payer = owner, space = 8 + Mandate::INIT_SPACE, seeds = [b"mandate", owner.key().as_ref()], bump)]
    pub mandate: Account<'info, Mandate>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateMandate<'info> {
    pub owner: Signer<'info>,
    #[account(mut, has_one = owner, seeds = [b"mandate", owner.key().as_ref()], bump = mandate.bump)]
    pub mandate: Account<'info, Mandate>,
}

#[derive(Accounts)]
#[instruction(input: ProposalInput)]
pub struct AuthorizeProposal<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(has_one = owner, seeds = [b"mandate", owner.key().as_ref()], bump = mandate.bump)]
    pub mandate: Account<'info, Mandate>,
    // ID-based PDA blocks a replay even if the hash or mandate version is changed.
    // init (never init_if_needed): existing IDs cannot overwrite audit records.
    #[account(init, payer = owner, space = 8 + ActionRecord::INIT_SPACE,
        seeds = [b"action", mandate.key().as_ref(), input.proposal_id.as_ref()], bump)]
    pub action_record: Account<'info, ActionRecord>,
    pub system_program: Program<'info, System>,
}

#[account]
#[derive(InitSpace)]
pub struct Mandate {
    pub owner: Pubkey,
    pub version: u64,
    pub max_amount: u64,
    pub currency: u8,
    pub asset_type: u8,
    pub marketplace: u8,
    pub require_verified_seller: bool,
    pub autonomy: bool,
    pub policy_hash: [u8; 32],
    pub bump: u8,
}
impl Mandate {
    fn apply(&mut self, input: MandateInput) {
        self.max_amount = input.max_amount;
        self.currency = input.currency;
        self.asset_type = input.asset_type;
        self.marketplace = input.marketplace;
        self.require_verified_seller = input.require_verified_seller;
        self.autonomy = input.autonomy;
        self.policy_hash = input.policy_hash;
    }
}

#[account]
#[derive(InitSpace)]
pub struct ActionRecord {
    pub mandate: Pubkey,
    pub owner: Pubkey,
    pub proposal_id: [u8; 16],
    pub proposal_hash: [u8; 32],
    pub mandate_version: u64,
    pub current_version: u64,
    pub approved: bool,
    pub reason_code: u8,
    pub checks: u16,
    pub timestamp: i64,
    pub bump: u8,
}

#[error_code]
pub enum NaError {
    #[msg("Malformed proposal fields")]
    MalformedProposal,
    #[msg("Hash does not match canonical fields")]
    HashMismatch,
    #[msg("Invalid mandate constraints")]
    InvalidPolicy,
    #[msg("Mandate version overflow")]
    VersionOverflow,
    #[msg("Mandate changed; refresh before updating")]
    ConcurrentUpdate,
}
