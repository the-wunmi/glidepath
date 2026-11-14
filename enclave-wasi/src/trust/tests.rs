use super::*;
use crate::local_keys::LocalKeys;
use chacha20poly1305::{aead::Aead, ChaCha20Poly1305, KeyInit};
use ed25519_dalek::{Signer, SigningKey, Verifier, VerifyingKey};
use hkdf::Hkdf;
use sha2::{Digest, Sha256};

const NOW: i64 = 1_800_000_000_000;
const SALT: &str = "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd";
const ACCOUNT: &str = "t1.trust.testnet";

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
    .expand(b"glidepath/seal/v1", &mut key)
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

fn mandate() -> Value {
    json!({
        "version": 1,
        "universe": [
            { "asset": "nep141:idx.testnet", "sector": "broad" },
            { "asset": "nep141:bond.testnet", "sector": "bonds" },
            { "asset": "nep141:oil.testnet", "sector": "energy" },
        ],
        "excluded_sectors": ["energy"],
        "targets": [
            { "asset": "nep141:idx.testnet", "weight_bps": 6000 },
            { "asset": "nep141:bond.testnet", "weight_bps": 4000 },
        ],
        "band_bps": 500,
        "max_trade_usd": "500",
        "min_trade_usd": "10",
        "beneficiary": "official.testnet",
        "end": "2027-11-15T00:00:00.000Z",
    })
}

fn chain(status: &str, next_seq: u64) -> ChainTrust {
    serde_json::from_value(json!({
        "id": 1,
        "status": status,
        "commitment": commitment(&mandate(), SALT).unwrap(),
        "envelope": {
            "excluded_assets": ["nep141:oil.testnet"],
            "period_ms": 86_400_000,
            "max_turnover_usd_e6": "1000000000",
            "min_gap_ms": 0,
        },
        "beneficiary": "official.testnet",
        "trust_account": ACCOUNT,
        "start_ms": NOW - 1_000,
        "end_ms": parse_iso_ms("2027-11-15T00:00:00.000Z").unwrap(),
        "next_seq": next_seq,
        "pending_change": null,
        "period_index": 0,
        "turnover_in_period_usd_e6": "0",
        "last_trade_ms": null,
    }))
    .unwrap()
}

struct NoRandom;
impl RandomBytes for NoRandom {
    fn fill(&mut self, out: &mut [u8]) {
        out.fill(0);
    }
}

const QUOTE_SEED: [u8; 32] = [44u8; 32];

fn quote_key() -> String {
    near_public_key(&SigningKey::from_bytes(&QUOTE_SEED).verifying_key())
}

fn context<'a>(keys: &'a LocalKeys, rng: &'a mut NoRandom, quote_key: &'a str) -> Context<'a> {
    Context {
        keys,
        rng,
        quote_signer_key: quote_key,
        caller: "test".into(),
    }
}

/// The whole trust holds IDX: 1,000 tokens at $2, so bonds (40%) are $800 short.
fn holdings() -> Vec<Holding> {
    vec![Holding {
        asset: "nep141:idx.testnet".into(),
        amount: "1000000000000000000000".into(),
        decimals: 18,
    }]
}

fn prices() -> Vec<AssetPrice> {
    ["idx", "bond"]
        .iter()
        .map(|t| AssetPrice {
            asset: format!("nep141:{t}.testnet"),
            price_usd_e6: "2000000".into(),
        })
        .collect()
}

/// A quote 1Click would sign for the decided trade, signed in 1Click's format.
fn quote_for(request: &Value, tweak: impl Fn(&mut Value)) -> TrustQuote {
    let amount = request["amount"].as_str().unwrap();
    let mut q = json!({
        "amount": amount, "amountIn": amount, "amountInUsd": "500.000000000000",
        "amountOut": "249000000000000000000", "amountOutUsd": "498.000000000000",
        "minAmountOut": "246510000000000000000", "deadline": iso_from_ms(NOW + 600_000),
        "depositAddress": "aa".repeat(32), "destinationAsset": request["destinationAsset"],
        "dry": false, "originAsset": request["originAsset"], "recipient": ACCOUNT,
        "refundTo": ACCOUNT, "swapType": "EXACT_INPUT", "depositType": "ORIGIN_CHAIN",
        "recipientType": "DESTINATION_CHAIN", "refundType": "ORIGIN_CHAIN",
    });
    tweak(&mut q);
    let payload = q.to_string();
    let message = bs58::encode(Sha256::digest(payload.as_bytes())).into_string();
    let sig = SigningKey::from_bytes(&QUOTE_SEED).sign(message.as_bytes());
    TrustQuote {
        payload,
        signature: format!("ed25519:{}", bs58::encode(sig.to_bytes()).into_string()),
        correlation_id: "corr-1".into(),
    }
}

fn accepted(keys: &LocalKeys, key: &str) -> String {
    let boxed = seal_to(
        &hex::encode(
            x25519_dalek::PublicKey::from(&x25519_dalek::StaticSecret::from(
                keys.box_secret().unwrap(),
            ))
            .as_bytes(),
        ),
        &json!({ "mandate": mandate(), "salt": SALT }).to_string(),
    );
    let mut rng = NoRandom;
    let out = accept(
        &mut context(keys, &mut rng, key),
        &chain("awaiting_ack", 0),
        &boxed,
        NOW,
    )
    .unwrap();
    assert_eq!(out["ok"], true, "{out}");
    let ack = &out["ack"];
    let verifying = VerifyingKey::from_bytes(&keys.signing_public_key().unwrap()).unwrap();
    let sig: [u8; 64] = B64
        .decode(ack["signature"].as_str().unwrap())
        .unwrap()
        .try_into()
        .unwrap();
    let signed = [
        TRUST_ACK_DOMAIN.as_bytes(),
        ack["json"].as_str().unwrap().as_bytes(),
    ]
    .concat();
    assert!(verifying
        .verify(&signed, &ed25519_dalek::Signature::from_bytes(&sig))
        .is_ok());
    out["record"].as_str().unwrap().to_string()
}

#[test]
fn a_mandate_that_targets_an_excluded_sector_is_refused() {
    let mut m: Mandate = serde_json::from_value(mandate()).unwrap();
    m.excluded_sectors.push("bonds".into());
    assert_eq!(
        mandate_problems(&m).unwrap(),
        vec!["A target is in an excluded sector".to_string()]
    );
}

#[test]
fn the_enclave_decides_quotes_and_signs_a_compliant_trade() {
    let keys = LocalKeys::from_seed([5u8; 32]);
    let key = quote_key();
    let record = accepted(&keys, &key);
    let mut rng = NoRandom;
    let mut cx = context(&keys, &mut rng, &key);
    let t = chain("active", 0);
    let out = tick(&mut cx, &t, &record, NOW, &holdings(), &prices()).unwrap();
    assert_eq!(out["type"], "quote", "{out}");
    let request = &out["quote_request"];
    assert_eq!(request["originAsset"], "nep141:idx.testnet");
    assert_eq!(request["destinationAsset"], "nep141:bond.testnet");
    // $500 (the mandate's largest trade) of IDX at $2.
    assert_eq!(request["amount"], "250000000000000000000");
    assert_eq!(request["recipient"], ACCOUNT);
    let record = out["record"].as_str().unwrap();

    let traded = trade(
        &mut cx,
        &t,
        record,
        NOW + 1_000,
        &quote_for(request, |_| {}),
    )
    .unwrap();
    assert_eq!(traded["type"], "execute", "{traded}");
    let signed: Value = serde_json::from_str(traded["request"]["json"].as_str().unwrap()).unwrap();
    assert_eq!(signed["origin_token"], "idx.testnet");
    assert_eq!(
        signed["attestation"],
        json!({ "within_mandate": true, "not_excluded": true, "within_turnover": true })
    );
}

#[test]
fn a_quote_that_pays_outside_the_trust_is_skipped() {
    let keys = LocalKeys::from_seed([5u8; 32]);
    let key = quote_key();
    let record = accepted(&keys, &key);
    let mut rng = NoRandom;
    let mut cx = context(&keys, &mut rng, &key);
    let t = chain("active", 0);
    let out = tick(&mut cx, &t, &record, NOW, &holdings(), &prices()).unwrap();
    let elsewhere = quote_for(&out["quote_request"], |q| {
        q["recipient"] = json!("official.testnet")
    });
    let traded = trade(
        &mut cx,
        &t,
        out["record"].as_str().unwrap(),
        NOW,
        &elsewhere,
    )
    .unwrap();
    assert_eq!(traded["type"], "skipped");
}

#[test]
fn a_trust_inside_its_bands_holds_without_saying_why() {
    let keys = LocalKeys::from_seed([5u8; 32]);
    let key = quote_key();
    let record = accepted(&keys, &key);
    let mut rng = NoRandom;
    let mut cx = context(&keys, &mut rng, &key);
    let balanced = vec![
        Holding {
            asset: "nep141:idx.testnet".into(),
            amount: "600000000000000000000".into(),
            decimals: 18,
        },
        Holding {
            asset: "nep141:bond.testnet".into(),
            amount: "400000000000000000000".into(),
            decimals: 18,
        },
    ];
    let out = tick(
        &mut cx,
        &chain("active", 0),
        &record,
        NOW,
        &balanced,
        &prices(),
    )
    .unwrap();
    assert_eq!(out["type"], "idle");
    assert_eq!(out["reason"], "waiting");
}

#[test]
fn quotes_the_contract_would_refuse_are_skipped() {
    let keys = LocalKeys::from_seed([5u8; 32]);
    let key = quote_key();
    let mut rng = NoRandom;
    let t = chain("active", 0);
    let tweaks: [fn(&mut Value); 4] = [
        |q| q["refundType"] = json!("INTENTS"),
        |q| q["recipientType"] = json!("INTENTS"),
        // 60 bps: over the trust's bound, which has no flat part.
        |q| q["amountOutUsd"] = json!("497.000000000000"),
        // $9.99: under the contract's smallest trade.
        |q| {
            q["amountInUsd"] = json!("9.990000000000");
            q["amountOutUsd"] = json!("9.980000000000");
        },
    ];
    for tweak in tweaks {
        let record = accepted(&keys, &key);
        let mut cx = context(&keys, &mut rng, &key);
        let out = tick(&mut cx, &t, &record, NOW, &holdings(), &prices()).unwrap();
        let quote = quote_for(&out["quote_request"], tweak);
        let traded = trade(&mut cx, &t, out["record"].as_str().unwrap(), NOW, &quote).unwrap();
        assert_eq!(traded["type"], "skipped", "{}", quote.payload);
    }
}

#[test]
fn the_ack_names_the_beneficiary_the_end_and_the_trust_account() {
    let keys = LocalKeys::from_seed([5u8; 32]);
    let boxed = seal_to(
        &hex::encode(
            x25519_dalek::PublicKey::from(&x25519_dalek::StaticSecret::from(
                keys.box_secret().unwrap(),
            ))
            .as_bytes(),
        ),
        &json!({ "mandate": mandate(), "salt": SALT }).to_string(),
    );
    let key = quote_key();
    let mut rng = NoRandom;
    let t = chain("awaiting_ack", 0);
    let out = accept(&mut context(&keys, &mut rng, &key), &t, &boxed, NOW).unwrap();
    let ack: Value = serde_json::from_str(out["ack"]["json"].as_str().unwrap()).unwrap();
    assert_eq!(ack["beneficiary"], "official.testnet");
    assert_eq!(ack["end_ms"], t.end_ms);
    assert_eq!(ack["trust_account"], ACCOUNT);
}
