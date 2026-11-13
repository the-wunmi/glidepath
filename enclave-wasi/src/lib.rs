//! The enclave's decision logic, ported from `packages/core` and `packages/planner` so it can run
//! as a WASI module (OutLayer runs WASI P1/P2 under wasmtime). Every function here must give the
//! same answer as its TypeScript original; `vectors.json`, generated from the TypeScript code by
//! `scripts/enclave-wasi.ts`, is the contract between the two.
//!
//! Amounts are base units as decimal strings in JSON and 256-bit integers inside, like the
//! registry, so products such as amount × price × 10^decimals never overflow.

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use chacha20poly1305::{aead::Aead, ChaCha20Poly1305, KeyInit};
use ed25519_dalek::{Signer, SigningKey, Verifier, VerifyingKey};
use hkdf::Hkdf;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub mod enclave;
pub mod local_keys;

#[allow(clippy::manual_div_ceil, clippy::assign_op_pattern)]
mod u256 {
    uint::construct_uint! {
        pub struct U256(4);
    }
}
pub use u256::U256;

pub const EXECUTE_DOMAIN: &str = "vsp/execute/v1\n";
pub const ACK_DOMAIN: &str = "vsp/ack/v1\n";
const SEAL_INFO: &[u8] = b"vsp/seal/v1";
const DAY_MS: i64 = 86_400_000;
const MINUTE_MS: i64 = 60_000;
const USD_E6: u64 = 1_000_000;

pub type Result<T> = std::result::Result<T, String>;

fn err<T>(msg: impl Into<String>) -> Result<T> {
    Err(msg.into())
}

// ── Numbers ────────────────────────────────────────────────────────────────────────────────────

/// Base units from a JSON string of at most 37 digits (the TypeScript `TokenAmount`).
pub fn amount(s: &str) -> Result<U256> {
    if s.is_empty() || s.len() > 37 || !s.bytes().all(|b| b.is_ascii_digit()) {
        return err(format!("invalid amount: {s}"));
    }
    U256::from_dec_str(s).map_err(|_| format!("invalid amount: {s}"))
}

fn pow10(n: u32) -> U256 {
    U256::from(10u8).pow(U256::from(n))
}

/// A decimal string ("1.5") in base units without floating point (`toBaseUnits`).
pub fn to_base_units(value: &str, decimals: u32) -> Result<U256> {
    let value = value.trim();
    let (whole, frac) = value.split_once('.').unwrap_or((value, ""));
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    if !digits(whole) || (value.contains('.') && !digits(frac)) {
        return err(format!("invalid amount: {value}"));
    }
    if frac.len() > decimals as usize {
        return err(format!("too many decimals (max {decimals}): {value}"));
    }
    let padded = format!("{whole}{frac:0<width$}", width = decimals as usize);
    U256::from_dec_str(&padded).map_err(|_| format!("invalid amount: {value}"))
}

/// `amount × bps ÷ 10 000`, rounded down.
pub fn bps_of_down(amount: U256, bps: u32) -> U256 {
    amount * U256::from(bps) / U256::from(10_000u32)
}

/// Implied price (e6) of selling `amount` for `out`, rounded down (`impliedPriceE6`).
pub fn implied_price_e6(amount: U256, out: U256, token_decimals: u32, quote_decimals: u32) -> U256 {
    if amount.is_zero() {
        return U256::zero();
    }
    out * pow10(token_decimals) * U256::from(USD_E6) / (amount * pow10(quote_decimals))
}

/// The registry's floor test: `min_out × 10^td × 10^6 ≥ amount × floor × 10^qd`.
pub fn meets_floor(amount: U256, min_out: U256, floor_e6: U256, td: u32, qd: u32) -> bool {
    min_out * pow10(td) * U256::from(USD_E6) >= amount * floor_e6 * pow10(qd)
}

fn abs_diff(a: U256, b: U256) -> U256 {
    if a > b {
        a - b
    } else {
        b - a
    }
}

// ── Time ───────────────────────────────────────────────────────────────────────────────────────

/// Milliseconds since the epoch for `YYYY-MM-DDTHH:MM:SS[.fff…]Z`, the only form the plan schema
/// accepts (`z.iso.datetime()`). Like `Date.parse`, fractions beyond milliseconds are dropped.
pub fn parse_iso_ms(s: &str) -> Result<i64> {
    let bad = || format!("invalid datetime: {s}");
    let b = s.as_bytes();
    if b.len() < 20
        || b[4] != b'-'
        || b[7] != b'-'
        || b[10] != b'T'
        || b[13] != b':'
        || b[16] != b':'
    {
        return Err(bad());
    }
    if *b.last().ok_or_else(bad)? != b'Z' {
        return Err(bad());
    }
    let num = |r: std::ops::Range<usize>| -> Result<i64> {
        let part = &s[r];
        if !part.bytes().all(|c| c.is_ascii_digit()) {
            return Err(bad());
        }
        part.parse::<i64>().map_err(|_| bad())
    };
    let (y, mo, d) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let (h, mi, sec) = (num(11..13)?, num(14..16)?, num(17..19)?);
    let mut ms = 0;
    let rest = &s[19..s.len() - 1];
    if !rest.is_empty() {
        let frac = rest.strip_prefix('.').ok_or_else(bad)?;
        if frac.is_empty() || !frac.bytes().all(|c| c.is_ascii_digit()) {
            return Err(bad());
        }
        let three: String = frac.chars().chain("00".chars()).take(3).collect();
        ms = three.parse::<i64>().map_err(|_| bad())?;
    }
    if !(1..=12).contains(&mo) || d < 1 || d > days_in_month(y, mo) || h > 23 || mi > 59 || sec > 59
    {
        return Err(bad());
    }
    Ok((((days_from_civil(y, mo, d) * 24 + h) * 60 + mi) * 60 + sec) * 1000 + ms)
}

fn days_in_month(y: i64, m: i64) -> i64 {
    match m {
        2 if (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

/// Days since 1970-01-01 (Howard Hinnant's algorithm).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

// ── Plan ───────────────────────────────────────────────────────────────────────────────────────

#[derive(Deserialize, Clone, Debug)]
pub struct Token {
    pub chain: String,
    pub address: String,
    #[serde(default)]
    pub chain_id: Option<u64>,
    pub symbol: String,
    pub decimals: u32,
}

#[derive(Deserialize, Clone, Debug)]
pub struct Beneficiary {
    pub near_account: String,
    #[serde(default)]
    pub evm_address: Option<String>,
    pub asset: String,
}

#[derive(Deserialize, Clone, Debug)]
pub struct Schedule {
    pub min_gap_minutes: i64,
    pub max_gap_minutes: i64,
}

/// The fields of the sealed plan the logic reads. Unknown fields are kept in the raw JSON, which
/// is what the commitment covers.
#[derive(Deserialize, Clone, Debug)]
pub struct Plan {
    pub version: u8,
    pub token: Token,
    pub beneficiary: Beneficiary,
    pub allocation: String,
    pub period_days: i64,
    pub max_sell_per_period_bps: u32,
    pub max_sell_per_tx_bps: u32,
    pub price_floor_usd: String,
    pub max_slippage_bps: u32,
    pub venues: Vec<String>,
    pub schedule: Schedule,
    pub start: String,
    pub end: String,
    pub price_sources: Vec<String>,
    pub price_agreement_bps: u32,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Envelope {
    pub period_ms: i64,
    pub max_amount_per_period: String,
    pub max_amount_per_tx: String,
    pub min_price_usd_e6: String,
    pub min_gap_ms: i64,
}

pub struct Limits {
    pub period_ms: i64,
    pub per_period: U256,
    pub per_tx: U256,
    pub floor_e6: U256,
    pub min_gap_ms: i64,
    pub max_gap_ms: i64,
    pub start_ms: i64,
    pub end_ms: i64,
}

/// `planLimits`.
pub fn limits(plan: &Plan) -> Result<Limits> {
    if plan.version != 1 {
        return err("unsupported plan version");
    }
    let allocation = amount(&plan.allocation)?;
    Ok(Limits {
        period_ms: plan.period_days * DAY_MS,
        per_period: bps_of_down(allocation, plan.max_sell_per_period_bps),
        per_tx: bps_of_down(allocation, plan.max_sell_per_tx_bps),
        floor_e6: to_base_units(&plan.price_floor_usd, 6)?,
        min_gap_ms: plan.schedule.min_gap_minutes * MINUTE_MS,
        max_gap_ms: plan.schedule.max_gap_minutes * MINUTE_MS,
        start_ms: parse_iso_ms(&plan.start)?,
        end_ms: parse_iso_ms(&plan.end)?,
    })
}

/// `checkWithinEnvelope`: the same rules, in the same order, with the same labels.
pub fn envelope_checks(plan: &Plan, e: &Envelope) -> Result<Vec<(String, bool)>> {
    let l = limits(plan)?;
    Ok(vec![
        ("Same period length".into(), l.period_ms == e.period_ms),
        (
            "Per-period limit within the public cap".into(),
            l.per_period <= amount(&e.max_amount_per_period)?,
        ),
        (
            "Per-sale limit within the public cap".into(),
            l.per_tx <= amount(&e.max_amount_per_tx)?,
        ),
        (
            "Price floor at or above the public floor".into(),
            l.floor_e6 >= amount(&e.min_price_usd_e6)?,
        ),
        (
            "Gap between sales at least the public minimum".into(),
            l.min_gap_ms >= e.min_gap_ms,
        ),
    ])
}

/// Deterministic JSON: keys sorted at every level, no whitespace (`canonicalJson`). serde_json's
/// map is a BTreeMap, which sorts keys bytewise; for the plan's ASCII keys that is the same order
/// as JavaScript's string comparison.
pub fn canonical_json(v: &Value) -> String {
    serde_json::to_string(v).expect("a JSON value always serialises")
}

/// `planCommitment`: hex sha256(canonical_json(plan) ‖ salt bytes).
pub fn commitment(plan: &Value, salt_hex: &str) -> Result<String> {
    let salt = hex::decode(salt_hex).map_err(|_| "invalid salt".to_string())?;
    if salt.len() != 32 {
        return err("Salt must be 32 bytes");
    }
    let mut h = Sha256::new();
    h.update(canonical_json(plan).as_bytes());
    h.update(&salt);
    Ok(hex::encode(h.finalize()))
}

// ── Sealing ────────────────────────────────────────────────────────────────────────────────────

#[derive(Deserialize, Clone, Debug)]
pub struct SealedBox {
    pub v: u8,
    pub epk: String,
    pub nonce: String,
    pub ct: String,
}

/// `openSealed`: X25519 with the box's ephemeral key, HKDF-SHA256 (salt = epk ‖ recipient,
/// info `vsp/seal/v1`), ChaCha20-Poly1305.
pub fn open_sealed(secret: [u8; 32], b: &SealedBox) -> Result<String> {
    if b.v != 1 {
        return err("unsupported box version");
    }
    let sk = x25519_dalek::StaticSecret::from(secret);
    let recipient = x25519_dalek::PublicKey::from(&sk);
    let epk: [u8; 32] = hex::decode(&b.epk)
        .ok()
        .and_then(|v| v.try_into().ok())
        .ok_or("invalid epk")?;
    let nonce: [u8; 12] = hex::decode(&b.nonce)
        .ok()
        .and_then(|v| v.try_into().ok())
        .ok_or("invalid nonce")?;
    let shared = sk.diffie_hellman(&x25519_dalek::PublicKey::from(epk));
    let mut salt = epk.to_vec();
    salt.extend_from_slice(recipient.as_bytes());
    let mut key = [0u8; 32];
    Hkdf::<Sha256>::new(Some(&salt), shared.as_bytes())
        .expand(SEAL_INFO, &mut key)
        .map_err(|_| "hkdf failed")?;
    let ct = B64
        .decode(&b.ct)
        .map_err(|_| "invalid ciphertext encoding")?;
    let pt = ChaCha20Poly1305::new(&key.into())
        .decrypt(&nonce.into(), ct.as_ref())
        .map_err(|_| "the box does not open with this key")?;
    String::from_utf8(pt).map_err(|_| "plaintext is not UTF-8".into())
}

// ── Signatures ─────────────────────────────────────────────────────────────────────────────────

pub fn near_public_key(key: &VerifyingKey) -> String {
    format!("ed25519:{}", bs58::encode(key.as_bytes()).into_string())
}

/// Signs `domain ‖ json` exactly as received, as every enclave message is signed.
pub fn sign(seed: [u8; 32], domain: &str, json: &str) -> (String, String) {
    let key = SigningKey::from_bytes(&seed);
    let sig = key.sign(&[domain.as_bytes(), json.as_bytes()].concat());
    (
        near_public_key(&key.verifying_key()),
        B64.encode(sig.to_bytes()),
    )
}

/// Checks a 1Click quote signature in 1Click's own format (verified 2026-11-11 against a live
/// quote): `signature` is `ed25519:<base58>` over the UTF-8 text of base58(sha256(Q)), where Q is
/// the exact payload string.
pub fn verify_quote(public_key: &str, payload: &str, signature: &str) -> bool {
    let decode = |s: &str| {
        s.strip_prefix("ed25519:")
            .and_then(|b| bs58::decode(b).into_vec().ok())
    };
    let Some(pk) = decode(public_key)
        .and_then(|v| <[u8; 32]>::try_from(v).ok())
        .and_then(|b| VerifyingKey::from_bytes(&b).ok())
    else {
        return false;
    };
    let Some(sig) = decode(signature).and_then(|v| <[u8; 64]>::try_from(v).ok()) else {
        return false;
    };
    let message = bs58::encode(Sha256::digest(payload.as_bytes())).into_string();
    pk.verify(
        message.as_bytes(),
        &ed25519_dalek::Signature::from_bytes(&sig),
    )
    .is_ok()
}

// ── Randomness and scheduling ──────────────────────────────────────────────────────────────────

/// A source of random bytes. In production it is the WASI host's `random_get`; the vectors use a
/// fixed stream so both languages can be compared draw for draw.
pub trait RandomBytes {
    fn fill(&mut self, out: &mut [u8]);
}

pub struct OsRandom;
impl RandomBytes for OsRandom {
    fn fill(&mut self, out: &mut [u8]) {
        getrandom::getrandom(out).expect("the host must provide randomness");
    }
}

/// sha256(seed ‖ u64 counter, big-endian) blocks, concatenated. Mirrored in `scripts/enclave-wasi.ts`.
pub struct SeededRandom {
    seed: Vec<u8>,
    counter: u64,
    buf: Vec<u8>,
}
impl SeededRandom {
    pub fn new(seed: Vec<u8>) -> Self {
        Self {
            seed,
            counter: 0,
            buf: Vec::new(),
        }
    }
}
impl RandomBytes for SeededRandom {
    fn fill(&mut self, out: &mut [u8]) {
        while self.buf.len() < out.len() {
            let mut h = Sha256::new();
            h.update(&self.seed);
            h.update(self.counter.to_be_bytes());
            self.counter += 1;
            self.buf.extend_from_slice(&h.finalize());
        }
        out.copy_from_slice(&self.buf[..out.len()]);
        self.buf.drain(..out.len());
    }
}

/// Uniform integer in [0, bound) by rejection sampling (`randomBelow`), byte for byte.
pub fn random_below(bound: U256, rng: &mut dyn RandomBytes) -> Result<U256> {
    if bound.is_zero() {
        return err("Bound must be positive");
    }
    let hex_len = format!("{bound:x}").len();
    let bytes = hex_len.div_ceil(2) + 1;
    if bytes > 31 {
        return err("bound too large");
    }
    let space = U256::one() << (bytes * 8);
    let limit = space - space % bound;
    let mut buf = vec![0u8; bytes];
    loop {
        rng.fill(&mut buf);
        let n = U256::from_big_endian(&buf);
        if n < limit {
            return Ok(n % bound);
        }
    }
}

pub fn random_between(lo: U256, hi: U256, rng: &mut dyn RandomBytes) -> Result<U256> {
    if hi <= lo {
        return Ok(lo);
    }
    Ok(lo + random_below(hi - lo + U256::one(), rng)?)
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct State {
    pub period_index: i64,
    pub sold_in_period: String,
    pub sold_total: String,
    pub last_sale_ms: Option<i64>,
    pub next_sale_at_ms: i64,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Proposal {
    Wait {
        reason: &'static str,
        until_ms: Option<i64>,
    },
    Sell {
        amount: String,
        period_index: i64,
    },
}

/// `proposeSale`: whether a sale is due now and how large it is.
pub fn propose_sale(
    plan: &Plan,
    e: &Envelope,
    state: &State,
    now: i64,
    balance: U256,
    rng: &mut dyn RandomBytes,
) -> Result<Proposal> {
    let l = limits(plan)?;
    let wait = |reason, until_ms| Ok(Proposal::Wait { reason, until_ms });
    if now < l.start_ms {
        return wait("not_started", Some(l.start_ms));
    }
    if now >= l.end_ms {
        return wait("ended", None);
    }
    if now < state.next_sale_at_ms {
        return wait("not_scheduled_yet", Some(state.next_sale_at_ms));
    }
    let min_gap = l.min_gap_ms.max(e.min_gap_ms);
    if let Some(last) = state.last_sale_ms {
        if now - last < min_gap {
            return wait("gap_too_short", Some(last + min_gap));
        }
    }
    let period_index = (now - l.start_ms).div_euclid(l.period_ms);
    let sold_in_period = if period_index == state.period_index {
        amount(&state.sold_in_period)?
    } else {
        U256::zero()
    };
    let period_cap = l.per_period.min(amount(&e.max_amount_per_period)?);
    let left = period_cap.saturating_sub(sold_in_period).min(balance);
    if balance.is_zero() {
        return wait("allocation_used", None);
    }
    if left.is_zero() {
        return wait(
            "period_budget_used",
            Some(l.start_ms + (period_index + 1) * l.period_ms),
        );
    }
    let tx_cap = l.per_tx.min(amount(&e.max_amount_per_tx)?).min(left);
    let lo = (tx_cap / U256::from(2u8)).max(U256::one());
    let amount = random_between(lo, tx_cap, rng)?;
    Ok(Proposal::Sell {
        amount: amount.to_string(),
        period_index,
    })
}

/// `scheduleAfter`: the next sale time, between the plan's shortest and longest gap.
pub fn schedule_after(plan: &Plan, now: i64, rng: &mut dyn RandomBytes) -> Result<i64> {
    let l = limits(plan)?;
    let gap = random_between(
        U256::from(l.min_gap_ms as u64),
        U256::from(l.max_gap_ms as u64),
        rng,
    )?;
    Ok(now + gap.as_u64() as i64)
}

// ── Market check ───────────────────────────────────────────────────────────────────────────────

#[derive(Deserialize, Clone, Debug)]
pub struct PriceObservation {
    pub source: String,
    pub price_e6: String,
}

#[derive(Deserialize, Clone, Debug)]
pub struct QuoteView {
    pub amount_in: String,
    pub amount_out: String,
    pub min_amount_out: String,
}

/// `checkMarket`: every named source answers, they agree within tolerance of the median, the
/// lowest price and the quote's guaranteed output clear the floor, and slippage is within limit.
pub fn check_market(
    plan: &Plan,
    e: &Envelope,
    sale_amount: U256,
    prices: &[PriceObservation],
    quote: &QuoteView,
    quote_decimals: u32,
) -> Result<Value> {
    let l = limits(plan)?;
    let d = plan.token.decimals;
    let mut reasons: Vec<String> = Vec::new();
    let amount_out = amount(&quote.amount_out)?;
    let min_out = amount(&quote.min_amount_out)?;
    let quote_price = implied_price_e6(sale_amount, amount_out, d, quote_decimals);
    let mut observed: Vec<U256> = Vec::new();
    for source in &plan.price_sources {
        if source == "1click_quote" {
            observed.push(quote_price);
        } else if let Some(p) = prices.iter().find(|p| &p.source == source) {
            observed.push(amount(&p.price_e6)?);
        } else {
            reasons.push(format!("No price from {source}"));
        }
    }
    let mut sorted = observed.clone();
    sorted.sort();
    let median = if sorted.is_empty() {
        U256::zero()
    } else {
        sorted[(sorted.len() - 1) / 2]
    };
    let reference = sorted.first().copied().unwrap_or_default();
    let bps = U256::from(plan.price_agreement_bps);
    let prices_agree = !median.is_zero()
        && observed
            .iter()
            .all(|p| abs_diff(*p, median) * U256::from(10_000u32) <= median * bps);
    if !prices_agree {
        reasons.push("Price sources disagree".into());
    }
    let floor = l.floor_e6.max(amount(&e.min_price_usd_e6)?);
    let above_floor =
        reference >= floor && meets_floor(sale_amount, min_out, floor, d, quote_decimals);
    if !above_floor {
        reasons.push("Price is below the floor".into());
    }
    let lowest_allowed_out =
        amount_out * U256::from(10_000 - plan.max_slippage_bps) / U256::from(10_000u32);
    let slippage_ok = amount(&quote.amount_in)? == sale_amount
        && !min_out.is_zero()
        && min_out >= lowest_allowed_out;
    if !slippage_ok {
        reasons.push("Quote does not match the sale or allows too much slippage".into());
    }
    let within_tx_cap = sale_amount <= l.per_tx.min(amount(&e.max_amount_per_tx)?);
    Ok(json!({
        "ok": reasons.is_empty(),
        "reasons": reasons,
        "reference_price_e6": reference.to_string(),
        "compliance": {
            "within_period_budget": true,
            "within_tx_cap": within_tx_cap,
            "above_floor": above_floor,
            "venue_allowed": plan.venues.iter().any(|v| v == "1click"),
            "prices_agree": prices_agree && slippage_ok,
            "schedule_ok": true,
        },
    }))
}
