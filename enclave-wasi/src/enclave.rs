//! The stateful enclave for OutLayer: the same steps as `SimulatedEnclave` (packages/enclave), as
//! one-shot operations. OutLayer runs a module once per request and keeps nothing, so the plan,
//! its schedule and the sale in flight travel between runs as a record sealed under a keystore key
//! only this build, called by this account, can open. The host stores the record and passes it
//! back; it never sees the plan.
//!
//! Everything in a run's input and output is public (OutLayer publishes `input_data` and the
//! result on NEAR). So the input carries only ciphertext and public chain facts, and the output
//! carries only signed messages, ciphertext, and what the chain will show anyway: a sale's amount
//! (needed to ask 1Click for a quote, and on-chain once the sale lands) and that a sale was
//! skipped, never why, and never when the next sale is due.

use crate::*;
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const KEY_PROOF_DOMAIN: &str = "vsp/key-proof/v1\n";
/// A signed request is good for five minutes: an OutLayer run and the relay take tens of seconds.
const REQUEST_TTL_MS: i64 = 300_000;
/// 1Click quotes are asked to settle within ten minutes of the sale.
const QUOTE_DEADLINE_MS: i64 = 600_000;
/// A decided sale must be quoted and signed within this long, or it is decided again.
const PENDING_TTL_MS: i64 = 300_000;
/// The registry's cap (MAX_EVM_GAS_LIMIT). A transfer to a new holder costs ~142k gas on Sepolia,
/// and every sale goes to a fresh 1Click deposit address.
const EVM_GAS_LIMIT: u64 = 150_000;
/// The registry refuses longer execute requests (MAX_EXECUTE_JSON_BYTES).
const MAX_REQUEST_JSON_BYTES: usize = 8192;
/// The quote cost bound the registry applies (`quote_fee_too_high`): 50 bps plus $1.
const QUOTE_COST_MAX_BPS: u128 = 50;
const QUOTE_COST_FLAT_USD_E12: u128 = 1_000_000_000_000;

/// The keys of a run. On OutLayer the keystore holds them and the module only names them; the
/// local build derives them from a seed for tests.
pub trait Keys {
    fn signing_public_key(&self) -> Result<[u8; 32]>;
    fn sign(&self, message: &[u8]) -> Result<[u8; 64]>;
    fn seal(&self, plaintext: &[u8], aad: &[u8]) -> Result<Vec<u8>>;
    fn open(&self, ciphertext: &[u8], aad: &[u8]) -> Result<Vec<u8>>;
    /// The X25519 secret founders seal plans to. Nobody outside the keystore can compute it.
    fn box_secret(&self) -> Result<[u8; 32]>;
}

// ── Public chain facts (the registry's `get_plan`, as the host read it) ────────────────────────

#[derive(Deserialize, Clone, Debug)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ChainAsset {
    Nep141 {
        token_id: String,
    },
    EvmErc20 {
        chain_id: u64,
        token_address: String,
    },
}

#[derive(Deserialize, Clone, Debug)]
pub struct ChainBeneficiary {
    pub near_account: String,
}

#[derive(Deserialize, Clone, Debug)]
pub struct PendingChange {
    pub kind: String,
    pub commitment: Option<String>,
    pub envelope: Option<Envelope>,
    pub effective_at_ms: i64,
}

#[derive(Deserialize, Clone, Debug)]
pub struct Disclosure {
    #[serde(rename = "type")]
    pub kind: String,
}

#[derive(Deserialize, Clone, Debug)]
pub struct ChainPlan {
    pub id: u64,
    pub status: String,
    pub commitment: String,
    pub envelope: Envelope,
    pub asset: ChainAsset,
    pub token_decimals: u32,
    pub quote_decimals: u32,
    pub beneficiary: ChainBeneficiary,
    pub start_ms: i64,
    pub end_ms: i64,
    pub next_seq: u64,
    pub evm_nonce: u64,
    pub evm_address: Option<String>,
    pub plan_account: String,
    pub pending_change: Option<PendingChange>,
    pub disclosure: Disclosure,
    #[serde(flatten)]
    pub counters: ChainCounters,
}

#[derive(Deserialize, Clone, Debug)]
pub struct ReceiptView {
    pub seq: u64,
    pub status: String,
    /// The key that signed the receipted request. A host that sends none is taken at its word that
    /// the receipt is this build's (the behaviour before builds stood in for each other).
    #[serde(default)]
    pub enclave_key: Option<String>,
}

#[derive(Deserialize, Clone, Debug)]
pub struct SignedQuote {
    /// Q, the exact string 1Click signs.
    pub payload: String,
    pub signature: String,
    /// 1Click's id for the swap; unsigned, shown to verifiers only.
    pub correlation_id: String,
}

#[derive(Deserialize, Clone, Debug)]
pub struct EvmFees {
    pub max_fee_per_gas: String,
    pub max_priority_fee_per_gas: String,
}

// ── The sealed record ──────────────────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone, Debug)]
struct Inflight {
    seq: u64,
    amount: String,
    period_index: i64,
    issued_at_ms: i64,
    expires_at_ms: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
struct Pending {
    seq: u64,
    amount: String,
    period_index: i64,
    decided_at_ms: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
struct Terms {
    plan: Value,
    salt: String,
    commitment: String,
    envelope: Envelope,
}

/// A plan this build takes over from another build (a change sealed to this build, for a plan
/// another build accepted). Until the change applies, `terms` and `state` are placeholders.
#[derive(Serialize, Deserialize, Clone, Debug)]
struct Handover {
    /// When this build first saw the change applied on-chain.
    applied_at_ms: Option<i64>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
struct Record {
    #[serde(flatten)]
    terms: Terms,
    state: State,
    inflight: Option<Inflight>,
    pending: Option<Pending>,
    staged: Option<Terms>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    handover: Option<Handover>,
    /// The registry's `next_seq` when this record last looked; sales past it this build did not
    /// sign are recounted from the registry's counters. Unset until the record's first tick.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    seen_seq: Option<u64>,
}

impl Record {
    fn plan(&self) -> Result<Plan> {
        serde_json::from_value(self.terms.plan.clone()).map_err(|_| "the record is corrupt".into())
    }
}

/// The record is bound to its plan id, so the host cannot hand one plan's record to another.
fn record_aad(plan_id: u64) -> Vec<u8> {
    format!("vsp/record/v1:{plan_id}").into_bytes()
}

fn seal_record(keys: &dyn Keys, plan_id: u64, r: &Record) -> Result<String> {
    let json = serde_json::to_vec(r).map_err(|e| e.to_string())?;
    Ok(B64.encode(keys.seal(&json, &record_aad(plan_id))?))
}

fn open_record(keys: &dyn Keys, plan_id: u64, sealed: &str) -> Result<Record> {
    let bytes = B64.decode(sealed).map_err(|_| "invalid record encoding")?;
    let json = keys
        .open(&bytes, &record_aad(plan_id))
        .map_err(|_| "the record does not open with this enclave's key")?;
    serde_json::from_slice(&json).map_err(|_| "the record is corrupt".into())
}

// ── Requests ───────────────────────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Request {
    /// The enclave's public keys, signed: run once and attested, it is what the registry pins.
    KeyProof,
    /// Opens a founder's sealed plan, checks it against everything public, and acks it.
    Accept {
        plan: ChainPlan,
        sealed: SealedBox,
        now_ms: i64,
    },
    /// Holds a changed plan until the chain applies it. With no record, this build takes the plan
    /// over from the build that accepted it.
    Stage {
        plan: ChainPlan,
        sealed: SealedBox,
        #[serde(default)]
        record: Option<String>,
    },
    /// One wake-up: maybe a change ack, maybe a sale to quote, usually nothing.
    Tick {
        plan: ChainPlan,
        record: String,
        now_ms: i64,
        balance: String,
        /// The registry's receipt at `next_seq - 1`, if any.
        last_receipt: Option<ReceiptView>,
    },
    /// Checks the quote for the sale `tick` decided and signs the execute request.
    Sell {
        plan: ChainPlan,
        record: String,
        now_ms: i64,
        quote: SignedQuote,
        prices: Vec<PriceObservation>,
        evm_fees: Option<EvmFees>,
    },
    /// The sealed terms of an ended `end_reveal` plan.
    Reveal { plan: ChainPlan, record: String },
    /// Blind trust (prototype): opens an official's sealed mandate and acks the trust.
    TrustAccept {
        trust: crate::trust::ChainTrust,
        sealed: SealedBox,
        now_ms: i64,
    },
    /// Blind trust: one wake-up; maybe a trade to quote.
    TrustTick {
        trust: crate::trust::ChainTrust,
        record: String,
        now_ms: i64,
        holdings: Vec<crate::trust::Holding>,
        prices: Vec<crate::trust::AssetPrice>,
    },
    /// Blind trust: checks the quote for the decided trade and signs it.
    TrustTrade {
        trust: crate::trust::ChainTrust,
        record: String,
        now_ms: i64,
        quote: crate::trust::TrustQuote,
    },
}

pub struct Context<'a> {
    pub keys: &'a dyn Keys,
    pub rng: &'a mut dyn RandomBytes,
    /// The 1Click quote key, fixed at build time so the host cannot substitute quotes.
    pub quote_signer_key: &'a str,
    /// The account that called for the run, as the host reports it.
    pub caller: String,
}

pub fn handle(cx: &mut Context, req: Request) -> Result<Value> {
    match req {
        Request::KeyProof => key_proof(cx),
        Request::Accept {
            plan,
            sealed,
            now_ms,
        } => accept(cx, &plan, &sealed, now_ms),
        Request::Stage {
            plan,
            sealed,
            record,
        } => stage(cx, &plan, &sealed, record.as_deref()),
        Request::Tick {
            plan,
            record,
            now_ms,
            balance,
            last_receipt,
        } => tick(cx, &plan, &record, now_ms, &balance, last_receipt.as_ref()),
        Request::Sell {
            plan,
            record,
            now_ms,
            quote,
            prices,
            evm_fees,
        } => sell(
            cx,
            &plan,
            &record,
            now_ms,
            &quote,
            &prices,
            evm_fees.as_ref(),
        ),
        Request::Reveal { plan, record } => reveal(cx, &plan, &record),
        Request::TrustAccept {
            trust,
            sealed,
            now_ms,
        } => crate::trust::accept(cx, &trust, &sealed, now_ms),
        Request::TrustTick {
            trust,
            record,
            now_ms,
            holdings,
            prices,
        } => crate::trust::tick(cx, &trust, &record, now_ms, &holdings, &prices),
        Request::TrustTrade {
            trust,
            record,
            now_ms,
            quote,
        } => crate::trust::trade(cx, &trust, &record, now_ms, &quote),
    }
}

fn signing_key_text(keys: &dyn Keys) -> Result<String> {
    Ok(format!(
        "ed25519:{}",
        bs58::encode(keys.signing_public_key()?).into_string()
    ))
}

fn signed(keys: &dyn Keys, domain: &str, json: String) -> Result<Value> {
    let sig = keys.sign(&[domain.as_bytes(), json.as_bytes()].concat())?;
    Ok(json!({
        "json": json,
        "signature": B64.encode(sig),
        "enclave_key": signing_key_text(keys)?,
    }))
}

fn box_public_hex(keys: &dyn Keys) -> Result<String> {
    let sk = x25519_dalek::StaticSecret::from(keys.box_secret()?);
    Ok(hex::encode(x25519_dalek::PublicKey::from(&sk).as_bytes()))
}

fn key_proof(cx: &mut Context) -> Result<Value> {
    let message = json!({
        "type": "key_proof",
        "signing_key": signing_key_text(cx.keys)?,
        "encryption_key_hex": box_public_hex(cx.keys)?,
        "quote_signer_key": cx.quote_signer_key,
        "caller": cx.caller,
    });
    signed(cx.keys, KEY_PROOF_DOMAIN, message.to_string())
}

// ── Opening a founder's box ────────────────────────────────────────────────────────────────────

/// `planProblems`: rules the schema cannot express on single fields.
fn plan_problems(plan: &Plan) -> Result<Vec<String>> {
    let l = limits(plan)?;
    let mut problems = Vec::new();
    if l.end_ms <= l.start_ms {
        problems.push("The plan must end after it starts".into());
    }
    if plan.max_sell_per_tx_bps > plan.max_sell_per_period_bps {
        problems.push("A single sale cannot be larger than the per-period limit".into());
    }
    if plan.schedule.min_gap_minutes > plan.schedule.max_gap_minutes {
        problems.push("The shortest gap between sales cannot be longer than the longest".into());
    }
    if l.per_tx.is_zero() {
        problems.push("The per-sale limit rounds to zero tokens".into());
    }
    if plan.token.chain == "evm" && plan.beneficiary.evm_address.is_none() {
        problems.push(
            "An EVM token needs a beneficiary EVM address for the end-of-plan release".into(),
        );
    }
    // The ranges the TypeScript schema enforces that the arithmetic depends on.
    let bps_ok = (1..=10_000).contains(&plan.max_sell_per_period_bps)
        && (1..=10_000).contains(&plan.max_sell_per_tx_bps)
        && (1..=1_000).contains(&plan.max_slippage_bps)
        && (1..=2_000).contains(&plan.price_agreement_bps)
        && (1..=365).contains(&plan.period_days)
        && plan.schedule.min_gap_minutes >= 0
        && plan.schedule.max_gap_minutes >= 1
        && plan.price_sources.len() >= 2
        && !plan.venues.is_empty()
        && plan.venues.iter().all(|v| v == "1click");
    if !bps_ok {
        problems.push("The plan has a value outside its allowed range".into());
    }
    Ok(problems)
}

/// The sealed plan must agree with the public facts the registry recorded at creation.
fn public_fact_problems(chain: &ChainPlan, plan: &Plan) -> Result<Vec<String>> {
    let mut problems = Vec::new();
    let t = &plan.token;
    let same_token = match &chain.asset {
        ChainAsset::Nep141 { token_id } => t.chain == "near" && &t.address == token_id,
        ChainAsset::EvmErc20 {
            chain_id,
            token_address,
        } => {
            t.chain == "evm"
                && t.address.eq_ignore_ascii_case(token_address)
                && t.chain_id == Some(*chain_id)
        }
    };
    if !same_token {
        problems.push("The plan names a different token than the registry".into());
    }
    if t.decimals != chain.token_decimals {
        problems.push("Token decimals differ from the registry".into());
    }
    if plan.beneficiary.near_account != chain.beneficiary.near_account {
        problems.push("The beneficiary differs from the registry".into());
    }
    if parse_iso_ms(&plan.start)? != chain.start_ms || parse_iso_ms(&plan.end)? != chain.end_ms {
        problems.push("Start or end differs from the registry".into());
    }
    Ok(problems)
}

/// Opens the box and checks it against the commitment and envelope it must match.
fn open_for_plan(
    keys: &dyn Keys,
    chain: &ChainPlan,
    sealed: &SealedBox,
    commitment_expected: &str,
    envelope: &Envelope,
) -> Result<std::result::Result<Terms, Vec<String>>> {
    let unreadable = || {
        Ok(Err(vec![
            "The sealed plan could not be opened or read".to_string()
        ]))
    };
    let Ok(text) = open_sealed(keys.box_secret()?, sealed) else {
        return unreadable();
    };
    let Ok(opened) = serde_json::from_str::<Value>(&text) else {
        return unreadable();
    };
    let (plan_value, salt) = match (&opened["plan"], opened["salt"].as_str()) {
        (p @ Value::Object(_), Some(s)) if s.len() == 64 && hex::decode(s).is_ok() => {
            (p.clone(), s.to_string())
        }
        _ => return unreadable(),
    };
    let Ok(plan) = serde_json::from_value::<Plan>(plan_value.clone()) else {
        return unreadable();
    };
    let mut reasons = plan_problems(&plan)?;
    if commitment(&plan_value, &salt)? != commitment_expected {
        reasons.push("The plan does not match the on-chain commitment".into());
    }
    for (rule, ok) in envelope_checks(&plan, envelope)? {
        if !ok {
            reasons.push(format!("Outside the public envelope: {rule}"));
        }
    }
    reasons.extend(public_fact_problems(chain, &plan)?);
    if !reasons.is_empty() {
        return Ok(Err(reasons));
    }
    Ok(Ok(Terms {
        plan: plan_value,
        salt,
        commitment: commitment_expected.to_string(),
        envelope: envelope.clone(),
    }))
}

fn ack(keys: &dyn Keys, plan_id: u64, terms: &Terms, now_ms: i64) -> Result<Value> {
    let message = json!({
        "type": "ack",
        "plan_id": plan_id,
        "commitment": terms.commitment,
        "envelope": terms.envelope,
        "within_envelope": true,
        "issued_at_ms": now_ms,
    });
    signed(keys, ACK_DOMAIN, message.to_string())
}

fn initial_state(plan: &Plan, rng: &mut dyn RandomBytes) -> Result<State> {
    let l = limits(plan)?;
    let offset = random_between(U256::zero(), U256::from(l.max_gap_ms as u64), rng)?;
    Ok(State {
        period_index: 0,
        sold_in_period: "0".into(),
        sold_total: "0".into(),
        last_sale_ms: None,
        next_sale_at_ms: l.start_ms + offset.as_u64() as i64,
    })
}

fn accept(cx: &mut Context, chain: &ChainPlan, sealed: &SealedBox, now_ms: i64) -> Result<Value> {
    if chain.status != "awaiting_ack" {
        return Ok(json!({ "ok": false, "reasons": ["The plan is not awaiting an ack"] }));
    }
    let terms = match open_for_plan(cx.keys, chain, sealed, &chain.commitment, &chain.envelope)? {
        Ok(t) => t,
        Err(reasons) => return Ok(json!({ "ok": false, "reasons": reasons })),
    };
    let plan: Plan = serde_json::from_value(terms.plan.clone()).map_err(|e| e.to_string())?;
    let record = Record {
        state: initial_state(&plan, cx.rng)?,
        terms,
        inflight: None,
        pending: None,
        staged: None,
        handover: None,
        seen_seq: Some(chain.next_seq),
    };
    Ok(json!({
        "ok": true,
        "ack": ack(cx.keys, chain.id, &record.terms, now_ms)?,
        "record": seal_record(cx.keys, chain.id, &record)?,
    }))
}

fn stage(
    cx: &mut Context,
    chain: &ChainPlan,
    sealed: &SealedBox,
    sealed_record: Option<&str>,
) -> Result<Value> {
    let change = match &chain.pending_change {
        Some(PendingChange {
            kind,
            commitment: Some(c),
            envelope: Some(e),
            ..
        }) if kind == "modify" => (c.clone(), e.clone()),
        _ => return Ok(json!({ "ok": false, "reasons": ["No plan change is pending on-chain"] })),
    };
    let terms = match open_for_plan(cx.keys, chain, sealed, &change.0, &change.1)? {
        Ok(t) => t,
        Err(reasons) => return Ok(json!({ "ok": false, "reasons": reasons })),
    };
    let mut record = match sealed_record {
        Some(r) => open_record(cx.keys, chain.id, r)?,
        None => {
            let plan: Plan =
                serde_json::from_value(terms.plan.clone()).map_err(|e| e.to_string())?;
            Record {
                state: initial_state(&plan, cx.rng)?,
                terms: terms.clone(),
                inflight: None,
                pending: None,
                staged: None,
                handover: Some(Handover {
                    applied_at_ms: None,
                }),
                seen_seq: None,
            }
        }
    };
    record.staged = Some(terms);
    Ok(json!({ "ok": true, "record": seal_record(cx.keys, chain.id, &record)? }))
}

// ── Selling ────────────────────────────────────────────────────────────────────────────────────

/// Wait reasons that are public anyway. The others (not yet scheduled, gap or period budget)
/// would tell the world about the sealed schedule and limits, so they become "waiting".
fn public_wait(reason: &str, until_ms: Option<i64>) -> (String, Option<i64>) {
    match reason {
        "not_started" | "ended" | "allocation_used" => (reason.into(), until_ms),
        _ => ("waiting".into(), None),
    }
}

fn idle(reason: &str, until_ms: Option<i64>, record: Option<String>) -> Value {
    json!({ "type": "idle", "reason": reason, "until_ms": until_ms, "record": record })
}

fn record_sale(plan: &Plan, s: &State, f: &Inflight, rng: &mut dyn RandomBytes) -> Result<State> {
    let same_period = f.period_index == s.period_index;
    let sold_in_period = if same_period {
        amount(&s.sold_in_period)?
    } else {
        U256::zero()
    };
    let sale = amount(&f.amount)?;
    Ok(State {
        period_index: f.period_index,
        sold_in_period: (sold_in_period + sale).to_string(),
        sold_total: (amount(&s.sold_total)? + sale).to_string(),
        last_sale_ms: Some(f.issued_at_ms),
        next_sale_at_ms: schedule_after(plan, f.issued_at_ms, rng)?,
    })
}

fn defer_sale(plan: &Plan, s: &State, now: i64, rng: &mut dyn RandomBytes) -> Result<State> {
    Ok(State {
        next_sale_at_ms: schedule_after(plan, now, rng)?,
        ..s.clone()
    })
}

fn tick(
    cx: &mut Context,
    chain: &ChainPlan,
    sealed_record: &str,
    now: i64,
    balance: &str,
    last_receipt: Option<&ReceiptView>,
) -> Result<Value> {
    let mut record = open_record(cx.keys, chain.id, sealed_record)?;
    if chain.status != "active" {
        return Ok(idle(&format!("plan_{}", chain.status), None, None));
    }
    let mut changed = false;
    // A staged change the chain has now applied becomes the plan the enclave follows.
    if let Some(staged) = record.staged.clone() {
        if chain.commitment == staged.commitment {
            record.terms = staged;
            record.staged = None;
            record.inflight = None;
            record.pending = None;
            if let Some(h) = record.handover.as_mut() {
                h.applied_at_ms.get_or_insert(now);
            }
            changed = true;
        }
    }
    // Before the commitment check: a build taking a plan over holds only the staged terms.
    if let (Some(staged), Some(change)) = (&record.staged, &chain.pending_change) {
        if change.kind == "modify"
            && change.commitment.as_deref() == Some(staged.commitment.as_str())
            && now >= change.effective_at_ms
        {
            return Ok(json!({
                "type": "ack_change",
                "ack": ack(cx.keys, chain.id, staged, now)?,
                "record": if changed { Some(seal_record(cx.keys, chain.id, &record)?) } else { None },
            }));
        }
    }
    if chain.commitment != record.terms.commitment {
        return Ok(idle("commitment_mismatch", None, None));
    }
    let plan = record.plan()?;
    if let Some(applied_at) = record.handover.as_ref().and_then(|h| h.applied_at_ms) {
        // The previous build may have signed a sale just before the change applied; it can land
        // until its request expires. Counting starts from the registry only after that.
        if now < applied_at + REQUEST_TTL_MS {
            let r = changed
                .then(|| seal_record(cx.keys, chain.id, &record))
                .transpose()?;
            return Ok(idle("waiting", None, r));
        }
        record.state = handover_state(&plan, &chain.counters, cx.rng)?;
        record.handover = None;
        changed = true;
    }

    // Settle the last signed request from the chain, not the host's word.
    let own_key = signing_key_text(cx.keys)?;
    let mut own_landed = 0;
    if let Some(inflight) = record.inflight.clone() {
        if chain.next_seq > inflight.seq {
            let landed = last_receipt.is_some_and(|r| {
                r.seq == inflight.seq
                    && r.status != "failed"
                    && r.enclave_key.as_deref().is_none_or(|k| k == own_key)
            });
            own_landed = u64::from(landed);
            record.state = if landed {
                record_sale(&plan, &record.state, &inflight, cx.rng)?
            } else {
                defer_sale(&plan, &record.state, now, cx.rng)?
            };
            record.inflight = None;
            changed = true;
        } else if now <= inflight.expires_at_ms {
            let r = changed
                .then(|| seal_record(cx.keys, chain.id, &record))
                .transpose()?;
            return Ok(idle("waiting", None, r));
        } else {
            record.inflight = None;
            changed = true;
        }
    }
    // Receipts this build did not sign (a backup build standing in, or the primary after one did)
    // are counted from the registry, which counts every key's sales.
    match record.seen_seq {
        Some(seen) => {
            if chain.next_seq > seen + own_landed {
                record.state = handover_state(&plan, &chain.counters, cx.rng)?;
                changed = true;
            }
            if seen != chain.next_seq {
                record.seen_seq = Some(chain.next_seq);
                changed = true;
            }
        }
        // A record that has not tracked the registry yet (a takeover, just counted from the
        // registry's counters) starts now, so later sales by another build are counted too.
        None => {
            record.seen_seq = Some(chain.next_seq);
            changed = true;
        }
    }
    // A decision that was never quoted is dropped and made again below.
    if record.pending.take().is_some() {
        changed = true;
    }

    let proposal = propose_sale(
        &plan,
        &record.terms.envelope,
        &record.state,
        now,
        amount(balance)?,
        cx.rng,
    )?;
    let (sale, period_index) = match proposal {
        Proposal::Wait { reason, until_ms } => {
            let (reason, until_ms) = public_wait(reason, until_ms);
            let r = changed
                .then(|| seal_record(cx.keys, chain.id, &record))
                .transpose()?;
            return Ok(idle(&reason, until_ms, r));
        }
        Proposal::Sell {
            amount,
            period_index,
        } => (amount, period_index),
    };
    record.pending = Some(Pending {
        seq: chain.next_seq,
        amount: sale.clone(),
        period_index,
        decided_at_ms: now,
    });
    Ok(json!({
        "type": "quote",
        "seq": chain.next_seq,
        "amount": sale,
        "quote_request": quote_request(chain, &plan, &sale, now)?,
        "record": seal_record(cx.keys, chain.id, &record)?,
    }))
}

/// The 1Click asset id of the plan's token (`originAssetId`).
fn origin_asset_id(plan: &Plan) -> String {
    if plan.token.chain == "near" {
        format!("nep141:{}", plan.token.address)
    } else {
        format!("nep141:eth-{}.omft.near", plan.token.address)
    }
}

fn refund_to(chain: &ChainPlan, plan: &Plan) -> String {
    if plan.token.chain == "evm" {
        chain.evm_address.clone().unwrap_or_default()
    } else {
        chain.plan_account.clone()
    }
}

fn quote_request(chain: &ChainPlan, plan: &Plan, sale: &str, now: i64) -> Result<Value> {
    Ok(json!({
        "dry": false,
        "swapType": "EXACT_INPUT",
        "slippageTolerance": plan.max_slippage_bps,
        "originAsset": origin_asset_id(plan),
        "depositType": "ORIGIN_CHAIN",
        "destinationAsset": plan.beneficiary.asset,
        "amount": sale,
        "refundTo": refund_to(chain, plan),
        "refundType": "ORIGIN_CHAIN",
        "recipient": plan.beneficiary.near_account,
        "recipientType": "DESTINATION_CHAIN",
        "deadline": iso_from_ms(now + QUOTE_DEADLINE_MS),
    }))
}

/// `usdToE12`: a decimal USD string in 10^-12 USD, extra digits truncated.
fn usd_to_e12(value: &str) -> Option<u128> {
    let (whole, frac) = value.split_once('.').unwrap_or((value, ""));
    let digits = |s: &str| s.bytes().all(|b| b.is_ascii_digit());
    if whole.is_empty()
        || !digits(whole)
        || !digits(frac)
        || (value.contains('.') && frac.is_empty())
    {
        return None;
    }
    let frac: String = frac
        .chars()
        .chain(std::iter::repeat('0'))
        .take(12)
        .collect();
    format!("{whole}{frac}").parse().ok()
}

fn quote_cost_within_bound(q: &Value) -> bool {
    let (Some(in_usd), Some(out_usd)) = (
        q["amountInUsd"].as_str().and_then(usd_to_e12),
        q["amountOutUsd"].as_str().and_then(usd_to_e12),
    ) else {
        return false;
    };
    let cost = in_usd.saturating_sub(out_usd);
    cost.checked_mul(10_000)
        .is_some_and(|c| c <= in_usd * QUOTE_COST_MAX_BPS + QUOTE_COST_FLAT_USD_E12 * 10_000)
}

/// The quote comes through the host, so the enclave checks it is genuine and is the quote it
/// asked for. The registry repeats the binding checks on-chain.
fn quote_problems(
    cx: &Context,
    chain: &ChainPlan,
    plan: &Plan,
    sale: &str,
    quote: &SignedQuote,
    q: &Value,
    now: i64,
) -> Vec<String> {
    let s = |k: &str| q[k].as_str().unwrap_or_default().to_string();
    let mut problems = Vec::new();
    if !verify_quote(cx.quote_signer_key, &quote.payload, &quote.signature) {
        problems.push("The quote is not signed by 1Click".into());
    }
    if q["dry"] != Value::Bool(false) || s("swapType") != "EXACT_INPUT" {
        problems.push("The quote is not a live exact-input quote".into());
    }
    if s("depositAddress").is_empty() {
        problems.push("1Click gave no deposit address".into());
    }
    if s("recipient") != plan.beneficiary.near_account {
        problems.push("The quote pays someone other than the beneficiary".into());
    }
    if s("destinationAsset") != plan.beneficiary.asset {
        problems.push("The quote pays out in a different asset".into());
    }
    if s("amountIn") != sale || s("amount") != sale {
        problems.push("The quote is for a different amount".into());
    }
    if plan.token.chain == "near" && s("originAsset") != origin_asset_id(plan) {
        problems.push("The quote sells a different token".into());
    }
    if !s("refundTo").eq_ignore_ascii_case(&refund_to(chain, plan)) {
        problems.push("The quote refunds somewhere other than the plan".into());
    }
    if !parse_iso_ms(&s("deadline")).is_ok_and(|d| d > now) {
        problems.push("The quote has expired".into());
    }
    if !quote_cost_within_bound(q) {
        problems.push("The quote costs more than the fee bound allows".into());
    }
    problems
}

#[allow(clippy::too_many_arguments)]
fn sell(
    cx: &mut Context,
    chain: &ChainPlan,
    sealed_record: &str,
    now: i64,
    quote: &SignedQuote,
    prices: &[PriceObservation],
    evm_fees: Option<&EvmFees>,
) -> Result<Value> {
    let mut record = open_record(cx.keys, chain.id, sealed_record)?;
    let Some(pending) = record.pending.take() else {
        return Ok(idle("waiting", None, None));
    };
    let fresh = pending.seq == chain.next_seq
        && now >= pending.decided_at_ms
        && now - pending.decided_at_ms <= PENDING_TTL_MS
        && chain.status == "active"
        && chain.commitment == record.terms.commitment;
    if !fresh {
        return Ok(idle(
            "waiting",
            None,
            Some(seal_record(cx.keys, chain.id, &record)?),
        ));
    }
    let plan = record.plan()?;
    let q: Value = serde_json::from_str(&quote.payload).unwrap_or(Value::Null);
    let mut reasons = quote_problems(cx, chain, &plan, &pending.amount, quote, &q, now);
    let sale = amount(&pending.amount)?;
    let field = |k: &str| q[k].as_str().unwrap_or("0").to_string();
    let market = check_market(
        &plan,
        &record.terms.envelope,
        sale,
        prices,
        &QuoteView {
            amount_in: field("amountIn"),
            amount_out: field("amountOut"),
            min_amount_out: field("minAmountOut"),
        },
        chain.quote_decimals,
    );
    let market = match market {
        Ok(m) => m,
        Err(_) => {
            reasons.push("The quote could not be read".into());
            Value::Null
        }
    };
    if market["ok"] != Value::Bool(true) {
        reasons.push("market".into());
    }
    let deposit_address = field("depositAddress");
    let action = match (&chain.asset, evm_fees) {
        (ChainAsset::Nep141 { .. }, _) => Some(json!({
            "type": "nep141_transfer",
            "receiver_id": deposit_address,
            "amount": pending.amount,
            "register_receiver": true,
        })),
        (ChainAsset::EvmErc20 { .. }, Some(fees)) => Some(json!({
            "type": "evm_erc20_transfer",
            "to": deposit_address.to_ascii_lowercase(),
            "amount": pending.amount,
            "nonce": chain.evm_nonce,
            "gas_limit": EVM_GAS_LIMIT,
            "max_fee_per_gas": amount(&fees.max_fee_per_gas)?.to_string(),
            "max_priority_fee_per_gas": amount(&fees.max_priority_fee_per_gas)?.to_string(),
        })),
        (ChainAsset::EvmErc20 { .. }, None) => None,
    };
    let request = action.map(|action| {
        json!({
            "plan_id": chain.id,
            "seq": chain.next_seq,
            "commitment": record.terms.commitment,
            "action": action,
            "settlement": {
                "venue": "1click",
                "correlation_id": quote.correlation_id,
                "deposit_address": deposit_address,
                "min_amount_out": field("minAmountOut"),
                "destination_asset": plan.beneficiary.asset,
                "quote": { "payload": quote.payload, "signature": quote.signature },
            },
            "compliance": market["compliance"],
            "issued_at_ms": now,
            "expires_at_ms": now + REQUEST_TTL_MS,
        })
        .to_string()
    });
    let request = match request {
        Some(r) if reasons.is_empty() && r.len() <= MAX_REQUEST_JSON_BYTES => r,
        // Skip reasons stay inside: they would reveal the floor and the sources.
        _ => {
            record.state = defer_sale(&plan, &record.state, now, cx.rng)?;
            return Ok(json!({
                "type": "skipped",
                "record": seal_record(cx.keys, chain.id, &record)?,
            }));
        }
    };
    record.inflight = Some(Inflight {
        seq: chain.next_seq,
        amount: pending.amount.clone(),
        period_index: pending.period_index,
        issued_at_ms: now,
        expires_at_ms: now + REQUEST_TTL_MS,
    });
    Ok(json!({
        "type": "execute",
        "seq": chain.next_seq,
        "amount": pending.amount,
        "request": signed(cx.keys, EXECUTE_DOMAIN, request)?,
        "record": seal_record(cx.keys, chain.id, &record)?,
    }))
}

fn reveal(cx: &mut Context, chain: &ChainPlan, sealed_record: &str) -> Result<Value> {
    // Only what the chain says counts: the plan has ended and its owner chose end_reveal.
    if chain.status != "ended" {
        return Ok(json!({ "ok": false, "reason": "The plan has not ended" }));
    }
    if chain.disclosure.kind != "end_reveal" {
        return Ok(json!({ "ok": false, "reason": "The plan did not choose end_reveal" }));
    }
    let record = open_record(cx.keys, chain.id, sealed_record)?;
    if record.terms.commitment != chain.commitment {
        return Ok(json!({ "ok": false, "reason": "The held plan is not the committed one" }));
    }
    Ok(json!({
        "ok": true,
        "plan_json": canonical_json(&record.terms.plan),
        "salt": record.terms.salt,
    }))
}

/// One run: a JSON request on stdin, `{"ok":true,"result":…}` or `{"ok":false,"error":"…"}` on
/// stdout. A refusal is still a successful run, because OutLayer reports a failed run as `null`.
pub fn run_stdio(cx: &mut Context) {
    use std::io::Read;
    let mut input = String::new();
    let outcome = std::io::stdin()
        .read_to_string(&mut input)
        .map_err(|e| e.to_string())
        .and_then(|_| {
            serde_json::from_str::<Request>(&input).map_err(|e| format!("bad request: {e}"))
        })
        .and_then(|req| handle(cx, req));
    let out = match outcome {
        Ok(result) => json!({ "ok": true, "result": result }),
        Err(error) => json!({ "ok": false, "error": error }),
    };
    println!("{out}");
}

/// Milliseconds since the epoch as `YYYY-MM-DDTHH:MM:SS.mmmZ` (`Date.prototype.toISOString`).
pub fn iso_from_ms(ms: i64) -> String {
    let days = ms.div_euclid(86_400_000);
    let rem = ms.rem_euclid(86_400_000);
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z",
        rem / 3_600_000,
        rem / 60_000 % 60,
        rem / 1000 % 60,
        rem % 1000
    )
}

#[cfg(test)]
mod tests;
