//! A WASI command: one JSON request on stdin, one JSON answer on stdout, the way OutLayer runs a
//! module. Exit code 0 with `{"ok":true,"result":…}`, or 1 with `{"ok":false,"error":"…"}`.
//!
//! Keys never arrive in the request: the X25519 sealing key comes from `GLIDEPATH_ENCLAVE_SECRET_HEX`,
//! which OutLayer would inject from its keystore as an environment secret. Two operations exist
//! only in the `vectors` build used by the tests: `sign` (the production module must build what
//! it signs itself) and a fixed `random_seed_hex` (production draws from the host's
//! `random_get`, so nobody can choose or predict the schedule).

use serde::Deserialize;
use serde_json::{json, Value};
use std::io::Read;
use glidepath_enclave_wasi::*;

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
enum Request {
    Commitment {
        plan: Value,
        salt: String,
    },
    /// Opens a sealed `{plan, salt}`, checks it against the on-chain commitment and the public
    /// envelope. Answers only yes/no per rule, never the plan.
    OpenPlan {
        sealed: SealedBox,
        commitment: String,
        envelope: Envelope,
    },
    ProposeSale {
        plan: Plan,
        envelope: Envelope,
        state: State,
        now_ms: i64,
        balance: String,
        random_seed_hex: Option<String>,
    },
    ScheduleAfter {
        plan: Plan,
        now_ms: i64,
        random_seed_hex: Option<String>,
    },
    HandoverState {
        plan: Plan,
        counters: ChainCounters,
        random_seed_hex: Option<String>,
    },
    CheckMarket {
        plan: Plan,
        envelope: Envelope,
        amount: String,
        prices: Vec<PriceObservation>,
        quote: QuoteView,
        quote_decimals: u32,
    },
    VerifyQuote {
        public_key: String,
        payload: String,
        signature: String,
    },
    Sign {
        seed_hex: String,
        domain: String,
        json: String,
    },
    /// Blind trust (prototype): the mandate's own rules and whether it sits inside the envelope.
    TrustCheckMandate {
        mandate: trust::Mandate,
        envelope: trust::TrustEnvelope,
    },
    /// Blind trust: the rebalance decision.
    TrustRebalance {
        mandate: trust::Mandate,
        envelope: trust::TrustEnvelope,
        counters: trust::Counters,
        holdings: Vec<trust::Holding>,
        prices: Vec<trust::AssetPrice>,
        now_ms: i64,
    },
}

fn rng(seed: Option<String>) -> Result<Box<dyn RandomBytes>> {
    match seed {
        None => Ok(Box::new(OsRandom)),
        Some(_) if !cfg!(feature = "vectors") => {
            Err("random_seed_hex is accepted only by the test build".into())
        }
        Some(hex_seed) => Ok(Box::new(SeededRandom::new(
            hex::decode(hex_seed).map_err(|_| "invalid random_seed_hex")?,
        ))),
    }
}

fn hex32(s: &str, what: &str) -> Result<[u8; 32]> {
    hex::decode(s.trim())
        .ok()
        .and_then(|v| v.try_into().ok())
        .ok_or_else(|| format!("{what} must be 32 bytes of hex"))
}

fn handle(req: Request) -> Result<Value> {
    Ok(match req {
        Request::Commitment { plan, salt } => json!({ "commitment": commitment(&plan, &salt)? }),
        Request::OpenPlan {
            sealed,
            commitment: expected,
            envelope,
        } => {
            let secret = std::env::var("GLIDEPATH_ENCLAVE_SECRET_HEX")
                .map_err(|_| "GLIDEPATH_ENCLAVE_SECRET_HEX is not set")?;
            let opened: Value =
                serde_json::from_str(&open_sealed(hex32(&secret, "secret")?, &sealed)?)
                    .map_err(|_| "the sealed payload is not JSON")?;
            let (plan_value, salt) = match (&opened["plan"], opened["salt"].as_str()) {
                (p @ Value::Object(_), Some(s)) => (p.clone(), s.to_string()),
                _ => return Err("the sealed payload must be {plan, salt}".into()),
            };
            let plan: Plan = serde_json::from_value(plan_value.clone())
                .map_err(|e| format!("not a sealed plan: {e}"))?;
            let checks = envelope_checks(&plan, &envelope)?;
            json!({
                "commitment_ok": commitment(&plan_value, &salt)? == expected,
                "within_envelope": checks.iter().all(|(_, ok)| *ok),
                "checks": checks.iter().map(|(rule, ok)| json!({ "rule": rule, "ok": ok })).collect::<Vec<_>>(),
            })
        }
        Request::ProposeSale {
            plan,
            envelope,
            state,
            now_ms,
            balance,
            random_seed_hex,
        } => {
            let mut r = rng(random_seed_hex)?;
            serde_json::to_value(propose_sale(
                &plan,
                &envelope,
                &state,
                now_ms,
                amount(&balance)?,
                r.as_mut(),
            )?)
            .map_err(|e| e.to_string())?
        }
        Request::ScheduleAfter {
            plan,
            now_ms,
            random_seed_hex,
        } => {
            let mut r = rng(random_seed_hex)?;
            json!({ "next_sale_at_ms": schedule_after(&plan, now_ms, r.as_mut())? })
        }
        Request::HandoverState {
            plan,
            counters,
            random_seed_hex,
        } => {
            let mut r = rng(random_seed_hex)?;
            serde_json::to_value(handover_state(&plan, &counters, r.as_mut())?)
                .map_err(|e| e.to_string())?
        }
        Request::CheckMarket {
            plan,
            envelope,
            amount: a,
            prices,
            quote,
            quote_decimals,
        } => check_market(
            &plan,
            &envelope,
            amount(&a)?,
            &prices,
            &quote,
            quote_decimals,
        )?,
        Request::VerifyQuote {
            public_key,
            payload,
            signature,
        } => {
            json!({ "valid": verify_quote(&public_key, &payload, &signature) })
        }
        Request::Sign {
            seed_hex,
            domain,
            json: body,
        } => {
            if !cfg!(feature = "vectors") {
                return Err("sign is available only in the test build".into());
            }
            if domain != EXECUTE_DOMAIN && domain != ACK_DOMAIN {
                return Err("unknown signing domain".into());
            }
            let (public_key, signature) = sign(hex32(&seed_hex, "seed_hex")?, &domain, &body);
            json!({ "public_key": public_key, "signature": signature })
        }
        Request::TrustCheckMandate { mandate, envelope } => json!({
            "problems": trust::mandate_problems(&mandate)?,
            "checks": trust::check_mandate_envelope(&mandate, &envelope)?
                .iter()
                .map(|(rule, ok)| json!({ "rule": rule, "ok": ok }))
                .collect::<Vec<_>>(),
        }),
        Request::TrustRebalance {
            mandate,
            envelope,
            counters,
            holdings,
            prices,
            now_ms,
        } => serde_json::to_value(trust::decide_rebalance(
            &mandate, &envelope, &counters, &holdings, &prices, now_ms,
        )?)
        .map_err(|e| e.to_string())?,
    })
}

fn main() {
    let mut input = String::new();
    let outcome = std::io::stdin()
        .read_to_string(&mut input)
        .map_err(|e| e.to_string())
        .and_then(|_| {
            serde_json::from_str::<Request>(&input).map_err(|e| format!("bad request: {e}"))
        })
        .and_then(handle);
    match outcome {
        Ok(result) => println!("{}", json!({ "ok": true, "result": result })),
        Err(error) => {
            println!("{}", json!({ "ok": false, "error": error }));
            std::process::exit(1);
        }
    }
}
