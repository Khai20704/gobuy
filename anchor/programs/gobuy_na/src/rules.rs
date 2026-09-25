// Pure deterministic rules. Also executable with rustc --test without Solana tooling.
#[derive(Clone, Copy)]
pub struct Policy {
    pub max_amount: u64,
    pub currency: u8,
    pub asset_type: u8,
    pub marketplace: u8,
    pub require_verified_seller: bool,
    pub autonomy: bool,
}
#[derive(Clone, Copy)]
pub struct Facts {
    pub amount: u64,
    pub currency: u8,
    pub asset_type: u8,
    pub marketplace: u8,
    pub seller_claimed_verified: bool,
    pub expires_at: i64,
}
pub const ALL_CHECKS: u16 = (1 << 9) - 1;
pub fn evaluate(
    p: Policy,
    f: Facts,
    requested_version: u64,
    current_version: u64,
    now: i64,
) -> (u16, u8) {
    let rules = [
        requested_version == current_version,
        f.expires_at > now,
        p.autonomy,
        f.amount <= p.max_amount,
        f.currency == p.currency,
        f.asset_type == p.asset_type,
        f.marketplace == p.marketplace,
        !p.require_verified_seller || f.seller_claimed_verified,
        f.asset_type != 2, // RWA is always read-only, even if a mandate permits the type.
    ];
    let mut checks = 0;
    let mut reason = 0;
    for (index, passed) in rules.iter().enumerate() {
        if *passed {
            checks |= 1 << index;
        } else if reason == 0 {
            reason = index as u8 + 1;
        }
    }
    (checks, reason)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn policy() -> Policy {
        Policy {
            max_amount: 200,
            currency: 1,
            asset_type: 1,
            marketplace: 1,
            require_verified_seller: true,
            autonomy: true,
        }
    }
    fn facts() -> Facts {
        Facts {
            amount: 170,
            currency: 1,
            asset_type: 1,
            marketplace: 1,
            seller_claimed_verified: true,
            expires_at: 1001,
        }
    }
    fn reason(p: Policy, f: Facts) -> u8 {
        evaluate(p, f, 1, 1, 1000).1
    }
    #[test]
    fn approved() {
        assert_eq!(evaluate(policy(), facts(), 1, 1, 1000), (ALL_CHECKS, 0));
    }
    #[test]
    fn price_boundary() {
        assert_eq!(
            reason(
                policy(),
                Facts {
                    amount: 200,
                    ..facts()
                }
            ),
            0
        );
    }
    #[test]
    fn price_exceeded() {
        assert_eq!(
            reason(
                policy(),
                Facts {
                    amount: 201,
                    ..facts()
                }
            ),
            4
        );
    }
    #[test]
    fn integer_extremes() {
        assert_eq!(
            reason(
                policy(),
                Facts {
                    amount: u64::MAX,
                    ..facts()
                }
            ),
            4
        );
    }
    #[test]
    fn currency() {
        assert_eq!(
            reason(
                policy(),
                Facts {
                    currency: 2,
                    ..facts()
                }
            ),
            5
        );
    }
    #[test]
    fn asset_type() {
        assert_eq!(
            reason(
                policy(),
                Facts {
                    asset_type: 2,
                    ..facts()
                }
            ),
            6
        );
    }
    #[test]
    fn marketplace() {
        assert_eq!(
            reason(
                policy(),
                Facts {
                    marketplace: 2,
                    ..facts()
                }
            ),
            7
        );
    }
    #[test]
    fn seller_claim() {
        assert_eq!(
            reason(
                policy(),
                Facts {
                    seller_claimed_verified: false,
                    ..facts()
                }
            ),
            8
        );
    }
    #[test]
    fn seller_optional() {
        assert_eq!(
            reason(
                Policy {
                    require_verified_seller: false,
                    ..policy()
                },
                Facts {
                    seller_claimed_verified: false,
                    ..facts()
                }
            ),
            0
        );
    }
    #[test]
    fn autonomy() {
        assert_eq!(
            reason(
                Policy {
                    autonomy: false,
                    ..policy()
                },
                facts()
            ),
            3
        );
    }
    #[test]
    fn expiry_boundary() {
        assert_eq!(
            reason(
                policy(),
                Facts {
                    expires_at: 1000,
                    ..facts()
                }
            ),
            2
        );
    }
    #[test]
    fn expired() {
        assert_eq!(
            reason(
                policy(),
                Facts {
                    expires_at: 999,
                    ..facts()
                }
            ),
            2
        );
    }
    #[test]
    fn stale_version() {
        assert_eq!(evaluate(policy(), facts(), 1, 2, 1000).1, 1);
    }
    #[test]
    fn future_version() {
        assert_eq!(evaluate(policy(), facts(), 3, 2, 1000).1, 1);
    }
    #[test]
    fn deterministic_priority() {
        let (checks, code) = evaluate(
            Policy {
                autonomy: false,
                ..policy()
            },
            Facts {
                amount: 999,
                expires_at: 1,
                ..facts()
            },
            0,
            1,
            1000,
        );
        assert_eq!(code, 1);
        assert_eq!(checks & 15, 0);
    }
    #[test]
    fn rwa_read_only() {
        assert_eq!(
            reason(
                Policy {
                    asset_type: 2,
                    ..policy()
                },
                Facts {
                    asset_type: 2,
                    ..facts()
                }
            ),
            9
        );
    }
}
