//! Unit tests of the pure rules; the sandbox tests (integration-tests/tests/blind_trust.rs) cover
//! the methods end to end.

use super::*;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::testing_env;

fn envelope(excluded: &[&str]) -> TrustEnvelope {
    TrustEnvelope {
        excluded_assets: excluded.iter().map(|s| s.to_string()).collect(),
        period_ms: 86_400_000,
        max_turnover_usd_e6: U128(1_000_000_000),
        min_gap_ms: MIN_GAP_MS,
    }
}

fn trust(pending: Option<PendingChange>) -> Trust {
    Trust {
        id: 1,
        owner: "official.near".parse().unwrap(),
        commitment: "11".repeat(32),
        envelope: envelope(&["nep141:oil.near"]),
        beneficiary: "official.near".parse().unwrap(),
        trust_account: "t1.trust.near".parse().unwrap(),
        cooling_off_ms: 1_000,
        start_ms: 0,
        end_ms: 10_000,
        status: TrustStatus::Active,
        created_at_ms: 0,
        acked_at_ms: Some(0),
        acked_by: None,
        holdings: vec!["idx.near".parse().unwrap()],
        next_seq: 0,
        period_index: 0,
        turnover_in_period_usd_e6: U128(0),
        last_trade_ms: None,
        pending_change: pending,
        ended_at_ms: None,
        label: String::new(),
    }
}

#[test]
fn an_envelope_change_applies_only_after_its_cooling_off() {
    let change = PendingChange {
        kind: ChangeKind::Envelope,
        envelope: Some(envelope(&[])),
        requested_at_ms: 0,
        effective_at_ms: 1_000,
    };
    let mut early = trust(Some(change.clone()));
    apply_due_change(&mut early, 999);
    assert_eq!(early.envelope.excluded_assets.len(), 1);
    assert!(early.pending_change.is_some());
    let mut due = trust(Some(change));
    apply_due_change(&mut due, 1_000);
    assert!(due.envelope.excluded_assets.is_empty());
    assert!(due.pending_change.is_none());
}

#[test]
fn a_cancel_stays_pending_and_counts_only_once_effective() {
    let cancel = PendingChange {
        kind: ChangeKind::Cancel,
        envelope: None,
        requested_at_ms: 0,
        effective_at_ms: 1_000,
    };
    let mut t = trust(Some(cancel));
    apply_due_change(&mut t, 5_000);
    assert!(t.pending_change.is_some());
    assert!(!cancel_effective(&t, 999));
    assert!(cancel_effective(&t, 1_000));
}

#[test]
#[should_panic(expected = "invalid_envelope")]
fn an_exclusion_list_may_not_repeat_an_asset() {
    testing_env!(VMContextBuilder::new().build());
    validate_envelope(&envelope(&["nep141:oil.near", "nep141:oil.near"]));
}

#[test]
#[should_panic(expected = "invalid_envelope")]
fn a_zero_turnover_cap_is_refused() {
    testing_env!(VMContextBuilder::new().build());
    let mut e = envelope(&[]);
    e.max_turnover_usd_e6 = U128(0);
    validate_envelope(&e);
}

#[test]
#[should_panic(expected = "invalid_envelope")]
fn a_gap_under_a_minute_is_refused() {
    testing_env!(VMContextBuilder::new().build());
    let mut e = envelope(&[]);
    e.min_gap_ms = MIN_GAP_MS - 1;
    validate_envelope(&e);
}

#[test]
fn excluded_assets_must_be_nep141_account_ids() {
    testing_env!(VMContextBuilder::new().build());
    validate_envelope(&envelope(&["nep141:oil.near"]));
    for bad in [
        "oil.near",
        "nep141:OIL.near",
        "nep141:",
        "nep141:a..b",
        "erc20:0xabc",
    ] {
        let result = std::panic::catch_unwind(|| validate_envelope(&envelope(&[bad])));
        assert!(result.is_err(), "{bad}");
    }
}
