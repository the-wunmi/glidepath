//! The blind trust's enclave logic (prototype), ported from `packages/trust`: the mandate's rules,
//! the rebalance decision, and the three one-shot operations an OutLayer build would run
//! (`trust_accept`, `trust_tick`, `trust_trade`). The pure parts are checked case by case against
//! the TypeScript code by `scripts/enclave-wasi.ts`; nothing here changes the plan operations.
//!
//! As with plans, every run's input and output is public on OutLayer, so the output carries only
//! signed messages, ciphertext and what the chain shows anyway (a trade's pair and amount are in
//! its quote and on-chain once it lands). Why the enclave held or skipped stays inside.

use crate::enclave::{iso_from_ms, Context, Keys};
use crate::*;
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

pub const TRUST_ACK_DOMAIN: &str = "vsp/trust-ack/v1\n";
pub const TRUST_TRADE_DOMAIN: &str = "vsp/trust-trade/v1\n";
/// `TRUST_REQUEST_TTL_MS`: a signed trade is good for five minutes.
const REQUEST_TTL_MS: i64 = 300_000;
/// `TRUST_QUOTE_DEADLINE_MS`.
const QUOTE_DEADLINE_MS: i64 = 600_000;
/// `TRUST_PENDING_TTL_MS`.
const PENDING_TTL_MS: i64 = 300_000;
/// The contract's `MAX_SLIPPAGE_BPS`.
const MAX_SLIPPAGE_BPS: u32 = 100;
/// The contract refuses longer trade requests.
const MAX_REQUEST_JSON_BYTES: usize = 8192;
const MAX_MANDATE_ASSETS: usize = 12;
/// The trust contract's `TRUST_COST_MAX_BPS`: at most 50 bps of the input value, no flat part.
const TRUST_COST_MAX_BPS: u128 = 50;
/// The trust contract's `MIN_TRADE_USD_E6` ($10), in USD × 10^12 as quotes print it.
const MIN_TRADE_USD_E12: u128 = 10_000_000_000_000;

// ── The mandate ────────────────────────────────────────────────────────────────────────────────

#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct UniverseEntry {
    pub asset: String,
    pub sector: String,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct Target {
    pub asset: String,
    pub weight_bps: u32,
}

/// `TrustMandate`. Unknown fields are refused, as the TypeScript schema strips them before the
/// commitment is computed and a box carrying extras could not match it anyway.
#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct Mandate {
    pub version: u32,
    pub universe: Vec<UniverseEntry>,
    pub excluded_sectors: Vec<String>,
    pub targets: Vec<Target>,
    pub band_bps: u32,
    pub max_trade_usd: String,
    pub min_trade_usd: String,
    pub beneficiary: String,
    pub end: String,
}

/// `TrustEnvelope`, as the contract serialises it.
#[derive(Deserialize, Serialize, Clone, Debug, PartialEq)]
pub struct TrustEnvelope {
    pub excluded_assets: Vec<String>,
    pub period_ms: i64,
    pub max_turnover_usd_e6: String,
    pub min_gap_ms: i64,
}

fn account_id_ok(s: &str) -> bool {
    (2..=64).contains(&s.len())
        && s.split('.').all(|part| {
            !part.is_empty()
                && part.split(['-', '_']).all(|w| {
                    !w.is_empty()
                        && w.bytes()
                            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
                })
        })
}

fn asset_id_ok(s: &str) -> bool {
    s.len() <= 128 && s.strip_prefix("nep141:").is_some_and(account_id_ok)
}

fn sector_ok(s: &str) -> bool {
    let b = s.as_bytes();
    (1..=32).contains(&b.len())
        && b[0].is_ascii_lowercase()
        && b.iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

/// `UsdDecimal`: up to nine whole digits and six decimals.
fn usd_ok(s: &str) -> bool {
    let (whole, frac) = s.split_once('.').unwrap_or((s, ""));
    let digits = |p: &str| p.bytes().all(|b| b.is_ascii_digit());
    (1..=9).contains(&whole.len())
        && digits(whole)
        && (!s.contains('.') || (1..=6).contains(&frac.len()) && digits(frac))
}

/// What the TypeScript schema enforces field by field; a mandate failing it cannot be read.
fn schema_ok(m: &Mandate) -> bool {
    m.version == 1
        && (1..=MAX_MANDATE_ASSETS).contains(&m.universe.len())
        && m.excluded_sectors.len() <= MAX_MANDATE_ASSETS
        && (1..=MAX_MANDATE_ASSETS).contains(&m.targets.len())
        && m.universe
            .iter()
            .all(|u| asset_id_ok(&u.asset) && sector_ok(&u.sector))
        && m.excluded_sectors.iter().all(|s| sector_ok(s))
        && m.targets
            .iter()
            .all(|t| asset_id_ok(&t.asset) && (1..=10_000).contains(&t.weight_bps))
        && (1..=5_000).contains(&m.band_bps)
        && usd_ok(&m.max_trade_usd)
        && usd_ok(&m.min_trade_usd)
        && account_id_ok(&m.beneficiary)
        && parse_iso_ms(&m.end).is_ok()
}

fn usd_e6(value: &str) -> Result<U256> {
    to_base_units(value, 6)
}

/// `mandateProblems`, same texts in the same order.
pub fn mandate_problems(m: &Mandate) -> Result<Vec<String>> {
    let mut problems = Vec::new();
    let weights: u64 = m.targets.iter().map(|t| u64::from(t.weight_bps)).sum();
    if weights != 10_000 {
        problems.push("Target weights must add up to 100%".to_string());
    }
    let universe: Vec<&str> = m.universe.iter().map(|u| u.asset.as_str()).collect();
    let targets: Vec<&str> = m.targets.iter().map(|t| t.asset.as_str()).collect();
    let unique = |v: &[&str]| v.iter().collect::<BTreeSet<_>>().len() == v.len();
    if !unique(&universe) || !unique(&targets) {
        problems.push("An asset appears twice".to_string());
    }
    if !targets.iter().all(|a| universe.contains(a)) {
        problems.push("Every target must be in the allowed universe".to_string());
    }
    if m.universe
        .iter()
        .any(|u| targets.contains(&u.asset.as_str()) && m.excluded_sectors.contains(&u.sector))
    {
        problems.push("A target is in an excluded sector".to_string());
    }
    let max = usd_e6(&m.max_trade_usd)?;
    if usd_e6(&m.min_trade_usd)? > max {
        problems.push("The smallest trade cannot be larger than the largest".to_string());
    }
    if max.is_zero() {
        problems.push("The largest trade must be above zero".to_string());
    }
    Ok(problems)
}

/// `checkMandateEnvelope`.
pub fn check_mandate_envelope(m: &Mandate, e: &TrustEnvelope) -> Result<Vec<(String, bool)>> {
    Ok(vec![
        (
            "No target is on the public exclusion list".to_string(),
            m.targets
                .iter()
                .all(|t| !e.excluded_assets.contains(&t.asset)),
        ),
        (
            "The largest trade fits the turnover cap".to_string(),
            usd_e6(&m.max_trade_usd)? <= amount(&e.max_turnover_usd_e6)?,
        ),
    ])
}

// ── The decision ───────────────────────────────────────────────────────────────────────────────

#[derive(Deserialize, Clone, Debug)]
pub struct Holding {
    pub asset: String,
    pub amount: String,
    pub decimals: u32,
}

#[derive(Deserialize, Clone, Debug)]
pub struct AssetPrice {
    pub asset: String,
    pub price_usd_e6: String,
}

#[derive(Deserialize, Clone, Debug)]
pub struct Counters {
    pub start_ms: i64,
    pub period_index: i64,
    pub turnover_in_period_usd_e6: String,
    pub last_trade_ms: Option<i64>,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Decision {
    Hold {
        reason: &'static str,
    },
    Trade {
        origin: String,
        destination: String,
        amount: String,
        usd_e6: String,
    },
}

/// Hold reasons the chain shows anyway (`PUBLIC_HOLD_REASONS`).
const PUBLIC_HOLD_REASONS: [&str; 3] = ["not_started", "min_gap", "turnover_used"];

/// `remainingTurnoverE6`.
pub fn remaining_turnover_e6(e: &TrustEnvelope, c: &Counters, now: i64) -> Result<U256> {
    if now < c.start_ms || e.period_ms <= 0 {
        return Ok(U256::zero());
    }
    let period = (now - c.start_ms) / e.period_ms;
    let used = if period == c.period_index {
        amount(&c.turnover_in_period_usd_e6)?
    } else {
        U256::zero()
    };
    let cap = amount(&e.max_turnover_usd_e6)?;
    Ok(if cap > used { cap - used } else { U256::zero() })
}

fn pow10(n: u32) -> U256 {
    U256::from(10u8).pow(U256::from(n))
}

/// `decideRebalance`, step for step.
pub fn decide_rebalance(
    m: &Mandate,
    e: &TrustEnvelope,
    c: &Counters,
    holdings: &[Holding],
    prices: &[AssetPrice],
    now: i64,
) -> Result<Decision> {
    let hold = |reason| Ok(Decision::Hold { reason });
    if now < c.start_ms {
        return hold("not_started");
    }
    if c.last_trade_ms
        .is_some_and(|last| now - last < e.min_gap_ms)
    {
        return hold("min_gap");
    }
    let remaining = remaining_turnover_e6(e, c, now)?;
    if remaining.is_zero() {
        return hold("turnover_used");
    }
    let mut price_of = BTreeMap::new();
    for p in prices {
        price_of.insert(p.asset.as_str(), amount(&p.price_usd_e6)?);
    }
    let mut values: BTreeMap<&str, U256> = BTreeMap::new();
    let mut held: BTreeMap<&str, &Holding> = BTreeMap::new();
    for h in holdings {
        let amt = amount(&h.amount)?;
        if amt.is_zero() {
            continue;
        }
        let Some(price) = price_of.get(h.asset.as_str()) else {
            return hold("no_price");
        };
        let value = amt * *price / pow10(h.decimals);
        *values.entry(h.asset.as_str()).or_default() += value;
        held.insert(h.asset.as_str(), h);
    }
    let total = values.values().fold(U256::zero(), |a, b| a + *b);
    if total.is_zero() {
        return hold("no_value");
    }
    let mut weights: BTreeMap<&str, U256> = BTreeMap::new();
    for t in &m.targets {
        if !e.excluded_assets.contains(&t.asset) {
            weights.insert(t.asset.as_str(), U256::from(t.weight_bps));
        }
    }
    let total_weight = weights.values().fold(U256::zero(), |a, b| a + *b);
    if total_weight.is_zero() {
        return hold("no_target");
    }
    let band = total * U256::from(m.band_bps) / U256::from(10_000u32);
    let assets: BTreeSet<&str> = values.keys().chain(weights.keys()).copied().collect();
    let mut triggered = false;
    let mut origin: Option<(&str, U256)> = None;
    let mut destination: Option<(&str, U256)> = None;
    for asset in assets {
        let value = values.get(asset).copied().unwrap_or_default();
        let weight = weights.get(asset).copied().unwrap_or_default();
        let target = total * weight / total_weight;
        let over = if value > target {
            value - target
        } else {
            U256::zero()
        };
        let under = if target > value {
            target - value
        } else {
            U256::zero()
        };
        if (weight.is_zero() && !value.is_zero()) || over > band || under > band {
            triggered = true;
        }
        if !over.is_zero() && origin.is_none_or(|(_, o)| over > o) {
            origin = Some((asset, over));
        }
        if !weight.is_zero() && !under.is_zero() && destination.is_none_or(|(_, u)| under > u) {
            destination = Some((asset, under));
        }
    }
    let (Some((origin, over)), Some((destination, under)), true) = (origin, destination, triggered)
    else {
        return hold("within_bands");
    };
    let usd = [over, under, usd_e6(&m.max_trade_usd)?, remaining]
        .into_iter()
        .min()
        .unwrap_or_default();
    if usd < usd_e6(&m.min_trade_usd)? {
        return hold("too_small");
    }
    let source = held[origin];
    let price = price_of[origin];
    let amt = (usd * pow10(source.decimals) / price).min(amount(&source.amount)?);
    if amt.is_zero() {
        return hold("too_small");
    }
    Ok(Decision::Trade {
        origin: origin.to_string(),
        destination: destination.to_string(),
        amount: amt.to_string(),
        usd_e6: usd.to_string(),
    })
}

// ── The one-shot operations ────────────────────────────────────────────────────────────────────

/// The public facts of a trust (the contract's `get_trust`, as the host read it).
#[derive(Deserialize, Clone, Debug)]
pub struct ChainTrust {
    pub id: u64,
    pub status: String,
    pub commitment: String,
    pub envelope: TrustEnvelope,
    pub beneficiary: String,
    pub trust_account: String,
    pub end_ms: i64,
    pub next_seq: u64,
    pub pending_change: Option<ChainChange>,
    #[serde(flatten)]
    pub counters: Counters,
}

#[derive(Deserialize, Clone, Debug)]
pub struct ChainChange {
    pub kind: String,
    pub effective_at_ms: i64,
}

#[derive(Deserialize, Clone, Debug)]
pub struct TrustQuote {
    pub payload: String,
    pub signature: String,
    pub correlation_id: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
struct Pending {
    seq: u64,
    origin: String,
    destination: String,
    amount: String,
    decided_at_ms: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
struct Inflight {
    seq: u64,
    expires_at_ms: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
struct Record {
    mandate: Value,
    salt: String,
    commitment: String,
    pending: Option<Pending>,
    inflight: Option<Inflight>,
}

impl Record {
    fn mandate(&self) -> Result<Mandate> {
        serde_json::from_value(self.mandate.clone()).map_err(|_| "the record is corrupt".into())
    }
}

/// Bound to the trust id, so the host cannot hand one trust's record to another (or to a plan).
fn record_aad(trust_id: u64) -> Vec<u8> {
    format!("vsp/trust-record/v1:{trust_id}").into_bytes()
}

fn seal_record(keys: &dyn Keys, trust_id: u64, r: &Record) -> Result<String> {
    let json = serde_json::to_vec(r).map_err(|e| e.to_string())?;
    Ok(B64.encode(keys.seal(&json, &record_aad(trust_id))?))
}

fn open_record(keys: &dyn Keys, trust_id: u64, sealed: &str) -> Result<Record> {
    let bytes = B64.decode(sealed).map_err(|_| "invalid record encoding")?;
    let json = keys
        .open(&bytes, &record_aad(trust_id))
        .map_err(|_| "the record does not open with this enclave's key")?;
    serde_json::from_slice(&json).map_err(|_| "the record is corrupt".into())
}

fn signed(keys: &dyn Keys, domain: &str, json: String) -> Result<Value> {
    let sig = keys.sign(&[domain.as_bytes(), json.as_bytes()].concat())?;
    Ok(json!({
        "json": json,
        "signature": B64.encode(sig),
        "enclave_key": format!("ed25519:{}", bs58::encode(keys.signing_public_key()?).into_string()),
    }))
}

fn chain_idle_reason(chain: &ChainTrust, now: i64) -> Option<String> {
    if chain.status != "active" {
        return Some(format!("trust_{}", chain.status));
    }
    let cancelled = chain
        .pending_change
        .as_ref()
        .is_some_and(|c| c.kind == "cancel" && c.effective_at_ms <= now);
    (now >= chain.end_ms || cancelled).then(|| "ending".to_string())
}

fn idle(reason: &str, record: Option<String>) -> Value {
    json!({ "type": "idle", "reason": reason, "record": record })
}

/// `openMandate`: opens a box and checks it against the commitment, envelope and public facts.
fn open_mandate(
    keys: &dyn Keys,
    chain: &ChainTrust,
    sealed: &SealedBox,
) -> Result<std::result::Result<(Value, String), Vec<String>>> {
    let unreadable = || {
        Ok(Err(vec![
            "The sealed mandate could not be opened or read".to_string()
        ]))
    };
    let Ok(text) = open_sealed(keys.box_secret()?, sealed) else {
        return unreadable();
    };
    let Ok(opened) = serde_json::from_str::<Value>(&text) else {
        return unreadable();
    };
    let (value, salt) = match (&opened["mandate"], opened["salt"].as_str()) {
        (m @ Value::Object(_), Some(s))
            if s.len() == 64
                && s.bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) =>
        {
            (m.clone(), s.to_string())
        }
        _ => return unreadable(),
    };
    let Some(mandate) = serde_json::from_value::<Mandate>(value.clone())
        .ok()
        .filter(schema_ok)
    else {
        return unreadable();
    };
    let mut reasons = mandate_problems(&mandate)?;
    if commitment(&value, &salt)? != chain.commitment {
        reasons.push("The mandate does not match the on-chain commitment".into());
    }
    for (rule, ok) in check_mandate_envelope(&mandate, &chain.envelope)? {
        if !ok {
            reasons.push(format!("Outside the public envelope: {rule}"));
        }
    }
    if mandate.beneficiary != chain.beneficiary {
        reasons.push("The beneficiary differs from the contract".into());
    }
    if parse_iso_ms(&mandate.end)? != chain.end_ms {
        reasons.push("The end differs from the contract".into());
    }
    if !reasons.is_empty() {
        return Ok(Err(reasons));
    }
    Ok(Ok((value, salt)))
}

pub fn accept(cx: &mut Context, chain: &ChainTrust, sealed: &SealedBox, now: i64) -> Result<Value> {
    if chain.status != "awaiting_ack" {
        return Ok(json!({ "ok": false, "reasons": ["The trust is not awaiting an ack"] }));
    }
    let (mandate, salt) = match open_mandate(cx.keys, chain, sealed)? {
        Ok(opened) => opened,
        Err(reasons) => return Ok(json!({ "ok": false, "reasons": reasons })),
    };
    let record = Record {
        mandate,
        salt,
        commitment: chain.commitment.clone(),
        pending: None,
        inflight: None,
    };
    let ack = json!({
        "type": "trust_ack",
        "trust_id": chain.id,
        "commitment": chain.commitment,
        "envelope": chain.envelope,
        "beneficiary": chain.beneficiary,
        "end_ms": chain.end_ms,
        "trust_account": chain.trust_account,
        "within_envelope": true,
        "issued_at_ms": now,
    });
    Ok(json!({
        "ok": true,
        "ack": signed(cx.keys, TRUST_ACK_DOMAIN, ack.to_string())?,
        "record": seal_record(cx.keys, chain.id, &record)?,
    }))
}

pub fn tick(
    cx: &mut Context,
    chain: &ChainTrust,
    sealed_record: &str,
    now: i64,
    holdings: &[Holding],
    prices: &[AssetPrice],
) -> Result<Value> {
    if let Some(reason) = chain_idle_reason(chain, now) {
        return Ok(idle(&reason, None));
    }
    let mut record = open_record(cx.keys, chain.id, sealed_record)?;
    if record.commitment != chain.commitment {
        return Ok(idle("commitment_mismatch", None));
    }
    if let Some(inflight) = &record.inflight {
        if chain.next_seq <= inflight.seq && now <= inflight.expires_at_ms {
            return Ok(idle("waiting", None));
        }
        record.inflight = None;
    }
    record.pending = None;
    let mandate = record.mandate()?;
    let decision = decide_rebalance(
        &mandate,
        &chain.envelope,
        &chain.counters,
        holdings,
        prices,
        now,
    )?;
    let (origin, destination, amount) = match decision {
        Decision::Hold { reason } => {
            let public = if PUBLIC_HOLD_REASONS.contains(&reason) {
                reason
            } else {
                "waiting"
            };
            return Ok(idle(public, Some(seal_record(cx.keys, chain.id, &record)?)));
        }
        Decision::Trade {
            origin,
            destination,
            amount,
            ..
        } => (origin, destination, amount),
    };
    let quote_request = json!({
        "dry": false,
        "swapType": "EXACT_INPUT",
        "slippageTolerance": MAX_SLIPPAGE_BPS,
        "originAsset": origin,
        "depositType": "ORIGIN_CHAIN",
        "destinationAsset": destination,
        "amount": amount,
        "refundTo": chain.trust_account,
        "refundType": "ORIGIN_CHAIN",
        "recipient": chain.trust_account,
        "recipientType": "DESTINATION_CHAIN",
        "deadline": iso_from_ms(now + QUOTE_DEADLINE_MS),
    });
    record.pending = Some(Pending {
        seq: chain.next_seq,
        origin,
        destination,
        amount,
        decided_at_ms: now,
    });
    Ok(json!({
        "type": "quote",
        "seq": chain.next_seq,
        "quote_request": quote_request,
        "record": seal_record(cx.keys, chain.id, &record)?,
    }))
}

/// `usdToE12`: a decimal USD string in 10^-12 USD, extra digits truncated.
fn usd_e12(value: &str) -> Option<u128> {
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

/// `tradeQuoteProblems`: is this the genuine quote for the decided trade?
fn quote_problems(
    cx: &Context,
    chain: &ChainTrust,
    pending: &Pending,
    quote: &TrustQuote,
    q: &Value,
    now: i64,
) -> Vec<&'static str> {
    let s = |k: &str| q[k].as_str().unwrap_or_default().to_string();
    let mut problems = Vec::new();
    if !verify_quote(cx.quote_signer_key, &quote.payload, &quote.signature) {
        problems.push("The quote is not signed by 1Click");
    }
    if q["dry"] != Value::Bool(false) || s("swapType") != "EXACT_INPUT" {
        problems.push("The quote is not a live exact-input quote");
    }
    if s("depositAddress").is_empty() {
        problems.push("1Click gave no deposit address");
    }
    if s("recipient") != chain.trust_account || s("refundTo") != chain.trust_account {
        problems.push("The quote pays or refunds outside the trust");
    }
    if s("originAsset") != pending.origin || s("destinationAsset") != pending.destination {
        problems.push("The quote is for a different pair");
    }
    if s("amountIn") != pending.amount || s("amount") != pending.amount {
        problems.push("The quote is for a different amount");
    }
    if !parse_iso_ms(&s("deadline")).is_ok_and(|d| d > now) {
        problems.push("The quote has expired");
    }
    if s("depositType") != "ORIGIN_CHAIN"
        || s("refundType") != "ORIGIN_CHAIN"
        || s("recipientType") != "DESTINATION_CHAIN"
    {
        problems.push("The quote routes through intents");
    }
    let costs = usd_e12(&s("amountInUsd")).zip(usd_e12(&s("amountOutUsd")));
    let cost_ok = costs.is_some_and(|(i, o)| {
        i.saturating_sub(o)
            .checked_mul(10_000)
            .zip(i.checked_mul(TRUST_COST_MAX_BPS))
            .is_some_and(|(cost, allowed)| cost <= allowed)
    });
    if !cost_ok {
        problems.push("The quote costs more than the fee bound allows");
    }
    // The contract counts turnover rounded up to USD × 10^6 and refuses under $10.
    if !costs.is_some_and(|(i, _)| i.div_ceil(1_000_000) * 1_000_000 >= MIN_TRADE_USD_E12) {
        problems.push("The trade is under the smallest trade the contract takes");
    }
    let slippage_ok = amount(&s("minAmountOut"))
        .ok()
        .zip(amount(&s("amountOut")).ok())
        .is_some_and(|(min, out)| {
            min >= out * U256::from(10_000 - MAX_SLIPPAGE_BPS) / U256::from(10_000u32)
        });
    if !slippage_ok {
        problems.push("The quote allows too much slippage");
    }
    problems
}

pub fn trade(
    cx: &mut Context,
    chain: &ChainTrust,
    sealed_record: &str,
    now: i64,
    quote: &TrustQuote,
) -> Result<Value> {
    let mut record = open_record(cx.keys, chain.id, sealed_record)?;
    let Some(pending) = record.pending.take() else {
        return Ok(idle("waiting", None));
    };
    let fresh = pending.seq == chain.next_seq
        && now >= pending.decided_at_ms
        && now - pending.decided_at_ms <= PENDING_TTL_MS
        && chain_idle_reason(chain, now).is_none()
        && chain.commitment == record.commitment;
    if !fresh {
        return Ok(idle(
            "waiting",
            Some(seal_record(cx.keys, chain.id, &record)?),
        ));
    }
    let mandate = record.mandate()?;
    let q: Value = serde_json::from_str(&quote.payload).unwrap_or(Value::Null);
    let problems = quote_problems(cx, chain, &pending, quote, &q, now);
    // `tradeAttestation`: yes/no per statement, each checked against the mandate.
    let sector = mandate
        .universe
        .iter()
        .find(|u| u.asset == pending.destination)
        .map(|u| u.sector.clone());
    let not_excluded = !chain
        .envelope
        .excluded_assets
        .contains(&pending.destination)
        && sector.is_some_and(|s| !mandate.excluded_sectors.contains(&s));
    let turnover = usd_e12(q["amountInUsd"].as_str().unwrap_or_default())
        .map(|e12| U256::from(e12.div_ceil(1_000_000)));
    let within_turnover = match (
        turnover,
        remaining_turnover_e6(&chain.envelope, &chain.counters, now),
    ) {
        (Some(t), Ok(remaining)) => t <= remaining,
        _ => false,
    };
    let within_mandate = pending.origin != pending.destination
        && mandate
            .targets
            .iter()
            .any(|t| t.asset == pending.destination);
    let deposit_address = q["depositAddress"].as_str().unwrap_or_default();
    let request = json!({
        "trust_id": chain.id,
        "seq": chain.next_seq,
        "commitment": record.commitment,
        "origin_token": pending.origin.trim_start_matches("nep141:"),
        "amount": pending.amount,
        "settlement": {
            "venue": "1click",
            "correlation_id": quote.correlation_id,
            "deposit_address": deposit_address,
            "quote": { "payload": quote.payload, "signature": quote.signature },
        },
        "attestation": {
            "within_mandate": within_mandate,
            "not_excluded": not_excluded,
            "within_turnover": within_turnover,
        },
        "issued_at_ms": now,
        "expires_at_ms": now + REQUEST_TTL_MS,
    })
    .to_string();
    if !problems.is_empty()
        || !(within_mandate && not_excluded && within_turnover)
        || request.len() > MAX_REQUEST_JSON_BYTES
    {
        // Why stays inside: it would reveal the mandate's targets and limits.
        return Ok(json!({
            "type": "skipped",
            "record": seal_record(cx.keys, chain.id, &record)?,
        }));
    }
    record.inflight = Some(Inflight {
        seq: chain.next_seq,
        expires_at_ms: now + REQUEST_TTL_MS,
    });
    Ok(json!({
        "type": "execute",
        "seq": chain.next_seq,
        "request": signed(cx.keys, TRUST_TRADE_DOMAIN, request)?,
        "record": seal_record(cx.keys, chain.id, &record)?,
    }))
}

#[cfg(test)]
mod tests;
