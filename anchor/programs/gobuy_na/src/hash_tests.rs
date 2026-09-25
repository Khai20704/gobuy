use super::*;
fn bytes<const N: usize>(value: &str) -> [u8; N] {
    assert_eq!(value.len(), N * 2);
    let mut output = [0; N];
    for (index, byte) in output.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&value[index * 2..index * 2 + 2], 16).unwrap();
    }
    output
}

// Same golden vector as shared/tests/contracts.test.ts, computed with Node SHA-256.
#[test]
fn canonical_proposal_matches_typescript() {
    let input = ProposalInput {
        proposal_id: bytes("00112233445546778899aabbccddeeff"),
        amount: 170000000,
        currency: 1,
        asset_type: 1,
        marketplace: 1,
        seller_claimed_verified: true,
        asset_id_hash: bytes("4109645834d074a887fd7cd0628dfb7743af113d7bb2ebece92e4f5bf9fe3fa0"),
        evidence_hash: bytes("85729ed8282723e0a5399656a71c99bb1622294e449b7d82ab5064d154ac9a62"),
        metadata_hash: bytes("39191446d3e8c3f5ce45ba0f82bffe41af3495564b12356045f1f2dd126d553a"),
        expires_at: 2000000000,
        proposal_hash: [0; 32],
    };
    assert_eq!(
        proposal_digest(&input),
        bytes::<32>("46dd220afb7a52db29a6a89b5d740d12b2d8585a654b793c7d2260478655d112")
    );
}
#[test]
fn canonical_policy_matches_typescript_and_rejects_tampering() {
    let mut input = MandateInput {
        max_amount: 200000000,
        currency: 1,
        asset_type: 1,
        marketplace: 1,
        require_verified_seller: true,
        autonomy: true,
        policy_hash: bytes("169f249c81675717ee1075827a752406c454cd7736b19cd79d19c4853a6452fa"),
    };
    assert!(validate_policy(&input).is_ok());
    input.max_amount += 1;
    assert!(validate_policy(&input).is_err());
}
