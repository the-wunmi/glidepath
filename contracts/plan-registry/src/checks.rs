//! Pure checks on plan inputs and sales. They return values or panic with the documented error code.

use crate::types::{Envelope, Plan};
use near_sdk::base64::engine::general_purpose::STANDARD as BASE64;
use near_sdk::base64::Engine;
use near_sdk::{bs58, env, require};

pub use wide::U256;

/// Macro-generated code; clippy's style lints on it are not ours to fix.
#[allow(clippy::all)]
mod wide {
    uint::construct_uint! {
        /// Floor products (amount × price × 10^decimals) can exceed u128.
        pub struct U256(4);
    }
}

/// Decimals above 24 (NEAR's own) are unheard of and would only invite overflow.
pub const MAX_DECIMALS: u8 = 24;

/// Lowercase 64-hex-digit string, e.g. a sha256 commitment.
pub fn normalize_hex32(value: &str, error: &str) -> String {
    require!(
        value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit()),
        error
    );
    value.to_ascii_lowercase()
}

/// Hex string of bounded length (TDX measurements are 48 bytes = 96 digits).
pub fn require_hex(value: &str, max_len: usize, error: &str) {
    require!(
        !value.is_empty()
            && value.len() <= max_len
            && value.len().is_multiple_of(2)
            && value.bytes().all(|b| b.is_ascii_hexdigit()),
        error
    );
}

pub fn validate_envelope(envelope: &Envelope) {
    require!(
        envelope.period_ms > 0
            && envelope.max_amount_per_period.0 > 0
            && envelope.max_amount_per_tx.0 > 0
            && envelope.max_amount_per_tx.0 <= envelope.max_amount_per_period.0,
        "invalid_envelope"
    );
}

/// "ed25519:<base58 of 32 bytes>" → raw key.
pub fn parse_ed25519_key(value: &str) -> [u8; 32] {
    value
        .strip_prefix("ed25519:")
        .and_then(|encoded| bs58::decode(encoded).into_vec().ok())
        .and_then(|bytes| bytes.try_into().ok())
        .unwrap_or_else(|| env::panic_str("invalid_public_key"))
}

/// Standard base64 (with padding) of a 64-byte ed25519 signature.
pub fn parse_signature(value: &str, error: &str) -> [u8; 64] {
    BASE64
        .decode(value)
        .ok()
        .and_then(|bytes| bytes.try_into().ok())
        .unwrap_or_else(|| env::panic_str(error))
}

/// Verifies `signature` over `domain || message`, panicking with `error` if it does not hold. The
/// domain prefix stops a signature for one message type being replayed as another.
pub fn verify_signature(
    key: &[u8; 32],
    domain: &[u8],
    message: &str,
    signature: &str,
    error: &str,
) {
    let signature = parse_signature(signature, error);
    let mut signed = Vec::with_capacity(domain.len() + message.len());
    signed.extend_from_slice(domain);
    signed.extend_from_slice(message.as_bytes());
    require!(env::ed25519_verify(&signature, &signed, key), error);
}

fn pow10(exponent: u8) -> U256 {
    U256::from(10u8).pow(U256::from(exponent))
}

fn checked_product(factors: &[U256]) -> U256 {
    factors
        .iter()
        .try_fold(U256::one(), |acc, f| acc.checked_mul(*f))
        .unwrap_or_else(|| env::panic_str("amount_overflow"))
}

/// The sale must return at least `amount × min_price` in quote units:
/// min_out × 10^token_decimals × 10^6 ≥ amount × min_price_usd_e6 × 10^quote_decimals.
/// Cross-multiplying avoids any division, so there is no rounding to pick.
pub fn meets_floor(plan: &Plan, amount: u128, min_amount_out: u128) -> bool {
    let proceeds = checked_product(&[
        U256::from(min_amount_out),
        pow10(plan.token_decimals),
        U256::from(1_000_000u32),
    ]);
    let floor = checked_product(&[
        U256::from(amount),
        U256::from(plan.envelope.min_price_usd_e6.0),
        pow10(plan.quote_decimals),
    ]);
    proceeds >= floor
}

pub fn checked_add(a: u128, b: u128) -> u128 {
    a.checked_add(b)
        .unwrap_or_else(|| env::panic_str("amount_overflow"))
}
