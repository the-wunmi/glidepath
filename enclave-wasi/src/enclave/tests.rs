use super::*;
use crate::local_keys::LocalKeys;
use chacha20poly1305::{aead::Aead, ChaCha20Poly1305, KeyInit};
use ed25519_dalek::{Signer, SigningKey, Verifier, VerifyingKey};
use hkdf::Hkdf;
use sha2::{Digest, Sha256};

const START: i64 = 1_800_000_000_000;
const DAY: i64 = 86_400_000;

/// `sealTo` (packages/core/src/seal.ts) with a fixed ephemeral key.
fn seal_to(recipient_hex: &str, plaintext: &str) -> SealedBox {
    let esk = x25519_dalek::StaticSecret::from([7u8; 32]);
    let epk = x25519_dalek::PublicKey::from(&esk);
    let recipient: [u8; 32] = hex::decode(recipient_hex).unwrap().try_into().unwrap();
    let shared = esk.diffie_hellman(&x25519_dalek::PublicKey::from(recipient));
    let mut key = [0u8; 32];
    Hkdf::<Sha256>::new(
        Some(&[epk.as_bytes().as_slice(), &recipient].concat()),
        shared.as_bytes(),
    )
    .expand(b"vsp/seal/v1", &mut key)
    .unwrap();
    let nonce = [9u8; 12];
    let ct = ChaCha20Poly1305::new(&key.into())
        .encrypt(&nonce.into(), plaintext.as_bytes())
        .unwrap();
    SealedBox {
        v: 1,
        epk: hex::encode(epk.as_bytes()),
        nonce: hex::encode(nonce),
        ct: B64.encode(ct),
    }
}

fn plan_json() -> Value {
    json!({
        "version": 1,
        "token": { "chain": "near", "address": "acme.testnet", "symbol": "ACME", "decimals": 6 },
        "beneficiary": { "near_account": "founder.testnet", "asset": "nep141:vusdc.testnet" },
        "allocation": "1000000000",
        "period_days": 1,
        "max_sell_per_period_bps": 1000,
        "max_sell_per_tx_bps": 100,
        "price_floor_usd": "0.50",
        "max_slippage_bps": 100,
        "venues": ["1click"],
        "schedule": { "mode": "randomized", "min_gap_minutes": 1, "max_gap_minutes": 3 },
        "start": "2027-01-15T08:00:00Z",
        "end": "2027-02-14T08:00:00Z",
        "on_end": "release_remaining_to_beneficiary",
        "price_sources": ["1click_quote", "binance"],
        "price_agreement_bps": 500,
    })
}

const SALT: &str = "abababababababababababababababababababababababababababababababab";

fn chain_plan(status: &str, next_seq: u64) -> ChainPlan {
    let start = parse_iso_ms("2027-01-15T08:00:00Z").unwrap();
    let end = parse_iso_ms("2027-02-14T08:00:00Z").unwrap();
    serde_json::from_value(json!({
        "id": 7,
        "owner": "founder.testnet",
        "commitment": commitment(&plan_json(), SALT).unwrap(),
        "asset": { "type": "nep141", "token_id": "acme.testnet" },
        "token_decimals": 6,
        "quote_decimals": 6,
        "beneficiary": { "near_account": "founder.testnet", "evm_address": null },
        "proceeds_asset": "nep141:vusdc.testnet",
        "envelope": {
            "period_ms": DAY,
            "max_amount_per_period": "200000000",
            "max_amount_per_tx": "20000000",
            "min_price_usd_e6": "100000",
            "min_gap_ms": 0,
        },
        "disclosure": { "type": "end_reveal" },
        "start_ms": start,
        "end_ms": end,
        "status": status,
        "plan_account": "7.vsp-registry.testnet",
        "evm_address": null,
        "evm_nonce": 0,
        "next_seq": next_seq,
        "pending_change": null,
    }))
    .unwrap()
}

struct Harness {
    keys: LocalKeys,
    quote_key: SigningKey,
    quote_key_text: String,
}

impl Harness {
    fn new() -> Self {
        let quote_key = SigningKey::from_bytes(&[3u8; 32]);
        let quote_key_text = format!(
            "ed25519:{}",
            bs58::encode(quote_key.verifying_key().as_bytes()).into_string()
        );
        Self {
            keys: LocalKeys::from_seed([1u8; 32]),
            quote_key,
            quote_key_text,
        }
    }

    fn run(&self, req: Value) -> Value {
        let mut rng = SeededRandom::new(vec![5u8; 8]);
        let mut cx = Context {
            keys: &self.keys,
            rng: &mut rng,
            quote_signer_key: &self.quote_key_text,
            caller: "relayer.testnet".into(),
        };
        handle(&mut cx, serde_json::from_value(req).unwrap()).unwrap()
    }

    fn sealed_plan(&self) -> SealedBox {
        let opened = json!({ "plan": plan_json(), "salt": SALT }).to_string();
        seal_to(&box_public_hex(&self.keys).unwrap(), &opened)
    }

    fn quote(&self, amount: &str, deadline_ms: i64, out_per_unit: u64) -> Value {
        let out = amount.parse::<u64>().unwrap() * out_per_unit;
        let payload = json!({
            "amount": amount, "amountIn": amount, "amountInFormatted": "x",
            "amountInUsd": "10.000000", "amountOut": out.to_string(), "amountOutFormatted": "x",
            "amountOutUsd": "9.990000", "depositAddress": "deposit.testnet",
            "deadline": iso_from_ms(deadline_ms), "depositType": "ORIGIN_CHAIN",
            "destinationAsset": "nep141:vusdc.testnet", "dry": false,
            "minAmountIn": amount, "minAmountOut": (out * 995 / 1000).to_string(),
            "originAsset": "nep141:acme.testnet", "recipient": "founder.testnet",
            "recipientType": "DESTINATION_CHAIN", "refundTo": "7.vsp-registry.testnet",
            "refundType": "ORIGIN_CHAIN", "slippageTolerance": 100, "swapType": "EXACT_INPUT",
            "timestamp": "2027-01-15T08:00:00.000Z",
        })
        .to_string();
        let message = bs58::encode(Sha256::digest(payload.as_bytes())).into_string();
        let sig = self.quote_key.sign(message.as_bytes());
        json!({
            "payload": payload,
            "signature": format!("ed25519:{}", bs58::encode(sig.to_bytes()).into_string()),
            "correlation_id": "corr-1",
        })
    }
}

fn verify(h: &Harness, domain: &str, signed: &Value) {
    let pk = VerifyingKey::from_bytes(&h.keys.signing_public_key().unwrap()).unwrap();
    let sig: [u8; 64] = B64
        .decode(signed["signature"].as_str().unwrap())
        .unwrap()
        .try_into()
        .unwrap();
    let json = signed["json"].as_str().unwrap();
    pk.verify(
        &[domain.as_bytes(), json.as_bytes()].concat(),
        &ed25519_dalek::Signature::from_bytes(&sig),
    )
    .expect("the enclave's signature verifies");
}

fn accept(h: &Harness) -> String {
    let out = h.run(json!({
        "op": "accept", "plan": chain_plan_json("awaiting_ack", 0),
        "sealed": sealed_json(&h.sealed_plan()), "now_ms": START,
    }));
    assert_eq!(out["ok"], true, "{out}");
    verify(h, ACK_DOMAIN, &out["ack"]);
    out["record"].as_str().unwrap().to_string()
}

fn chain_plan_json(status: &str, next_seq: u64) -> Value {
    let p = chain_plan(status, next_seq);
    json!({
        "id": p.id, "status": status, "commitment": p.commitment,
        "envelope": p.envelope, "asset": { "type": "nep141", "token_id": "acme.testnet" },
        "token_decimals": 6, "quote_decimals": 6,
        "beneficiary": { "near_account": "founder.testnet", "evm_address": null },
        "start_ms": p.start_ms, "end_ms": p.end_ms, "next_seq": next_seq, "evm_nonce": 0,
        "evm_address": null, "plan_account": p.plan_account, "pending_change": null,
        "disclosure": { "type": "end_reveal" },
    })
}

fn sealed_json(b: &SealedBox) -> Value {
    json!({ "v": b.v, "epk": b.epk, "nonce": b.nonce, "ct": b.ct })
}

fn tick(h: &Harness, record: &str, now: i64, next_seq: u64, receipt: Value) -> Value {
    h.run(json!({
        "op": "tick", "plan": chain_plan_json("active", next_seq), "record": record,
        "now_ms": now, "balance": "1000000000", "last_receipt": receipt,
    }))
}

/// Ticks a minute apart until the enclave decides to sell.
fn until_quote(
    h: &Harness,
    mut record: String,
    mut now: i64,
    seq: u64,
    receipt: Value,
) -> (Value, i64) {
    for _ in 0..30 {
        let out = tick(h, &record, now, seq, receipt.clone());
        if out["type"] == "quote" {
            return (out, now);
        }
        assert_eq!(out["type"], "idle", "{out}");
        assert_eq!(
            out["until_ms"],
            Value::Null,
            "the schedule never leaves the enclave"
        );
        if let Some(r) = out["record"].as_str() {
            record = r.to_string();
        }
        now += 60_000;
    }
    panic!("no sale was decided within 30 minutes of a 1–3 minute schedule");
}

#[test]
fn a_sealed_plan_is_acked_and_sold_with_signed_requests_the_registry_accepts() {
    let h = Harness::new();
    let record = accept(&h);
    let start = chain_plan("active", 0).start_ms;
    let (decided, now) = until_quote(&h, record, start, 0, Value::Null);
    let amount = decided["amount"].as_str().unwrap().to_string();
    assert_eq!(decided["quote_request"]["amount"], amount);
    assert_eq!(
        decided["quote_request"]["refundTo"],
        "7.vsp-registry.testnet"
    );

    let sold = h.run(json!({
        "op": "sell", "plan": chain_plan_json("active", 0), "record": decided["record"],
        "now_ms": now + 5_000, "quote": h.quote(&amount, now + 600_000, 1),
        "prices": [{ "source": "binance", "price_e6": "1000000" }], "evm_fees": null,
    }));
    assert_eq!(sold["type"], "execute", "{sold}");
    verify(&h, EXECUTE_DOMAIN, &sold["request"]);
    let request: Value = serde_json::from_str(sold["request"]["json"].as_str().unwrap()).unwrap();
    assert_eq!(request["action"]["type"], "nep141_transfer");
    assert_eq!(request["action"]["receiver_id"], "deposit.testnet");
    assert_eq!(request["action"]["amount"], amount);
    assert_eq!(request["seq"], 0);
    assert!(request["compliance"]
        .as_object()
        .unwrap()
        .values()
        .all(|v| v == true));

    // The sale landed: the next tick records it and schedules the next one at least a minute on.
    let receipt = json!({ "seq": 0, "status": "done" });
    let after = tick(
        &h,
        sold["record"].as_str().unwrap(),
        now + 10_000,
        1,
        receipt.clone(),
    );
    assert_eq!(after["type"], "idle", "{after}");
    let (next, _) = until_quote(
        &h,
        after["record"].as_str().unwrap().into(),
        now + 10_000,
        1,
        receipt,
    );
    assert_eq!(next["seq"], 1);
}

#[test]
fn a_quote_below_the_sealed_floor_is_skipped_without_saying_why() {
    let h = Harness::new();
    let start = chain_plan("active", 0).start_ms;
    let (decided, now) = until_quote(&h, accept(&h), start, 0, Value::Null);
    let amount = decided["amount"].as_str().unwrap();
    // 0.30 USD a token against a sealed floor of 0.50 (the public floor is 0.10).
    let mut quote = h.quote(amount, now + 600_000, 1);
    let payload = quote["payload"].as_str().unwrap().to_string();
    let n: u64 = amount.parse().unwrap();
    let cheap = payload
        .replace(
            &format!("\"amountOut\":\"{n}\""),
            &format!("\"amountOut\":\"{}\"", n * 3 / 10),
        )
        .replace(
            &format!("\"minAmountOut\":\"{}\"", n * 995 / 1000),
            &format!("\"minAmountOut\":\"{}\"", n * 3 / 10 * 995 / 1000),
        );
    let message = bs58::encode(Sha256::digest(cheap.as_bytes())).into_string();
    quote["payload"] = json!(cheap);
    quote["signature"] = json!(format!(
        "ed25519:{}",
        bs58::encode(h.quote_key.sign(message.as_bytes()).to_bytes()).into_string()
    ));
    let out = h.run(json!({
        "op": "sell", "plan": chain_plan_json("active", 0), "record": decided["record"],
        "now_ms": now, "quote": quote,
        "prices": [{ "source": "binance", "price_e6": "300000" }], "evm_fees": null,
    }));
    assert_eq!(out["type"], "skipped");
    assert_eq!(
        out.as_object().unwrap().len(),
        2,
        "only the type and the sealed record: {out}"
    );
}

#[test]
fn a_quote_not_signed_by_the_pinned_key_is_never_signed_through() {
    let h = Harness::new();
    let start = chain_plan("active", 0).start_ms;
    let (decided, now) = until_quote(&h, accept(&h), start, 0, Value::Null);
    let mut quote = h.quote(decided["amount"].as_str().unwrap(), now + 600_000, 1);
    let forged = SigningKey::from_bytes(&[4u8; 32]);
    let message = bs58::encode(Sha256::digest(
        quote["payload"].as_str().unwrap().as_bytes(),
    ));
    quote["signature"] = json!(format!(
        "ed25519:{}",
        bs58::encode(forged.sign(message.into_string().as_bytes()).to_bytes()).into_string()
    ));
    let out = h.run(json!({
        "op": "sell", "plan": chain_plan_json("active", 0), "record": decided["record"],
        "now_ms": now, "quote": quote,
        "prices": [{ "source": "binance", "price_e6": "1000000" }], "evm_fees": null,
    }));
    assert_eq!(out["type"], "skipped");
}

#[test]
fn a_box_for_another_commitment_is_refused() {
    let h = Harness::new();
    let mut plan = chain_plan_json("awaiting_ack", 0);
    plan["commitment"] = json!("00".repeat(32));
    let out = h.run(json!({
        "op": "accept", "plan": plan, "sealed": sealed_json(&h.sealed_plan()), "now_ms": START,
    }));
    assert_eq!(out["ok"], false);
    assert_eq!(
        out["reasons"][0],
        "The plan does not match the on-chain commitment"
    );
}

#[test]
fn a_record_cannot_be_replayed_onto_another_plan() {
    let h = Harness::new();
    let record = accept(&h);
    let mut plan = chain_plan_json("active", 0);
    plan["id"] = json!(8);
    let mut rng = SeededRandom::new(vec![5u8; 8]);
    let mut cx = Context {
        keys: &h.keys,
        rng: &mut rng,
        quote_signer_key: &h.quote_key_text,
        caller: String::new(),
    };
    let req = serde_json::from_value(json!({
        "op": "tick", "plan": plan, "record": record, "now_ms": START,
        "balance": "1", "last_receipt": null,
    }))
    .unwrap();
    assert!(handle(&mut cx, req).is_err());
}

#[test]
fn the_key_proof_names_both_keys_and_is_signed() {
    let h = Harness::new();
    let out = h.run(json!({ "op": "key_proof" }));
    verify(&h, KEY_PROOF_DOMAIN, &out);
    let message: Value = serde_json::from_str(out["json"].as_str().unwrap()).unwrap();
    assert_eq!(message["signing_key"], out["enclave_key"]);
    assert_eq!(
        message["encryption_key_hex"],
        box_public_hex(&h.keys).unwrap()
    );
}

#[test]
fn iso_times_match_javascript() {
    assert_eq!(iso_from_ms(0), "1970-01-01T00:00:00.000Z");
    assert_eq!(iso_from_ms(1_794_525_278_445), "2026-11-12T23:14:38.445Z");
    assert_eq!(
        parse_iso_ms(&iso_from_ms(1_951_234_567_890)).unwrap(),
        1_951_234_567_890
    );
}
