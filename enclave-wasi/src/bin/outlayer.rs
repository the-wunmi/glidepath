//! The enclave as an OutLayer module (wasm32-wasip2). Its keys live in OutLayer's keystore and
//! are issued only to a direct run of this exact build called by the account that registered it
//! (`bind: "wasm"`, `caller: "predecessor"`); the module names them and the host signs and seals.
//!
//! Build: `GLIDEPATH_QUOTE_SIGNER_KEY=ed25519:… cargo build --release --target wasm32-wasip2
//! --features outlayer --bin glidepath-enclave-outlayer` (scripts/outlayer-enclave.ts does this).

use glidepath_enclave_wasi::enclave::{run_stdio, Context, Keys};
use glidepath_enclave_wasi::{OsRandom, Result};

/// The keys this build asks the keystore for. The section must be in the artefact, or the worker
/// issues no keys and every call is refused.
const MANIFEST: &[u8] = br#"{"signing_keys":[{"path":"enclave","type":"ed25519","bind":"wasm","caller":"predecessor"}],"encryption_keys":[{"path":"seal","bind":"wasm","caller":"predecessor"}],"capabilities":{"network":[]}}"#;

#[used]
#[link_section = "outlayer.manifest"]
static OUTLAYER_MANIFEST: [u8; MANIFEST.len()] = {
    let mut out = [0u8; MANIFEST.len()];
    let mut i = 0;
    while i < MANIFEST.len() {
        out[i] = MANIFEST[i];
        i += 1;
    }
    out
};

/// 1Click's quote key (on testnet, the 1Click simulator's key the registry pins). Fixed at build
/// time, so the host cannot substitute quotes of its own and the key is part of the wasm hash.
const QUOTE_SIGNER_KEY: &str = env!("GLIDEPATH_QUOTE_SIGNER_KEY");

/// Which build of the same code this is: the main one, or a backup that holds its own sealed copy
/// of each plan and stands in when the main one cannot run. A different slot is a different wasm,
/// so the keystore gives it its own keys.
#[used]
#[link_section = "glidepath.build_slot"]
static BUILD_SLOT: [u8; SLOT.len()] = {
    let mut out = [0u8; SLOT.len()];
    let mut i = 0;
    while i < SLOT.len() {
        out[i] = SLOT[i];
        i += 1;
    }
    out
};
const SLOT: &[u8] = match option_env!("GLIDEPATH_BUILD_SLOT") {
    Some(s) => s.as_bytes(),
    None => b"main",
};

mod signing {
    wit_bindgen::generate!({ world: "signing-keys-host", path: "wit/signing" });
}
mod encryption {
    wit_bindgen::generate!({ world: "encryption-keys-host", path: "wit/encryption" });
}
use encryption::outlayer::encryption_keys::api as enc;
use signing::outlayer::signing_keys::api as sig;

const SIGNING_PATH: &str = "enclave";
const SEAL_PATH: &str = "seal";
/// The X25519 secret is a MAC under the seal key: deterministic for this build and caller, and
/// computable only inside the keystore.
const BOX_SECRET_LABEL: &[u8] = b"glidepath/box-secret/v1";

struct KeystoreKeys;

impl Keys for KeystoreKeys {
    fn signing_public_key(&self) -> Result<[u8; 32]> {
        sig::public_key(SIGNING_PATH, None)?
            .try_into()
            .map_err(|_| "unexpected public key length".into())
    }
    fn sign(&self, message: &[u8]) -> Result<[u8; 64]> {
        sig::sign(SIGNING_PATH, None, message)?
            .try_into()
            .map_err(|_| "unexpected signature length".into())
    }
    fn seal(&self, plaintext: &[u8], aad: &[u8]) -> Result<Vec<u8>> {
        enc::encrypt(SEAL_PATH, None, plaintext, aad)
    }
    fn open(&self, ciphertext: &[u8], aad: &[u8]) -> Result<Vec<u8>> {
        enc::decrypt(SEAL_PATH, None, ciphertext, aad)
    }
    fn box_secret(&self) -> Result<[u8; 32]> {
        enc::mac(SEAL_PATH, None, BOX_SECRET_LABEL)?
            .try_into()
            .map_err(|_| "unexpected mac length".into())
    }
}

fn main() {
    let caller = std::env::var("NEAR_PREDECESSOR_ID").unwrap_or_default();
    run_stdio(&mut Context {
        keys: &KeystoreKeys,
        rng: &mut OsRandom,
        quote_signer_key: QUOTE_SIGNER_KEY,
        caller,
    });
}
