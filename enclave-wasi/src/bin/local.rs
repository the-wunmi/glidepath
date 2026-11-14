//! The OutLayer enclave's operations with keys from a local seed: the same code path as the
//! OutLayer module, for tests and dry runs. Never registered anywhere.

use glidepath_enclave_wasi::enclave::{run_stdio, Context};
use glidepath_enclave_wasi::local_keys::LocalKeys;
use glidepath_enclave_wasi::OsRandom;

fn main() {
    let seed: [u8; 32] = std::env::var("GLIDEPATH_LOCAL_ENCLAVE_SEED_HEX")
        .ok()
        .and_then(|s| hex::decode(s.trim()).ok())
        .and_then(|v| v.try_into().ok())
        .expect("GLIDEPATH_LOCAL_ENCLAVE_SEED_HEX must be 32 bytes of hex");
    let quote_signer_key = std::env::var("GLIDEPATH_QUOTE_SIGNER_KEY").unwrap_or_default();
    run_stdio(&mut Context {
        keys: &LocalKeys::from_seed(seed),
        rng: &mut OsRandom,
        quote_signer_key: &quote_signer_key,
        caller: "local".into(),
    });
}
