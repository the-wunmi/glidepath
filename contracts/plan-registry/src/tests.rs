use crate::checks::meets_floor;
use crate::evm::address_from_xy;
use crate::types::*;
use near_sdk::bs58;
use near_sdk::json_types::U128;
use near_sdk::serde_json;

fn plan(token_decimals: u8, quote_decimals: u8, min_price_usd_e6: u128) -> Plan {
    Plan {
        id: 1,
        owner: "owner.near".parse().unwrap(),
        commitment: "00".repeat(32),
        asset: Asset::Nep141 {
            token_id: "token.near".parse().unwrap(),
        },
        token_decimals,
        quote_decimals,
        beneficiary: Beneficiary {
            near_account: "owner.near".parse().unwrap(),
            evm_address: None,
        },
        envelope: Envelope {
            period_ms: 1,
            max_amount_per_period: U128(u128::MAX),
            max_amount_per_tx: U128(u128::MAX),
            min_price_usd_e6: U128(min_price_usd_e6),
            min_gap_ms: 0,
        },
        disclosure: Disclosure::Realtime,
        cooling_off_ms: 0,
        start_ms: 0,
        end_ms: 1,
        status: PlanStatus::Active,
        created_at_ms: 0,
        acked_at_ms: None,
        acked_by: None,
        plan_account: "p1.registry.near".parse().unwrap(),
        evm_address: None,
        evm_nonce: 0,
        evm_sign_pending: false,
        next_seq: 0,
        period_index: 0,
        sold_in_period: U128(0),
        sold_total: U128(0),
        last_sale_ms: None,
        pending_change: None,
        receipt_count: 0,
        label: String::new(),
        proceeds_asset: "nep141:usdc.near".to_string(),
        evm_pending_sign: None,
    }
}

#[test]
fn the_floor_accepts_exactly_the_minimum_price_and_refuses_one_unit_less() {
    // 2 tokens (18 decimals) at a $1.50 floor must return at least 3 USDC (6 decimals).
    let plan = plan(18, 6, 1_500_000);
    let two_tokens = 2 * 10u128.pow(18);
    assert!(meets_floor(&plan, two_tokens, 3_000_000));
    assert!(!meets_floor(&plan, two_tokens, 2_999_999));
}

#[test]
fn the_floor_handles_amounts_whose_products_exceed_u128() {
    let plan = plan(24, 24, 1);
    assert!(meets_floor(&plan, u128::MAX, u128::MAX));
}

#[test]
#[should_panic(expected = "amount_overflow")]
fn the_floor_refuses_products_beyond_u256() {
    let plan = plan(0, 24, u128::MAX);
    meets_floor(&plan, u128::MAX, 1);
}

#[test]
fn an_execute_request_with_an_unknown_field_is_rejected() {
    let base = serde_json::json!({
        "plan_id": 1, "seq": 0, "commitment": "00",
        "action": {"type": "nep141_transfer", "receiver_id": "a.near", "amount": "1", "register_receiver": false},
        "settlement": {"venue": "1click", "correlation_id": "c", "deposit_address": "a.near", "min_amount_out": "1", "destination_asset": "usdc", "quote": {"payload": "{}", "signature": ""}},
        "compliance": {"within_period_budget": true, "within_tx_cap": true, "above_floor": true, "venue_allowed": true, "prices_agree": true, "schedule_ok": true},
        "issued_at_ms": 1, "expires_at_ms": 2
    });
    assert!(serde_json::from_value::<ExecuteRequest>(base.clone()).is_ok());

    let mut extra_top = base.clone();
    extra_top["note"] = serde_json::json!("x");
    assert!(serde_json::from_value::<ExecuteRequest>(extra_top).is_err());

    let mut extra_action = base.clone();
    extra_action["action"]["memo"] = serde_json::json!("x");
    assert!(serde_json::from_value::<ExecuteRequest>(extra_action).is_err());

    let mut extra_compliance = base;
    extra_compliance["compliance"]["override"] = serde_json::json!(true);
    assert!(serde_json::from_value::<ExecuteRequest>(extra_compliance).is_err());
}

#[test]
fn the_derived_address_is_keccak_of_the_mainnet_derived_key() {
    // Live mainnet derived_public_key(example.near, ethereum-1). The expected address was computed
    // independently with viem's keccak256. (The docs' example 0x1b48b83a... does not match the
    // current root key, so it is not used here.)
    let xy = bs58::decode(
        "5zL9u9afiFPPrPmnH7rEz2t3szev5eZ7wXCwzYq37GYyCbJq3YNU31N4LTULioaw3chJx674XUncmYKiSCd3AxxT",
    )
    .into_vec()
    .unwrap();
    assert_eq!(
        address_from_xy(&xy),
        "0xef4ea05e5c11057decc8e1bd6f5369f2acd91fa5"
    );
}

/// Shared with the TypeScript tests; generated there from a live 1Click quote and the simulator.
const ONECLICK_VECTORS: &str = include_str!("../../res/oneclick-quote-vectors.json");

fn oneclick_vectors() -> serde_json::Value {
    serde_json::from_str(ONECLICK_VECTORS).unwrap()
}

fn key_of(public_key: &serde_json::Value) -> [u8; 32] {
    bs58::decode(public_key.as_str().unwrap().trim_start_matches("ed25519:"))
        .into_vec()
        .unwrap()
        .try_into()
        .unwrap()
}

/// A NEP-141 plan the given quote vector was made for.
fn quote_plan(token: &str, plan_account: &str, beneficiary: &str, proceeds: &str) -> Plan {
    let mut plan = plan(18, 6, 1_500_000);
    plan.asset = Asset::Nep141 {
        token_id: token.parse().unwrap(),
    };
    plan.plan_account = plan_account.parse().unwrap();
    plan.beneficiary.near_account = beneficiary.parse().unwrap();
    plan.proceeds_asset = proceeds.to_string();
    plan
}

/// An execute request selling `amount` to `receiver` and carrying `q` with `signature`.
fn quote_request(q: &str, signature: &str, receiver: &str, amount: u128) -> ExecuteRequest {
    let facts: serde_json::Value = serde_json::from_str(q).unwrap();
    serde_json::from_value(serde_json::json!({
        "plan_id": 1, "seq": 0, "commitment": "00",
        "action": {"type": "nep141_transfer", "receiver_id": receiver, "amount": amount.to_string(), "register_receiver": false},
        "settlement": {
            "venue": "1click", "correlation_id": "unsigned-by-1click", "deposit_address": receiver,
            "min_amount_out": facts["minAmountOut"], "destination_asset": facts["destinationAsset"],
            "quote": {"payload": q, "signature": signature},
        },
        "compliance": {"within_period_budget": true, "within_tx_cap": true, "above_floor": true, "venue_allowed": true, "prices_agree": true, "schedule_ok": true},
        "issued_at_ms": 1, "expires_at_ms": 2
    }))
    .unwrap()
}

const SIM_AMOUNT: u128 = 10_000_000_000_000_000_000;
const SIM_RECEIVER: &str = "venue.test.near";
/// The simulator quotes' own timestamp (2026-09-21T13:46:40Z), ten minutes before their deadline.
const SIM_NOW_MS: u64 = 1_789_998_400_000;

fn sim_plan() -> Plan {
    quote_plan(
        "token.test.near",
        "p1.registry.test.near",
        "beneficiary.test.near",
        "nep141:usdc.near",
    )
}

/// Runs `check_quote` for the simulator's standard sale with Q edited by `edit` and re-signed
/// with the simulator key, so only the edit can make it fail.
fn check_sim_quote(edit: impl FnOnce(&mut serde_json::Value)) -> u64 {
    use ed25519_dalek::Signer;
    near_sdk::testing_env!(near_sdk::test_utils::VMContextBuilder::new().build());
    let vectors = oneclick_vectors();
    let mut q: serde_json::Value =
        serde_json::from_str(vectors["sim"]["ordinary"]["q"].as_str().unwrap()).unwrap();
    edit(&mut q);
    // The registry hashes Q exactly as given, so key order cannot affect these checks.
    let q = q.to_string();
    let seed: [u8; 32] = hex::decode(vectors["sim"]["seed_hex"].as_str().unwrap())
        .unwrap()
        .try_into()
        .unwrap();
    let message = crate::oneclick::signed_message(&q);
    let signature = format!(
        "ed25519:{}",
        bs58::encode(
            ed25519_dalek::SigningKey::from_bytes(&seed)
                .sign(message.as_bytes())
                .to_bytes()
        )
        .into_string()
    );
    let request = quote_request(&q, &signature, SIM_RECEIVER, SIM_AMOUNT);
    crate::execute::check_quote(
        &key_of(&vectors["sim"]["public_key"]),
        &sim_plan(),
        &request,
        SIM_AMOUNT,
        SIM_RECEIVER,
        SIM_NOW_MS,
    )
}

/// The exact panic message of `check_sim_quote(edit)`; `should_panic` would also accept a longer
/// code such as `bad_quote_signature` for `bad_quote`.
fn sim_quote_refusal(edit: impl FnOnce(&mut serde_json::Value) + std::panic::UnwindSafe) -> String {
    let panic = std::panic::catch_unwind(|| check_sim_quote(edit)).expect_err("refused");
    let text = panic
        .downcast_ref::<String>()
        .cloned()
        .or_else(|| panic.downcast_ref::<&str>().map(|s| s.to_string()))
        .unwrap_or_default();
    // Host functions (here ed25519_verify) leave the mocked VM's panics wrapped as a HostError.
    match text.split_once("panic_msg: \"") {
        Some((_, rest)) => rest.split('"').next().unwrap_or_default().to_string(),
        None => text,
    }
}

#[test]
fn the_live_1click_quote_verifies_under_1clicks_key_and_a_tampered_copy_does_not() {
    near_sdk::testing_env!(near_sdk::test_utils::VMContextBuilder::new().build());
    let live = &oneclick_vectors()["live"];
    let key = key_of(&live["public_key"]);
    let q = live["q"].as_str().unwrap();
    let signature = live["signature"].as_str().unwrap();
    assert_eq!(
        crate::oneclick::signed_message(q),
        live["signed_message"].as_str().unwrap()
    );
    assert!(crate::oneclick::verify_signature(&key, q, signature));
    let tampered = live["tampered_q"].as_str().unwrap();
    assert!(!crate::oneclick::verify_signature(
        &key, tampered, signature
    ));
}

#[test]
fn the_live_1click_quote_passes_every_registry_check_for_the_sale_it_quotes() {
    near_sdk::testing_env!(near_sdk::test_utils::VMContextBuilder::new().build());
    let live = &oneclick_vectors()["live"];
    let q = live["q"].as_str().unwrap();
    let facts: serde_json::Value = serde_json::from_str(q).unwrap();
    let receiver = facts["depositAddress"].as_str().unwrap();
    let amount: u128 = facts["amountIn"].as_str().unwrap().parse().unwrap();
    let plan = quote_plan(
        "wrap.near",
        "example.near",
        "example.near",
        facts["destinationAsset"].as_str().unwrap(),
    );
    let request = quote_request(q, live["signature"].as_str().unwrap(), receiver, amount);
    // The quote's own timestamp, 2026-11-11T11:40:04.596Z.
    let deadline = crate::execute::check_quote(
        &key_of(&live["public_key"]),
        &plan,
        &request,
        amount,
        receiver,
        1_794_400_804_596,
    );
    assert_eq!(deadline, 1_794_660_003_000);
    assert_eq!(live["cost_within_bound"], serde_json::json!(true));
}

#[test]
fn the_simulator_vectors_pass_check_quote_for_the_standard_sale() {
    near_sdk::testing_env!(near_sdk::test_utils::VMContextBuilder::new().build());
    let vectors = oneclick_vectors();
    let ordinary = &vectors["sim"]["ordinary"];
    let q = ordinary["q"].as_str().unwrap();
    let request = quote_request(
        q,
        ordinary["signature"].as_str().unwrap(),
        SIM_RECEIVER,
        SIM_AMOUNT,
    );
    let deadline = crate::execute::check_quote(
        &key_of(&vectors["sim"]["public_key"]),
        &sim_plan(),
        &request,
        SIM_AMOUNT,
        SIM_RECEIVER,
        SIM_NOW_MS,
    );
    assert_eq!(deadline, 1_789_999_000_000);
    assert_eq!(check_sim_quote(|_| {}), deadline);
}

#[test]
#[should_panic(expected = "quote_fee_too_high")]
fn a_quote_that_costs_more_than_fifty_bps_plus_a_dollar_is_refused() {
    near_sdk::testing_env!(near_sdk::test_utils::VMContextBuilder::new().build());
    let vectors = oneclick_vectors();
    let too_costly = &vectors["sim"]["too_costly"];
    assert_eq!(too_costly["cost_within_bound"], serde_json::json!(false));
    let request = quote_request(
        too_costly["q"].as_str().unwrap(),
        too_costly["signature"].as_str().unwrap(),
        SIM_RECEIVER,
        SIM_AMOUNT,
    );
    crate::execute::check_quote(
        &key_of(&vectors["sim"]["public_key"]),
        &sim_plan(),
        &request,
        SIM_AMOUNT,
        SIM_RECEIVER,
        SIM_NOW_MS,
    );
}

#[test]
#[should_panic(expected = "quote_mismatch")]
fn a_dry_quote_is_refused() {
    check_sim_quote(|q| q["dry"] = serde_json::json!(true));
}

#[test]
#[should_panic(expected = "quote_mismatch")]
fn an_exact_output_quote_is_refused() {
    check_sim_quote(|q| q["swapType"] = serde_json::json!("EXACT_OUTPUT"));
}

#[test]
#[should_panic(expected = "quote_mismatch")]
fn a_quote_selling_another_token_is_refused() {
    check_sim_quote(|q| q["originAsset"] = serde_json::json!("nep141:wrap.near"));
}

#[test]
#[should_panic(expected = "quote_mismatch")]
fn a_quote_paying_anyone_but_the_beneficiary_is_refused() {
    check_sim_quote(|q| q["recipient"] = serde_json::json!("attacker.test.near"));
}

#[test]
#[should_panic(expected = "quote_mismatch")]
fn a_quote_whose_amount_differs_from_its_amount_in_is_refused() {
    check_sim_quote(|q| q["amount"] = serde_json::json!("10000000000000000001"));
}

#[test]
fn a_quote_missing_a_bound_field_is_refused() {
    assert_eq!(
        sim_quote_refusal(|q| {
            q.as_object_mut().unwrap().remove("amountOutUsd");
        }),
        "bad_quote"
    );
}

#[test]
fn a_quote_with_an_unreadable_usd_amount_is_refused() {
    assert_eq!(
        sim_quote_refusal(|q| q["amountInUsd"] = serde_json::json!("1.5e1")),
        "bad_quote"
    );
}

#[test]
fn a_quote_with_an_unreadable_deadline_is_refused() {
    assert_eq!(
        sim_quote_refusal(|q| q["deadline"] = serde_json::json!("2026-09-21 13:56:40")),
        "bad_quote"
    );
}

#[test]
#[should_panic(expected = "quote_expired")]
fn an_expired_quote_is_refused() {
    check_sim_quote(|q| q["deadline"] = serde_json::json!("2026-09-21T13:46:39.999Z"));
}

#[test]
#[should_panic(expected = "quote_deadline_too_far")]
fn a_quote_valid_for_more_than_seven_days_is_refused_by_its_iso_deadline() {
    check_sim_quote(|q| q["deadline"] = serde_json::json!("2026-09-28T13:46:40.001Z"));
}

#[test]
fn a_deadline_exactly_seven_days_ahead_is_accepted() {
    assert_eq!(
        check_sim_quote(|q| q["deadline"] = serde_json::json!("2026-09-28T13:46:40.000Z")),
        SIM_NOW_MS + crate::execute::MAX_QUOTE_TTL_MS
    );
}

/// The simulator's ordinary quote with its signature replaced by `signature`.
fn check_sim_signature(signature: &str) {
    near_sdk::testing_env!(near_sdk::test_utils::VMContextBuilder::new().build());
    let vectors = oneclick_vectors();
    let q = vectors["sim"]["ordinary"]["q"].as_str().unwrap();
    let request = quote_request(q, signature, SIM_RECEIVER, SIM_AMOUNT);
    crate::execute::check_quote(
        &key_of(&vectors["sim"]["public_key"]),
        &sim_plan(),
        &request,
        SIM_AMOUNT,
        SIM_RECEIVER,
        SIM_NOW_MS,
    );
}

#[test]
#[should_panic(expected = "bad_quote_signature")]
fn a_quote_signature_that_is_not_base58_is_refused() {
    check_sim_signature("ed25519:0OIl0OIl");
}

#[test]
#[should_panic(expected = "bad_quote_signature")]
fn a_quote_signature_of_the_wrong_length_is_refused() {
    check_sim_signature(&format!(
        "ed25519:{}",
        bs58::encode([1u8; 63]).into_string()
    ));
}

#[test]
#[should_panic(expected = "bad_quote_signature")]
fn a_quote_signature_in_the_old_simulator_base64_form_is_refused() {
    use near_sdk::base64::Engine;
    let vectors = oneclick_vectors();
    let sig = vectors["sim"]["ordinary"]["signature"].as_str().unwrap();
    let raw = bs58::decode(sig.trim_start_matches("ed25519:"))
        .into_vec()
        .unwrap();
    check_sim_signature(&near_sdk::base64::engine::general_purpose::STANDARD.encode(raw));
}

#[test]
#[should_panic(expected = "bad_quote_signature")]
fn the_live_1click_signature_does_not_cover_a_simulator_quote() {
    check_sim_signature(oneclick_vectors()["live"]["signature"].as_str().unwrap());
}
