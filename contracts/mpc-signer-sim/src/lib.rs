//! Simulator of the Chain Signatures signer contract (`v1.signer`). It keeps the real interface,
//! key derivation and yield/resume flow; the MPC network is replaced by one `responder` account
//! that holds the root secret off-chain. Only domain 0 (secp256k1) is supported.

use k256::elliptic_curve::ops::Reduce;
use k256::elliptic_curve::point::AffineCoordinates;
use k256::elliptic_curve::scalar::IsHigh;
use k256::elliptic_curve::sec1::{FromEncodedPoint, ToEncodedPoint};
use k256::elliptic_curve::PrimeField;
use k256::{AffinePoint, EncodedPoint, ProjectivePoint, Scalar, U256};
use near_sdk::serde_json;
use near_sdk::store::IterableMap;
use near_sdk::{
    bs58, env, near, require, AccountId, Gas, GasWeight, NearToken, PanicOnDefault, PromiseError,
    PromiseOrValue,
};
use sha3::{Digest, Sha3_256};

/// Exact prefix from near/mpc `kdf.rs`; any difference changes every derived address.
const TWEAK_DERIVATION_PREFIX: &str = "near-mpc-recovery v0.1.0 epsilon derivation:";
/// Live `v1.signer` config: `sign_call_gas_attachment_requirement_tera_gas: 15`.
const MIN_SIGN_GAS: Gas = Gas::from_tgas(15);
/// Live `v1.signer` charges at least 1 yoctoNEAR per request.
const SIGN_DEPOSIT: NearToken = NearToken::from_yoctonear(1);
/// Live config `return_signature_and_clean_state_on_success_call_tera_gas: 7`, plus headroom.
const GAS_RETURN_SIGNATURE: Gas = Gas::from_tgas(10);
/// Live config `fail_on_timeout_tera_gas: 2`.
const GAS_FAIL_ON_TIMEOUT: Gas = Gas::from_tgas(2);
const DATA_ID_REGISTER: u64 = 0;
const SECP256K1_DOMAIN: u64 = 0;
/// Identical requests share one response; the cap mirrors the real contract's bounded queue.
const MAX_DUPLICATE_REQUESTS: usize = 8;
/// View pages are capped so a large pending set cannot exceed view gas.
const MAX_PAGE: u32 = 50;

#[near(serializers = [json])]
#[derive(Clone)]
pub enum Payload {
    Ecdsa(String),
    Eddsa(String),
}

/// Accepts both the current (`payload_v2`, `domain_id`) and legacy (`payload`, `key_version`) names.
#[near(serializers = [json])]
pub struct SignRequestArgs {
    pub path: String,
    #[serde(default)]
    pub payload_v2: Option<Payload>,
    #[serde(default)]
    pub payload: Option<[u8; 32]>,
    #[serde(default)]
    pub domain_id: Option<u64>,
    #[serde(default)]
    pub key_version: Option<u64>,
}

/// Identifies a pending signature exactly as the real contract does: by tweak, payload and domain.
#[near(serializers = [json, borsh])]
#[derive(Clone, PartialEq, Debug)]
pub struct SignatureRequest {
    pub tweak: String,
    pub payload: String,
    pub domain_id: u64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct K256AffinePoint {
    pub affine_point: String,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct K256Scalar {
    pub scalar: String,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct K256Signature {
    pub big_r: K256AffinePoint,
    pub s: K256Scalar,
    pub recovery_id: u8,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
#[serde(tag = "scheme")]
pub enum SignatureResponse {
    Secp256k1(K256Signature),
}

#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct PendingRequest {
    pub request: SignatureRequest,
    /// Hex of each yield's 32-byte data id; identical requests are queued here.
    pub yield_ids: Vec<String>,
    pub predecessor: AccountId,
    pub path: String,
    pub block_height: u64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct MpcSignerSim {
    /// Uncompressed root key without the 0x04 tag: x || y.
    root_public_key: Vec<u8>,
    responder: AccountId,
    pending: IterableMap<String, PendingRequest>,
}

#[near]
impl MpcSignerSim {
    #[init]
    pub fn new(root_public_key: String, responder: AccountId) -> Self {
        let point = parse_secp256k1_key(&root_public_key);
        Self {
            root_public_key: encode_xy(&point),
            responder,
            pending: IterableMap::new(b"p"),
        }
    }

    /// Starts a yield that the responder resumes with a signature, or that times out.
    #[payable]
    pub fn sign(&mut self, request: SignRequestArgs) {
        require!(
            env::attached_deposit() >= SIGN_DEPOSIT,
            "insufficient_deposit"
        );
        require!(env::prepaid_gas() >= MIN_SIGN_GAS, "insufficient_gas");
        let payload = request_payload(&request);
        let domain_id = request_domain(&request);
        let predecessor = env::predecessor_account_id();
        let tweak = derive_tweak(&predecessor, &request.path);
        let signature_request = SignatureRequest {
            tweak: hex::encode(tweak.to_bytes()),
            payload: hex::encode(payload.to_bytes()),
            domain_id,
        };
        let key = request_key(&signature_request);
        if let Some(existing) = self.pending.get(&key) {
            require!(
                existing.yield_ids.len() < MAX_DUPLICATE_REQUESTS,
                "PendingRequestQueueFull"
            );
        }
        let callback_args =
            serde_json::to_vec(&serde_json::json!({ "request": signature_request }))
                .unwrap_or_else(|_| env::panic_str("bad_request"));
        let promise = env::promise_yield_create(
            "return_signature_and_clean_state_on_success",
            callback_args,
            GAS_RETURN_SIGNATURE,
            GasWeight(0),
            DATA_ID_REGISTER,
        );
        let data_id =
            env::read_register(DATA_ID_REGISTER).unwrap_or_else(|| env::panic_str("yield_failed"));
        let yield_id = hex::encode(data_id);
        match self.pending.get_mut(&key) {
            Some(existing) => existing.yield_ids.push(yield_id),
            None => {
                self.pending.insert(
                    key,
                    PendingRequest {
                        request: signature_request,
                        yield_ids: vec![yield_id],
                        predecessor,
                        path: request.path,
                        block_height: env::block_height(),
                    },
                );
            }
        }
        let excess = env::attached_deposit().saturating_sub(SIGN_DEPOSIT);
        if !excess.is_zero() {
            near_sdk::Promise::new(env::predecessor_account_id())
                .transfer(excess)
                .detach();
        }
        env::promise_return(promise);
    }

    /// Responder-only. The signature must verify against the derived key with low s and a
    /// recovery id that matches `big_r`, so a bad responder cannot hand out unusable signatures.
    pub fn respond(&mut self, request: SignatureRequest, response: SignatureResponse) {
        require!(
            env::predecessor_account_id() == self.responder,
            "only_responder"
        );
        let key = request_key(&request);
        let pending = self
            .pending
            .remove(&key)
            .unwrap_or_else(|| env::panic_str("unknown_request"));
        let tweak = scalar_from_hex(&pending.request.tweak);
        let payload = scalar_from_hex(&pending.request.payload);
        let derived = derive_key(&self.root(), &tweak);
        let SignatureResponse::Secp256k1(signature) = &response;
        require!(
            signature_is_valid(&derived, &payload, signature),
            "bad_signature"
        );
        let bytes = serde_json::to_vec(&response).unwrap_or_else(|_| env::panic_str("bad_request"));
        for yield_id in &pending.yield_ids {
            let data_id: [u8; 32] = hex::decode(yield_id)
                .ok()
                .and_then(|v| v.try_into().ok())
                .unwrap_or_else(|| env::panic_str("unknown_request"));
            // `false` means this yield already timed out; its callback has cleaned up.
            env::promise_yield_resume(&data_id, &bytes);
        }
    }

    #[private]
    pub fn return_signature_and_clean_state_on_success(
        &mut self,
        request: SignatureRequest,
        #[callback_result] response: Result<SignatureResponse, PromiseError>,
    ) -> PromiseOrValue<SignatureResponse> {
        match response {
            Ok(response) => PromiseOrValue::Value(response),
            Err(_) => {
                // Timed out. Clean up here and fail in a separate promise, as the real contract
                // does, so the cleanup is not reverted by the failure.
                self.pending.remove(&request_key(&request));
                PromiseOrValue::Promise(
                    Self::ext(env::current_account_id())
                        .with_static_gas(GAS_FAIL_ON_TIMEOUT)
                        .fail_on_timeout(),
                )
            }
        }
    }

    #[private]
    pub fn fail_on_timeout(&self) {
        env::panic_str("Signature request has timed out.")
    }

    pub fn public_key(&self, domain_id: Option<u64>) -> String {
        require!(
            domain_id.unwrap_or(SECP256K1_DOMAIN) == SECP256K1_DOMAIN,
            "domain_not_supported"
        );
        format_secp256k1_key(&self.root())
    }

    pub fn derived_public_key(
        &self,
        path: String,
        predecessor: Option<AccountId>,
        domain_id: Option<u64>,
    ) -> String {
        require!(
            domain_id.unwrap_or(SECP256K1_DOMAIN) == SECP256K1_DOMAIN,
            "domain_not_supported"
        );
        let predecessor = predecessor.unwrap_or_else(env::predecessor_account_id);
        let tweak = derive_tweak(&predecessor, &path);
        format_secp256k1_key(&derive_key(&self.root(), &tweak))
    }

    /// Simulator-only: the off-chain responder polls this to find work.
    pub fn pending_requests(
        &self,
        from_index: Option<u32>,
        limit: Option<u32>,
    ) -> Vec<PendingRequest> {
        self.pending
            .values()
            .skip(from_index.unwrap_or(0) as usize)
            .take(limit.unwrap_or(MAX_PAGE).min(MAX_PAGE) as usize)
            .cloned()
            .collect()
    }

    pub fn experimental_signature_deposit(&self) -> near_sdk::json_types::U128 {
        near_sdk::json_types::U128(SIGN_DEPOSIT.as_yoctonear())
    }

    pub fn responder(&self) -> AccountId {
        self.responder.clone()
    }

    fn root(&self) -> AffinePoint {
        decode_xy(&self.root_public_key)
    }
}

fn request_key(request: &SignatureRequest) -> String {
    format!(
        "{}:{}:{}",
        request.tweak, request.payload, request.domain_id
    )
}

fn request_payload(request: &SignRequestArgs) -> Scalar {
    let bytes: [u8; 32] = match (&request.payload_v2, &request.payload) {
        (Some(_), Some(_)) => env::panic_str("payload and payload_v2 are mutually exclusive"),
        (Some(Payload::Ecdsa(hex_payload)), None) => hex::decode(hex_payload)
            .ok()
            .and_then(|v| v.try_into().ok())
            .unwrap_or_else(|| env::panic_str("Ecdsa payload must be 32 bytes of hex")),
        (Some(Payload::Eddsa(_)), None) => env::panic_str("domain_not_supported"),
        (None, Some(bytes)) => *bytes,
        (None, None) => env::panic_str("missing payload"),
    };
    Option::from(Scalar::from_repr(bytes.into()))
        .unwrap_or_else(|| env::panic_str("Ecdsa payload cannot be converted to Scalar"))
}

fn request_domain(request: &SignRequestArgs) -> u64 {
    let domain = match (request.domain_id, request.key_version) {
        (Some(_), Some(_)) => env::panic_str("domain_id and key_version are mutually exclusive"),
        (Some(d), None) | (None, Some(d)) => d,
        (None, None) => SECP256K1_DOMAIN,
    };
    require!(domain == SECP256K1_DOMAIN, "domain_not_supported");
    domain
}

/// tweak = SHA3-256(prefix + predecessor + "," + path), read big-endian; values >= n are rejected.
pub fn derive_tweak(predecessor: &AccountId, path: &str) -> Scalar {
    let mut hasher = Sha3_256::new();
    hasher.update(format!("{TWEAK_DERIVATION_PREFIX}{predecessor},{path}"));
    let digest: [u8; 32] = hasher.finalize().into();
    Option::from(Scalar::from_repr(digest.into()))
        .unwrap_or_else(|| env::panic_str("tweak_not_on_curve"))
}

pub fn derive_key(root: &AffinePoint, tweak: &Scalar) -> AffinePoint {
    (ProjectivePoint::GENERATOR * tweak + ProjectivePoint::from(*root)).to_affine()
}

/// ECDSA verification that also pins the nonce point: R' = (z/s)G + (r/s)Q must equal `big_r`,
/// and `recovery_id` must match R's y parity, so an EVM sender recovers to the derived address.
fn signature_is_valid(derived: &AffinePoint, payload: &Scalar, signature: &K256Signature) -> bool {
    let Some(big_r) = hex::decode(&signature.big_r.affine_point)
        .ok()
        .and_then(|bytes| EncodedPoint::from_bytes(bytes).ok())
        .filter(|point| point.is_compressed())
        .and_then(|point| Option::<AffinePoint>::from(AffinePoint::from_encoded_point(&point)))
    else {
        return false;
    };
    let Some(s) = hex::decode(&signature.s.scalar)
        .ok()
        .and_then(|v| <[u8; 32]>::try_from(v).ok())
        .and_then(|bytes| Option::<Scalar>::from(Scalar::from_repr(bytes.into())))
    else {
        return false;
    };
    if bool::from(s.is_zero()) || bool::from(s.is_high()) {
        return false;
    }
    let x = big_r.x();
    let r = <Scalar as Reduce<U256>>::reduce_bytes(&x);
    if bool::from(r.is_zero()) {
        return false;
    }
    let x_reduced = r.to_bytes() != x;
    let expected_recovery_id = u8::from(bool::from(big_r.y_is_odd())) | (u8::from(x_reduced) << 1);
    if signature.recovery_id != expected_recovery_id {
        return false;
    }
    let s_inv: Scalar = Option::from(s.invert()).unwrap_or(Scalar::ZERO);
    let recomputed = (ProjectivePoint::GENERATOR * (*payload * s_inv)
        + ProjectivePoint::from(*derived) * (r * s_inv))
        .to_affine();
    recomputed == big_r
}

fn scalar_from_hex(value: &str) -> Scalar {
    hex::decode(value)
        .ok()
        .and_then(|v| <[u8; 32]>::try_from(v).ok())
        .and_then(|bytes| Option::from(Scalar::from_repr(bytes.into())))
        .unwrap_or_else(|| env::panic_str("unknown_request"))
}

fn parse_secp256k1_key(value: &str) -> AffinePoint {
    let encoded = value
        .strip_prefix("secp256k1:")
        .unwrap_or_else(|| env::panic_str("bad_request"));
    let bytes = bs58::decode(encoded)
        .into_vec()
        .unwrap_or_else(|_| env::panic_str("bad_request"));
    require!(bytes.len() == 64, "bad_request");
    decode_xy(&bytes)
}

fn decode_xy(bytes: &[u8]) -> AffinePoint {
    let mut sec1 = Vec::with_capacity(65);
    sec1.push(0x04);
    sec1.extend_from_slice(bytes);
    EncodedPoint::from_bytes(&sec1)
        .ok()
        .and_then(|point| Option::from(AffinePoint::from_encoded_point(&point)))
        .unwrap_or_else(|| env::panic_str("bad_request"))
}

fn encode_xy(point: &AffinePoint) -> Vec<u8> {
    point.to_encoded_point(false).as_bytes()[1..].to_vec()
}

fn format_secp256k1_key(point: &AffinePoint) -> String {
    format!("secp256k1:{}", bs58::encode(encode_xy(point)).into_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const MAINNET_ROOT: &str = "secp256k1:3tFRbMqmoa6AAALMrEFAYCEoHcqKxeW38YptwowBVBtXK1vo36HDbUWuR6EZmoK4JcH6HDkNMGGqP1ouV7VZUWya";

    #[test]
    fn derivation_matches_the_live_mainnet_signer() {
        let root = parse_secp256k1_key(MAINNET_ROOT);
        let tweak = derive_tweak(&"example.near".parse().unwrap(), "ethereum-1");
        assert_eq!(
            format_secp256k1_key(&derive_key(&root, &tweak)),
            "secp256k1:5zL9u9afiFPPrPmnH7rEz2t3szev5eZ7wXCwzYq37GYyCbJq3YNU31N4LTULioaw3chJx674XUncmYKiSCd3AxxT"
        );
    }

    #[test]
    fn a_signature_from_the_derived_key_verifies_and_a_tampered_one_does_not() {
        let root_secret = Scalar::from(7u64);
        let root = (ProjectivePoint::GENERATOR * root_secret).to_affine();
        let tweak = derive_tweak(&"registry.near".parse().unwrap(), "plan/1");
        let derived_secret = root_secret + tweak;
        let derived = derive_key(&root, &tweak);
        // Deterministic nonce k = 11: R = kG, s = k^-1 (z + r d), then normalised to low s.
        let k = Scalar::from(11u64);
        let big_r = (ProjectivePoint::GENERATOR * k).to_affine();
        let z = Scalar::from(123_456u64);
        let r = <Scalar as Reduce<U256>>::reduce_bytes(&big_r.x());
        let mut s = Option::<Scalar>::from(k.invert()).unwrap() * (z + r * derived_secret);
        let mut r_point = big_r;
        if bool::from(s.is_high()) {
            s = -s;
            r_point = (-ProjectivePoint::from(big_r)).to_affine();
        }
        let signature = K256Signature {
            big_r: K256AffinePoint {
                affine_point: hex::encode(r_point.to_encoded_point(true).as_bytes()),
            },
            s: K256Scalar {
                scalar: hex::encode(s.to_bytes()),
            },
            recovery_id: u8::from(bool::from(r_point.y_is_odd())),
        };
        assert!(signature_is_valid(&derived, &z, &signature));
        let mut wrong_parity = signature.clone();
        wrong_parity.recovery_id ^= 1;
        assert!(!signature_is_valid(&derived, &z, &wrong_parity));
        assert!(!signature_is_valid(
            &derived,
            &(z + Scalar::ONE),
            &signature
        ));
    }
}
