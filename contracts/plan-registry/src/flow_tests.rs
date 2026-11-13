//! Mocked-chain tests for paths the sandbox cannot reach quickly or at all: callbacks with
//! malformed or wrong-key signatures, lost callbacks, and the 7-day change window.

use crate::execute::STALE_SIGN_BLOCKS;
use crate::plans::CHANGE_APPLY_WINDOW_MS;
use crate::*;
use ed25519_dalek::Signer;
use near_sdk::base64::engine::general_purpose::STANDARD as BASE64;
use near_sdk::base64::Engine;
use near_sdk::serde_json::{json, Value};
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::{testing_env, Gas, PromiseResult, RuntimeFeesConfig};
use sha3::Digest;

const T0_MS: u64 = 1_800_000_000_000;
const PLAN_ID: u64 = 1;
const EVM_TOKEN: &str = "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238";
const EVM_VENUE: &str = "0x2222222222222222222222222222222222222222";
const PROCEEDS: &str = "nep141:usdc.near";

fn account(name: &str) -> AccountId {
    name.parse().unwrap()
}

struct Chain {
    registry: PlanRegistry,
    enclave: ed25519_dalek::SigningKey,
    quote: ed25519_dalek::SigningKey,
    mpc: k256::ecdsa::SigningKey,
    now: u64,
    height: u64,
    /// How far ahead the quotes built by `execute_evm` expire.
    quote_ttl_ms: u64,
}

impl Chain {
    fn context(&self, predecessor: &str, deposit: NearToken, results: Vec<PromiseResult>) {
        let context = VMContextBuilder::new()
            .current_account_id(account("registry.near"))
            .predecessor_account_id(account(predecessor))
            .block_timestamp(self.now * 1_000_000)
            .block_height(self.height)
            .attached_deposit(deposit)
            .prepaid_gas(Gas::from_tgas(300))
            .account_balance(NearToken::from_near(1_000))
            .build();
        testing_env!(
            context,
            near_sdk::test_vm_config(),
            RuntimeFeesConfig::test(),
            Default::default(),
            results
        );
    }

    fn as_caller(&self, predecessor: &str, deposit: NearToken) {
        self.context(predecessor, deposit, vec![]);
    }

    fn advance(&mut self, ms: u64, blocks: u64) {
        self.now += ms;
        self.height += blocks;
    }

    fn evm_address(&self) -> String {
        let point = self.mpc.verifying_key().to_encoded_point(false);
        let hash = sha3::Keccak256::digest(&point.as_bytes()[1..]);
        format!("0x{}", hex::encode(&hash[12..]))
    }

    fn sign(&self, key: &ed25519_dalek::SigningKey, domain: &str, message: &str) -> String {
        BASE64.encode(
            key.sign(&[domain.as_bytes(), message.as_bytes()].concat())
                .to_bytes(),
        )
    }

    fn ack(&mut self, commitment: &str, envelope: &Value) {
        let ack = json!({
            "type": "ack", "plan_id": PLAN_ID, "commitment": commitment, "envelope": envelope,
            "within_envelope": true, "issued_at_ms": self.now,
        })
        .to_string();
        let signature = self.sign(&self.enclave, "vsp/ack/v1\n", &ack);
        self.as_caller("relayer.near", NearToken::from_near(1));
        self.registry
            .ack_plan(PLAN_ID, ack, signature, enclave_key(&self.enclave));
    }

    fn execute_evm(&mut self, amount: u128) {
        let plan = self.registry.get_plan(PLAN_ID).unwrap();
        let min_out = amount * 1_500_000 / 10u128.pow(18);
        let payload = stable_stringify(&json!({
            "amount": amount.to_string(), "amountIn": amount.to_string(),
            "amountInUsd": "15.050000000000", "amountOutUsd": "15.000000000000",
            "deadline": crate::oneclick::format_timestamp_ms(self.now + self.quote_ttl_ms),
            "depositAddress": EVM_VENUE, "destinationAsset": PROCEEDS, "dry": false,
            "minAmountOut": min_out.to_string(),
            "originAsset": format!("nep141:sepolia-{EVM_TOKEN}.omft.near"),
            "recipient": "beneficiary.near", "refundTo": self.evm_address(),
            "swapType": "EXACT_INPUT",
        }));
        let request = json!({
            "plan_id": PLAN_ID, "seq": plan.next_seq, "commitment": plan.commitment,
            "action": {
                "type": "evm_erc20_transfer", "to": EVM_VENUE, "amount": amount.to_string(),
                "nonce": plan.evm_nonce, "gas_limit": 65_000,
                "max_fee_per_gas": "30000000000", "max_priority_fee_per_gas": "1500000000",
            },
            "settlement": {
                "venue": "1click", "correlation_id": "q-1", "deposit_address": EVM_VENUE,
                "min_amount_out": min_out.to_string(), "destination_asset": PROCEEDS,
                "quote": { "signature": quote_signature(&self.quote, &payload), "payload": payload },
            },
            "compliance": {
                "within_period_budget": true, "within_tx_cap": true, "above_floor": true,
                "venue_allowed": true, "prices_agree": true, "schedule_ok": true,
            },
            "issued_at_ms": self.now, "expires_at_ms": self.now + 60_000,
        })
        .to_string();
        let signature = self.sign(&self.enclave, "vsp/execute/v1\n", &request);
        self.as_caller("relayer.near", NearToken::from_near(1));
        let _ = self
            .registry
            .execute(PLAN_ID, request, signature, enclave_key(&self.enclave));
    }

    /// Runs `on_signed` for `seq` as the signer's callback would, with `result` as its input.
    fn deliver_signature(&mut self, seq: u64, result: PromiseResult) -> Option<EvmSignature> {
        self.context("registry.near", NearToken::from_yoctonear(0), vec![result]);
        self.registry.on_signed(PLAN_ID, seq)
    }

    fn signature_by(&self, key: &k256::ecdsa::SigningKey, seq: u64) -> PromiseResult {
        let receipt = &self.registry.get_receipts(PLAN_ID, Some(seq), Some(1))[0];
        let hash = hex::decode(&receipt.action_hash).unwrap();
        let (sig, recovery_id) = key.sign_prehash_recoverable(&hash).unwrap();
        let mut big_r = vec![0x02 | u8::from(recovery_id.is_y_odd())];
        big_r.extend_from_slice(&sig.r().to_bytes());
        let response = json!({
            "scheme": "Secp256k1",
            "big_r": { "affine_point": hex::encode(big_r) },
            "s": { "scalar": hex::encode(sig.s().to_bytes()) },
            "recovery_id": recovery_id.to_byte(),
        });
        PromiseResult::Successful(response.to_string().into_bytes())
    }

    fn plan(&self) -> Plan {
        self.registry.get_plan(PLAN_ID).unwrap()
    }
}

/// 1Click's format: `"ed25519:<base58>"` over the text of base58(sha256(q)).
fn quote_signature(key: &ed25519_dalek::SigningKey, q: &str) -> String {
    let message = crate::oneclick::signed_message(q);
    format!(
        "ed25519:{}",
        bs58::encode(key.sign(message.as_bytes()).to_bytes()).into_string()
    )
}

/// JSON with object keys sorted and no spaces, as 1Click stringifies a quote. near-sdk turns on
/// serde_json's `preserve_order`, so plain `to_string` would keep insertion order.
fn stable_stringify(value: &Value) -> String {
    match value {
        Value::Object(map) => {
            let mut entries: Vec<_> = map.iter().collect();
            entries.sort_by(|a, b| a.0.cmp(b.0));
            let body: Vec<String> = entries
                .into_iter()
                .map(|(k, v)| format!("{}:{}", Value::from(k.as_str()), stable_stringify(v)))
                .collect();
            format!("{{{}}}", body.join(","))
        }
        Value::Array(items) => {
            let body: Vec<String> = items.iter().map(stable_stringify).collect();
            format!("[{}]", body.join(","))
        }
        other => other.to_string(),
    }
}

fn enclave_key(key: &ed25519_dalek::SigningKey) -> String {
    format!(
        "ed25519:{}",
        bs58::encode(key.verifying_key().as_bytes()).into_string()
    )
}

fn envelope() -> Value {
    json!({
        "period_ms": 86_400_000u64,
        "max_amount_per_period": (1_000u128 * 10u128.pow(18)).to_string(),
        "max_amount_per_tx": (100u128 * 10u128.pow(18)).to_string(),
        "min_price_usd_e6": "1500000",
        "min_gap_ms": 0,
    })
}

/// An active EVM plan whose derived address belongs to a known test MPC key.
fn active_evm_plan() -> Chain {
    let mut chain = Chain {
        registry: {
            let context = VMContextBuilder::new()
                .current_account_id(account("registry.near"))
                .predecessor_account_id(account("governance.near"))
                .block_timestamp(T0_MS * 1_000_000)
                .build();
            testing_env!(context);
            PlanRegistry::new(
                account("governance.near"),
                account("signer.near"),
                1_000,
                1_000,
            )
        },
        enclave: ed25519_dalek::SigningKey::from_bytes(&[42u8; 32]),
        quote: ed25519_dalek::SigningKey::from_bytes(&[44u8; 32]),
        mpc: k256::ecdsa::SigningKey::from_bytes(&[9u8; 32].into()).unwrap(),
        now: T0_MS,
        height: 100,
        quote_ttl_ms: 60_000,
    };
    chain.registry.config.plan_account_code_hash = Some([1u8; 32]);
    chain.as_caller("governance.near", NearToken::from_near(1));
    chain.registry.register_enclave(
        enclave_key(&chain.enclave),
        Measurements {
            mrtd: "aa".repeat(48),
            rtmr0: "bb".repeat(48),
            rtmr1: "cc".repeat(48),
            rtmr2: "dd".repeat(48),
            rtmr3: "ee".repeat(48),
        },
        "ab".repeat(32),
    );
    chain.registry.set_quote_signer(enclave_key(&chain.quote));
    chain.registry.set_proceeds_asset(PROCEEDS.to_string(), 6);
    chain.advance(1_000, 4);

    chain.as_caller("owner.near", NearToken::from_near(1));
    let plan_id = chain.registry.create_plan(
        "22".repeat(32),
        Asset::EvmErc20 {
            chain_id: 11_155_111,
            token_address: EVM_TOKEN.to_string(),
        },
        18,
        6,
        Beneficiary {
            near_account: account("beneficiary.near"),
            evm_address: None,
        },
        near_sdk::serde_json::from_value(envelope()).unwrap(),
        Disclosure::Realtime,
        2_000,
        chain.now - 1,
        chain.now + 30 * 86_400_000,
        String::new(),
        PROCEEDS.to_string(),
    );
    assert_eq!(plan_id, PLAN_ID);
    let address = chain.evm_address();
    chain.registry.plan_mut(PLAN_ID).evm_address = Some(address);
    chain.ack(&"22".repeat(32), &envelope());
    chain
}

#[test]
fn a_correct_mpc_signature_settles_the_sale() {
    let mut chain = active_evm_plan();
    chain.execute_evm(10u128.pow(19));
    let result = chain.signature_by(&chain.mpc.clone(), 0);
    assert!(chain.deliver_signature(0, result).is_some());
    let plan = chain.plan();
    assert_eq!(plan.evm_nonce, 1);
    assert!(!plan.evm_sign_pending && plan.evm_pending_sign.is_none());
    let receipt = &chain.registry.get_receipts(PLAN_ID, None, None)[0];
    assert_eq!(receipt.status, ReceiptStatus::Done);
}

#[test]
fn an_evm_signature_that_does_not_recover_to_the_plan_address_fails_the_sale() {
    let mut chain = active_evm_plan();
    chain.execute_evm(10u128.pow(19));
    let stranger = k256::ecdsa::SigningKey::from_bytes(&[10u8; 32].into()).unwrap();
    let result = chain.signature_by(&stranger, 0);
    assert!(chain.deliver_signature(0, result).is_none());

    let plan = chain.plan();
    let receipt = &chain.registry.get_receipts(PLAN_ID, None, None)[0];
    assert_eq!(receipt.status, ReceiptStatus::Failed);
    assert_eq!(receipt.evm_signature, None);
    assert_eq!(plan.evm_nonce, 0, "the nonce is returned");
    assert_eq!(plan.sold_total.0, 0, "the budget is returned");
    assert!(get_logs().iter().any(|l| l.contains("signature_mismatch")));
}

#[test]
fn an_unreadable_signer_response_fails_the_sale_without_panicking() {
    let mut chain = active_evm_plan();
    chain.execute_evm(10u128.pow(19));
    let garbage = PromiseResult::Successful(b"{\"scheme\":\"Secp256k1\",\"big_r\":7}".to_vec());
    assert!(chain.deliver_signature(0, garbage).is_none());
    assert_eq!(
        chain.registry.get_receipts(PLAN_ID, None, None)[0].status,
        ReceiptStatus::Failed
    );
    assert!(get_logs()
        .iter()
        .any(|l| l.contains("bad_signature_response")));

    chain.advance(1_000, 3); // a fresh quote: the first one is used
    chain.execute_evm(10u128.pow(19));
    assert!(chain.deliver_signature(1, PromiseResult::Failed).is_none());
    assert!(!chain.plan().evm_sign_pending);
}

#[test]
#[should_panic(expected = "sign_not_stale")]
fn a_pending_sign_cannot_be_cleared_before_it_is_stale() {
    let mut chain = active_evm_plan();
    chain.execute_evm(10u128.pow(19));
    chain.advance(90_000, STALE_SIGN_BLOCKS);
    chain.as_caller("anyone.near", NearToken::from_yoctonear(0));
    chain.registry.clear_stale_sign(PLAN_ID);
}

#[test]
fn a_lost_sign_callback_can_be_cleared_after_300_blocks_and_a_late_callback_changes_nothing() {
    let mut chain = active_evm_plan();
    chain.execute_evm(10u128.pow(19));
    assert!(chain.plan().evm_sign_pending);
    chain.advance(100_000, STALE_SIGN_BLOCKS + 1);
    chain.as_caller("anyone.near", NearToken::from_yoctonear(0));
    chain.registry.clear_stale_sign(PLAN_ID);

    let plan = chain.plan();
    assert!(!plan.evm_sign_pending);
    assert_eq!(plan.evm_nonce, 0);
    assert_eq!(plan.sold_total.0, 0);
    assert_eq!(
        chain.registry.get_receipts(PLAN_ID, None, None)[0].status,
        ReceiptStatus::Failed
    );

    // The signature arrives after all: it is ignored, the receipt stays failed.
    let late = chain.signature_by(&chain.mpc.clone(), 0);
    assert!(chain.deliver_signature(0, late).is_none());
    assert_eq!(
        chain.registry.get_receipts(PLAN_ID, None, None)[0].status,
        ReceiptStatus::Failed
    );
    assert_eq!(chain.plan().evm_nonce, 0);
}

fn request_change(chain: &mut Chain) -> PendingChange {
    let mut new_envelope = envelope();
    new_envelope["max_amount_per_tx"] = json!((20u128 * 10u128.pow(18)).to_string());
    chain.as_caller("owner.near", NearToken::from_near(1));
    chain.registry.request_change(
        PLAN_ID,
        "33".repeat(32),
        near_sdk::serde_json::from_value(new_envelope).unwrap(),
    );
    chain.plan().pending_change.unwrap()
}

#[test]
#[should_panic(expected = "change_expired")]
fn a_change_not_applied_within_seven_days_of_taking_effect_lapses() {
    let mut chain = active_evm_plan();
    let change = request_change(&mut chain);
    chain.now = change.effective_at_ms + CHANGE_APPLY_WINDOW_MS + 1;
    let envelope = near_sdk::serde_json::to_value(change.envelope.unwrap()).unwrap();
    chain.ack(&"33".repeat(32), &envelope);
}

#[test]
fn anyone_can_clear_a_lapsed_change_but_not_a_live_one() {
    let mut chain = active_evm_plan();
    let change = request_change(&mut chain);
    chain.now = change.effective_at_ms + CHANGE_APPLY_WINDOW_MS;
    chain.as_caller("anyone.near", NearToken::from_yoctonear(0));
    let early = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        chain.registry.expire_change(PLAN_ID)
    }));
    assert!(
        early.is_err(),
        "a change inside its window must not be cleared"
    );

    chain.now += 1;
    chain.as_caller("anyone.near", NearToken::from_yoctonear(0));
    chain.registry.expire_change(PLAN_ID);
    assert!(chain.plan().pending_change.is_none());
    assert!(get_logs()
        .iter()
        .any(|l| l.contains(r#""event":"change_expired""#)));
}

#[test]
#[should_panic(expected = "cooling_off")]
fn an_ack_signed_before_the_change_took_effect_cannot_apply_it() {
    let mut chain = active_evm_plan();
    let change = request_change(&mut chain);
    let envelope = near_sdk::serde_json::to_value(change.envelope.unwrap()).unwrap();
    let ack = json!({
        "type": "ack", "plan_id": PLAN_ID, "commitment": "33".repeat(32), "envelope": envelope,
        "within_envelope": true, "issued_at_ms": change.effective_at_ms - 1,
    })
    .to_string();
    let signature = chain.sign(&chain.enclave, "vsp/ack/v1\n", &ack);
    chain.now = change.effective_at_ms + 10;
    chain.as_caller("relayer.near", NearToken::from_near(1));
    chain
        .registry
        .ack_plan(PLAN_ID, ack, signature, enclave_key(&chain.enclave));
}

#[test]
#[should_panic(expected = "activation_delay_too_short")]
fn a_registry_refuses_an_activation_delay_shorter_than_the_cooling_off() {
    testing_env!(VMContextBuilder::new().build());
    PlanRegistry::new(
        account("governance.near"),
        account("signer.near"),
        600_000,
        599_999,
    );
}

#[test]
fn a_completed_transfer_with_a_large_return_value_still_settles() {
    let mut chain = active_evm_plan();
    chain.execute_evm(10u128.pow(19));
    // Whatever a token returns, only success or failure of the promise counts.
    chain.context(
        "registry.near",
        NearToken::from_yoctonear(0),
        vec![PromiseResult::Successful(vec![b'7'; 4096])],
    );
    assert!(chain.registry.on_send_done(PLAN_ID, 0));
    assert_eq!(
        chain.registry.get_receipts(PLAN_ID, None, None)[0].status,
        ReceiptStatus::Done
    );
    assert_eq!(chain.plan().sold_total.0, 10u128.pow(19));
}

#[test]
#[should_panic(expected = "quote_decimals_mismatch")]
fn a_plan_cannot_misstate_the_decimals_of_its_proceeds_asset() {
    let mut chain = active_evm_plan();
    chain.as_caller("owner.near", NearToken::from_near(1));
    chain.registry.create_plan(
        "44".repeat(32),
        Asset::EvmErc20 {
            chain_id: 1,
            token_address: EVM_TOKEN.to_string(),
        },
        18,
        0,
        Beneficiary {
            near_account: account("beneficiary.near"),
            evm_address: None,
        },
        near_sdk::serde_json::from_value(envelope()).unwrap(),
        Disclosure::Realtime,
        2_000,
        chain.now,
        chain.now + 86_400_000,
        String::new(),
        PROCEEDS.to_string(),
    );
}

fn settle(chain: &mut Chain, seq: u64) {
    let result = chain.signature_by(&chain.mpc.clone(), seq);
    assert!(chain.deliver_signature(seq, result).is_some());
}

#[test]
#[should_panic(expected = "quote_used")]
fn a_quote_cannot_be_used_twice() {
    let mut chain = active_evm_plan();
    chain.execute_evm(10u128.pow(19));
    settle(&mut chain, 0);
    // Same payload (same time and amount), new seq and enclave signature.
    chain.execute_evm(10u128.pow(19));
}

#[test]
#[should_panic(expected = "quote_deadline_too_far")]
fn a_quote_valid_for_more_than_seven_days_is_refused() {
    let mut chain = active_evm_plan();
    chain.quote_ttl_ms = crate::execute::MAX_QUOTE_TTL_MS + 1;
    chain.execute_evm(10u128.pow(19));
}

#[test]
fn expired_used_quotes_are_pruned() {
    let mut chain = active_evm_plan();
    chain.execute_evm(10u128.pow(19));
    settle(&mut chain, 0);
    assert_eq!(chain.registry.used_quote_count(), 1);

    chain.as_caller("anyone.near", NearToken::from_yoctonear(0));
    assert_eq!(chain.registry.prune_used_quotes(None), 0, "not yet expired");
    chain.advance(60_001, 200);
    chain.as_caller("anyone.near", NearToken::from_yoctonear(0));
    assert_eq!(chain.registry.prune_used_quotes(Some(5)), 1);
    assert_eq!(chain.registry.used_quote_count(), 0);

    // `execute` also prunes from the front as it records new quotes.
    chain.execute_evm(10u128.pow(19));
    settle(&mut chain, 1);
    chain.advance(60_001, 200);
    chain.execute_evm(10u128.pow(19));
    assert_eq!(chain.registry.used_quote_count(), 1);
}

fn register_enclave(chain: &mut Chain, key: &ed25519_dalek::SigningKey) {
    chain.as_caller("governance.near", NearToken::from_near(1));
    chain.registry.register_enclave(
        enclave_key(key),
        Measurements {
            mrtd: "aa".repeat(48),
            rtmr0: "bb".repeat(48),
            rtmr1: "cc".repeat(48),
            rtmr2: "dd".repeat(48),
            rtmr3: "ee".repeat(48),
        },
        "ab".repeat(32),
    );
}

#[test]
#[should_panic(expected = "key_too_new_for_plan")]
fn an_enclave_registered_after_the_plan_waits_out_the_plans_cooling_off() {
    let mut chain = active_evm_plan();
    let new_key = ed25519_dalek::SigningKey::from_bytes(&[50u8; 32]);
    register_enclave(&mut chain, &new_key);
    // Past the global activation delay (1 s) but not the plan's cooling-off (2 s).
    chain.advance(1_500, 5);
    chain.enclave = new_key;
    chain.execute_evm(10u128.pow(19));
}

#[test]
fn an_enclave_registered_after_the_plan_acts_once_the_plans_cooling_off_has_passed() {
    let mut chain = active_evm_plan();
    let new_key = ed25519_dalek::SigningKey::from_bytes(&[50u8; 32]);
    register_enclave(&mut chain, &new_key);
    chain.advance(2_000, 7);
    chain.enclave = new_key;
    chain.execute_evm(10u128.pow(19));
    settle(&mut chain, 0);
}

#[test]
#[should_panic(expected = "key_too_new_for_plan")]
fn a_quote_key_set_after_the_plan_waits_out_the_plans_cooling_off() {
    let mut chain = active_evm_plan();
    let new_key = ed25519_dalek::SigningKey::from_bytes(&[51u8; 32]);
    chain.as_caller("governance.near", NearToken::from_yoctonear(0));
    chain.registry.set_quote_signer(enclave_key(&new_key));
    chain.advance(1_500, 5);
    chain.quote = new_key;
    chain.execute_evm(10u128.pow(19));
}

#[test]
fn keys_registered_before_the_plan_was_created_act_at_once() {
    // The fixture's enclave and quote key predate the plan, which acts in the same second.
    let mut chain = active_evm_plan();
    chain.execute_evm(10u128.pow(19));
    settle(&mut chain, 0);
}

/// Creates plan 2 committing to `plan_json` with `salt`, then cancels and finalizes it.
fn ended_plan_with_commitment(chain: &mut Chain, plan_json: &str, salt: [u8; 32]) -> u64 {
    let commitment = hex::encode(sha2_256(&[plan_json.as_bytes(), &salt].concat()));
    chain.as_caller("owner.near", NearToken::from_near(1));
    let plan_id = chain.registry.create_plan(
        commitment,
        Asset::EvmErc20 {
            chain_id: 1,
            token_address: EVM_TOKEN.to_string(),
        },
        18,
        6,
        Beneficiary {
            near_account: account("beneficiary.near"),
            evm_address: None,
        },
        near_sdk::serde_json::from_value(envelope()).unwrap(),
        Disclosure::EndReveal,
        2_000,
        chain.now,
        chain.now + 86_400_000,
        String::new(),
        PROCEEDS.to_string(),
    );
    chain.as_caller("owner.near", NearToken::from_near(1));
    chain.registry.request_cancel(plan_id);
    chain.advance(2_000, 7);
    chain.as_caller("anyone.near", NearToken::from_yoctonear(0));
    let _ = chain.registry.finalize(plan_id);
    plan_id
}

fn sha2_256(bytes: &[u8]) -> [u8; 32] {
    near_sdk::env::sha256_array(bytes)
}

const PLAN_JSON: &str = r#"{"floor_usd_e6":"1500000","version":1}"#;

fn reveal(chain: &mut Chain, plan_id: u64, salt: &[u8; 32]) {
    chain.as_caller("auditor.near", NearToken::from_near(1));
    chain
        .registry
        .reveal_plan(plan_id, PLAN_JSON.to_string(), hex::encode(salt));
}

#[test]
fn a_correct_reveal_after_the_end_is_stored() {
    let mut chain = active_evm_plan();
    let plan_id = ended_plan_with_commitment(&mut chain, PLAN_JSON, [7u8; 32]);
    reveal(&mut chain, plan_id, &[7u8; 32]);
    let stored = chain.registry.get_reveal(plan_id).expect("reveal");
    assert_eq!(stored.plan_json, PLAN_JSON);
    assert_eq!(stored.salt, hex::encode([7u8; 32]));
    assert_eq!(stored.revealed_by, account("auditor.near"));
    assert!(get_logs()
        .iter()
        .any(|l| l.contains(r#""event":"plan_revealed""#)));
}

#[test]
#[should_panic(expected = "commitment_mismatch")]
fn a_reveal_with_the_wrong_salt_is_refused() {
    let mut chain = active_evm_plan();
    let plan_id = ended_plan_with_commitment(&mut chain, PLAN_JSON, [7u8; 32]);
    reveal(&mut chain, plan_id, &[8u8; 32]);
}

#[test]
#[should_panic(expected = "not_ended")]
fn a_reveal_before_the_plan_ends_is_refused() {
    let mut chain = active_evm_plan();
    reveal(&mut chain, PLAN_ID, &[7u8; 32]);
}

#[test]
#[should_panic(expected = "already_revealed")]
fn a_plan_can_be_revealed_only_once() {
    let mut chain = active_evm_plan();
    let plan_id = ended_plan_with_commitment(&mut chain, PLAN_JSON, [7u8; 32]);
    reveal(&mut chain, plan_id, &[7u8; 32]);
    reveal(&mut chain, plan_id, &[7u8; 32]);
}
