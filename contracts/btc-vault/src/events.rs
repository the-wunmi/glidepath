//! NEP-297 events: `EVENT_JSON:{"standard":"btc_vault","version":"1.0.0","event":"<name>","data":[{...}]}`.

use near_sdk::env;
use near_sdk::serde::Serialize;
use near_sdk::serde_json::{self, Value};

const EVENT_STANDARD: &str = "btc_vault";
const EVENT_VERSION: &str = "1.0.0";

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct Nep297<'a> {
    standard: &'a str,
    version: &'a str,
    event: &'a str,
    data: [Value; 1],
}

pub fn emit(event: &str, data: Value) {
    let log = Nep297 {
        standard: EVENT_STANDARD,
        version: EVENT_VERSION,
        event,
        data: [data],
    };
    let body = serde_json::to_string(&log).unwrap_or_else(|_| env::panic_str("bad_request"));
    env::log_str(&format!("EVENT_JSON:{body}"));
}
