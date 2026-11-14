//! 1Click's own quote-signature format, verified against a live non-dry quote on 2026-11-11.
//! 1Click signs the UTF-8 text of base58(sha256(Q)), where Q is the stable-stringified quote
//! (keys sorted, no spaces). The relayer hands us Q as a string, so the registry never rebuilds
//! it: it hashes exactly the bytes it binds the sale to.

use near_sdk::json_types::U128;
use near_sdk::serde::Deserialize;
use near_sdk::{bs58, env};

/// base58 of 64 bytes is at most 88 characters; checked before decoding because base58
/// decoding is quadratic in the input length.
const MAX_SIGNATURE_BASE58_LEN: usize = 88;
/// USD amounts are compared in units of 1e-12 USD, the precision 1Click prints them with.
const USD_E12_DIGITS: usize = 12;
/// ISO-8601 timestamps 1Click returns are 24 characters; this leaves room for longer fractions.
const MAX_TIMESTAMP_LEN: usize = 40;

/// The fields of a 1Click quote the registry binds a sale to. Unknown fields are ignored, so
/// 1Click can add information without breaking execution; a missing field is a malformed quote.
#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde", rename_all = "camelCase")]
pub struct OneClickQuote {
    pub dry: bool,
    pub swap_type: String,
    pub origin_asset: String,
    pub destination_asset: String,
    pub amount: U128,
    pub amount_in: U128,
    pub amount_in_usd: String,
    pub amount_out_usd: String,
    pub min_amount_out: U128,
    pub refund_to: String,
    pub recipient: String,
    pub deposit_address: String,
    pub deadline: String,
}

/// Where a quote takes the deposit, sends the refund and pays out. Read separately from
/// `OneClickQuote` so each contract states whether it checks it (`routes_on_chain`).
#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde", rename_all = "camelCase")]
struct QuoteRouting {
    deposit_type: Option<String>,
    refund_type: Option<String>,
    recipient_type: Option<String>,
}

/// Whether quote `q` takes the deposit on the origin chain, refunds there and pays out on the
/// destination chain, so the refund and the proceeds land in the named accounts themselves. With
/// `INTENTS` types they would land as balances inside intents.near, which a keyless account that
/// only sends `ft_transfer` can never withdraw. A missing field is not on-chain routing.
pub fn routes_on_chain(q: &str) -> bool {
    near_sdk::serde_json::from_str::<QuoteRouting>(q).is_ok_and(|r| {
        r.deposit_type.as_deref() == Some("ORIGIN_CHAIN")
            && r.refund_type.as_deref() == Some("ORIGIN_CHAIN")
            && r.recipient_type.as_deref() == Some("DESTINATION_CHAIN")
    })
}

/// `"ed25519:<base58 of 64 bytes>"` → raw signature, or `None` if it is anything else.
pub fn parse_signature(value: &str) -> Option<[u8; 64]> {
    let encoded = value.strip_prefix("ed25519:")?;
    if encoded.len() > MAX_SIGNATURE_BASE58_LEN {
        return None;
    }
    bs58::decode(encoded).into_vec().ok()?.try_into().ok()
}

/// The bytes 1Click signs for quote `q`: the ASCII text of base58(sha256(q)).
pub fn signed_message(q: &str) -> String {
    bs58::encode(env::sha256_array(q.as_bytes())).into_string()
}

/// Whether `signature` (1Click's `"ed25519:<base58>"` form) is `key`'s signature over quote `q`.
pub fn verify_signature(key: &[u8; 32], q: &str, signature: &str) -> bool {
    parse_signature(signature)
        .is_some_and(|sig| env::ed25519_verify(&sig, signed_message(q).as_bytes(), key))
}

/// A quote may cost (USD in minus USD out) at most 50 bps of the input value plus a flat $1.00.
/// 1Click's own fee is 20 bps without a partner key (seen live) and about 1 bp with one, plus a
/// withdrawal fee that is close to flat; the live fixture cost 30 bps in all. `appFees` in the
/// echoed request is not covered by the signature, but any third-party fee lowers `amountOut` and
/// `amountOutUsd`, which are, so this bound caps it. The sealed and public floors on
/// `minAmountOut` still apply on top.
pub const QUOTE_COST_MAX_BPS: u128 = 50;
/// The flat part of the bound, $1.00 in 1e-12 USD, so small sales can still pay a withdrawal fee.
pub const QUOTE_COST_FLAT_USD_E12: u128 = 1_000_000_000_000;
const BPS: u128 = 10_000;

/// `cost × 10_000 ≤ in × 50 + $1 × 10_000`, with cost = in − out (0 when out exceeds in).
/// `None` if the arithmetic overflows, which no real quote does.
pub fn cost_within_bound(amount_in_usd_e12: u128, amount_out_usd_e12: u128) -> Option<bool> {
    let cost = amount_in_usd_e12.saturating_sub(amount_out_usd_e12);
    let allowed = amount_in_usd_e12
        .checked_mul(QUOTE_COST_MAX_BPS)?
        .checked_add(QUOTE_COST_FLAT_USD_E12.checked_mul(BPS)?)?;
    Some(cost.checked_mul(BPS)? <= allowed)
}

/// A non-negative decimal string such as `"3.650000000000"` → units of 1e-12 USD. Digits beyond
/// the twelfth decimal are truncated (rounding toward zero). `None` if malformed or too large.
pub fn parse_usd_e12(value: &str) -> Option<u128> {
    let (whole, fraction) = match value.split_once('.') {
        Some((whole, fraction)) => (whole, Some(fraction)),
        None => (value, None),
    };
    let all_digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    if !all_digits(whole) || fraction.is_some_and(|f| !all_digits(f)) {
        return None;
    }
    let mut units: u128 = 0;
    for digit in whole.bytes() {
        units = units
            .checked_mul(10)?
            .checked_add(u128::from(digit - b'0'))?;
    }
    let fraction = fraction.unwrap_or("").as_bytes();
    for i in 0..USD_E12_DIGITS {
        let digit = fraction.get(i).map_or(0, |b| b - b'0');
        units = units.checked_mul(10)?.checked_add(u128::from(digit))?;
    }
    Some(units)
}

/// `YYYY-MM-DDTHH:MM:SS(.f+)?Z` (UTC, as 1Click writes deadlines) → Unix milliseconds. Fraction
/// digits beyond milliseconds are truncated. `None` for anything else, including leap seconds
/// and dates before 1970.
pub fn parse_timestamp_ms(value: &str) -> Option<u64> {
    let bytes = value.as_bytes();
    if bytes.len() < 20 || bytes.len() > MAX_TIMESTAMP_LEN || bytes.last() != Some(&b'Z') {
        return None;
    }
    let number = |range: std::ops::Range<usize>| -> Option<u64> {
        let digits = bytes.get(range)?;
        digits.iter().try_fold(0u64, |acc, b| {
            b.is_ascii_digit().then(|| acc * 10 + u64::from(b - b'0'))
        })
    };
    let separators = [(4, b'-'), (7, b'-'), (10, b'T'), (13, b':'), (16, b':')];
    if separators.iter().any(|&(i, c)| bytes[i] != c) {
        return None;
    }
    let (year, month, day) = (number(0..4)?, number(5..7)?, number(8..10)?);
    let (hour, minute, second) = (number(11..13)?, number(14..16)?, number(17..19)?);
    let millis = match &bytes[19..bytes.len() - 1] {
        [] => 0,
        [b'.', fraction @ ..] if !fraction.is_empty() => {
            if !fraction.iter().all(u8::is_ascii_digit) {
                return None;
            }
            (0..3).fold(0u64, |acc, i| {
                acc * 10 + fraction.get(i).map_or(0, |b| u64::from(b - b'0'))
            })
        }
        _ => return None,
    };
    if year < 1970
        || !(1..=12).contains(&month)
        || day == 0
        || day > days_in_month(year, month)
        || hour > 23
        || minute > 59
        || second > 59
    {
        return None;
    }
    let days = days_since_epoch(year, month, day);
    Some(((days * 24 + hour) * 60 + minute) * 60_000 + second * 1_000 + millis)
}

fn is_leap_year(year: u64) -> bool {
    year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400))
}

fn days_in_month(year: u64, month: u64) -> u64 {
    match month {
        2 if is_leap_year(year) => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

/// Days from 1970-01-01 to the given date (year ≥ 1970, date already validated).
fn days_since_epoch(year: u64, month: u64, day: u64) -> u64 {
    let leap_days = |y: u64| y / 4 - y / 100 + y / 400;
    let whole_years = (year - 1970) * 365 + leap_days(year - 1) - leap_days(1969);
    let whole_months: u64 = (1..month).map(|m| days_in_month(year, m)).sum();
    whole_years + whole_months + day - 1
}

/// Inverse of `parse_timestamp_ms` with exactly three fraction digits, as 1Click writes them.
#[cfg(test)]
pub fn format_timestamp_ms(ms: u64) -> String {
    let mut days = ms / 86_400_000;
    let mut year = 1970;
    while days >= if is_leap_year(year) { 366 } else { 365 } {
        days -= if is_leap_year(year) { 366 } else { 365 };
        year += 1;
    }
    let mut month = 1;
    while days >= days_in_month(year, month) {
        days -= days_in_month(year, month);
        month += 1;
    }
    let in_day = ms % 86_400_000;
    format!(
        "{year:04}-{month:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        days + 1,
        in_day / 3_600_000,
        in_day / 60_000 % 60,
        in_day / 1_000 % 60,
        in_day % 1_000
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timestamps_parse_to_unix_milliseconds() {
        assert_eq!(parse_timestamp_ms("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_timestamp_ms("1970-01-01T00:00:00.000Z"), Some(0));
        // The live quote's deadline and the simulator vectors' deadline.
        assert_eq!(
            parse_timestamp_ms("2026-11-14T12:40:03.000Z"),
            Some(1_794_660_003_000)
        );
        assert_eq!(
            parse_timestamp_ms("2026-09-21T13:56:40.000Z"),
            Some(1_789_999_000_000)
        );
        assert_eq!(
            parse_timestamp_ms("2000-01-01T00:00:00Z"),
            Some(946_684_800_000)
        );
    }

    #[test]
    fn fraction_digits_are_truncated_to_milliseconds() {
        let base = 1_789_999_000_000;
        assert_eq!(
            parse_timestamp_ms("2026-09-21T13:56:40.5Z"),
            Some(base + 500)
        );
        assert_eq!(
            parse_timestamp_ms("2026-09-21T13:56:40.12Z"),
            Some(base + 120)
        );
        assert_eq!(
            parse_timestamp_ms("2026-09-21T13:56:40.123999999Z"),
            Some(base + 123)
        );
    }

    #[test]
    fn leap_days_exist_only_in_leap_years() {
        assert_eq!(
            parse_timestamp_ms("2024-02-29T00:00:00Z"),
            Some(1_709_164_800_000)
        );
        assert_eq!(
            parse_timestamp_ms("2000-02-29T00:00:00Z"),
            Some(951_782_400_000)
        );
        assert_eq!(parse_timestamp_ms("2026-02-29T00:00:00Z"), None);
        assert_eq!(parse_timestamp_ms("2100-02-29T00:00:00Z"), None);
        assert_eq!(
            parse_timestamp_ms("2024-03-01T00:00:00Z"),
            Some(1_709_251_200_000)
        );
        assert_eq!(
            parse_timestamp_ms("2024-12-31T23:59:59.999Z"),
            Some(1_735_689_599_999)
        );
    }

    #[test]
    fn malformed_timestamps_are_refused() {
        for bad in [
            "",
            "2026-09-21",
            "2026-09-21T13:56:40",
            "2026-09-21T13:56:40.000",
            "2026-09-21T13:56:40+00:00",
            "2026-09-21 13:56:40Z",
            "2026-9-21T13:56:40.000Z",
            "2026-09-21T13:56:40.Z",
            "2026-09-21T13:56:40.0a0Z",
            "2026-13-01T00:00:00Z",
            "2026-00-01T00:00:00Z",
            "2026-04-31T00:00:00Z",
            "2026-09-00T00:00:00Z",
            "2026-09-21T24:00:00Z",
            "2026-09-21T23:60:00Z",
            "2026-12-31T23:59:60Z",
            "1969-12-31T23:59:59Z",
            "+026-09-21T13:56:40Z",
            "2026-09-21T13:56:40.0000000000000000000000Z",
            "2026-09-21T13:56:40Zjunk",
            "２026-09-21T13:56:40Z",
        ] {
            assert_eq!(parse_timestamp_ms(bad), None, "{bad}");
        }
    }

    #[test]
    fn formatting_round_trips_through_the_parser() {
        for ms in [
            0,
            951_782_400_000,
            1_709_164_800_000,
            1_735_689_599_999,
            1_789_999_000_000,
            1_794_660_003_000,
            4_107_542_399_123,
        ] {
            assert_eq!(parse_timestamp_ms(&format_timestamp_ms(ms)), Some(ms));
        }
        assert_eq!(
            format_timestamp_ms(1_789_999_000_000),
            "2026-09-21T13:56:40.000Z"
        );
    }

    #[test]
    fn usd_amounts_parse_to_twelve_decimals_truncating_the_rest() {
        assert_eq!(parse_usd_e12("3.650000000000"), Some(3_650_000_000_000));
        assert_eq!(parse_usd_e12("3.638911821048"), Some(3_638_911_821_048));
        assert_eq!(parse_usd_e12("15"), Some(15_000_000_000_000));
        assert_eq!(parse_usd_e12("0.1"), Some(100_000_000_000));
        assert_eq!(parse_usd_e12("0.0000000000019"), Some(1));
        for bad in [
            "", ".5", "5.", "-1.0", "+1", "1e3", "1.2.3", " 1", "1,5", "NaN",
        ] {
            assert_eq!(parse_usd_e12(bad), None, "{bad}");
        }
        assert_eq!(parse_usd_e12(&"9".repeat(40)), None, "overflow is refused");
    }

    #[test]
    fn the_cost_bound_allows_fifty_bps_plus_one_dollar() {
        let dollar = QUOTE_COST_FLAT_USD_E12;
        // $10,000 in: at most $50 + $1 may go to fees.
        assert_eq!(
            cost_within_bound(10_000 * dollar, 9_949 * dollar),
            Some(true)
        );
        assert_eq!(
            cost_within_bound(10_000 * dollar, 9_949 * dollar - 1),
            Some(false)
        );
        // Small sales may pay the flat dollar.
        assert_eq!(cost_within_bound(2 * dollar, dollar), Some(true));
        // Receiving more than was sent costs nothing.
        assert_eq!(cost_within_bound(dollar, 2 * dollar), Some(true));
        assert_eq!(cost_within_bound(u128::MAX, 0), None);
    }

    #[test]
    fn only_on_chain_deposit_refund_and_payout_count_as_on_chain_routing() {
        let on_chain = r#"{"depositType":"ORIGIN_CHAIN","recipientType":"DESTINATION_CHAIN","refundType":"ORIGIN_CHAIN"}"#;
        assert!(routes_on_chain(on_chain));
        for (field, value) in [
            ("depositType", "INTENTS"),
            ("recipientType", "INTENTS"),
            ("refundType", "INTENTS"),
        ] {
            let q = on_chain.replace(
                &format!(
                    r#""{field}":"{}""#,
                    if field == "recipientType" {
                        "DESTINATION_CHAIN"
                    } else {
                        "ORIGIN_CHAIN"
                    }
                ),
                &format!(r#""{field}":"{value}""#),
            );
            assert!(!routes_on_chain(&q), "{field}={value}");
        }
        assert!(
            !routes_on_chain(r#"{"depositType":"ORIGIN_CHAIN"}"#),
            "missing fields"
        );
    }

    #[test]
    fn signatures_must_be_prefixed_base58_of_sixty_four_bytes() {
        let sig = [7u8; 64];
        let encoded = bs58::encode(sig).into_string();
        assert_eq!(parse_signature(&format!("ed25519:{encoded}")), Some(sig));
        assert_eq!(parse_signature(&encoded), None, "prefix required");
        assert_eq!(parse_signature("secp256k1:abc"), None);
        assert_eq!(parse_signature("ed25519:0OIl"), None, "not base58");
        let short = bs58::encode([7u8; 63]).into_string();
        assert_eq!(parse_signature(&format!("ed25519:{short}")), None);
        let long = bs58::encode([7u8; 65]).into_string();
        assert_eq!(parse_signature(&format!("ed25519:{long}")), None);
        let padded = format!("ed25519:{}", "1".repeat(200));
        assert_eq!(
            parse_signature(&padded),
            None,
            "length capped before decoding"
        );
    }
}
