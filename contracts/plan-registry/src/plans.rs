//! Plan lifecycle: create, enclave acknowledgement, cooling-off changes, cancel and end.

use crate::checks::{self, MAX_DECIMALS};
use crate::events;
use crate::evm;
use crate::types::*;
use crate::{
    plan_account_for, require_key_notice, PlanRegistry, PlanRegistryExt, MAX_LABEL_LEN,
    PLAN_ACCOUNT_FUNDING,
};
use near_sdk::json_types::U128;
use near_sdk::serde_json::{self, json};
use near_sdk::{bs58, env, near, require, Gas, NearToken, Promise};

/// Domain prefix of every enclave acknowledgement signature.
pub const ACK_DOMAIN: &[u8] = b"glidepath/ack/v1\n";
/// Signed messages are capped: they are stored in receipts that the relayer pays for, and a
/// plan's real content never needs more than a few hundred bytes.
pub const MAX_SIGNED_JSON_BYTES: usize = 4096;
/// Allowed difference between the enclave's clock and block time.
pub const MAX_CLOCK_SKEW_MS: u64 = 60_000;
/// The `evm_address` written later by `on_derived_key` is paid for up front by the creator.
const EVM_ADDRESS_RESERVE_BYTES: u64 = 64;
const GAS_PLAN_ACCOUNT_INIT: Gas = Gas::from_tgas(10);
const GAS_ON_PLAN_ACCOUNT_CREATED: Gas = Gas::from_tgas(10);
/// A derived-key view costs about 5 Tgas of curve arithmetic on the real signer.
const GAS_DERIVED_PUBLIC_KEY: Gas = Gas::from_tgas(20);
const GAS_ON_DERIVED_KEY: Gas = Gas::from_tgas(10);
const GAS_RELEASE: Gas = Gas::from_tgas(60);
/// A modification must be applied within 7 days of becoming effective or it lapses. Otherwise a
/// requested change would be an armed option the insider could fire much later, on news.
pub const CHANGE_APPLY_WINDOW_MS: u64 = 7 * 24 * 60 * 60 * 1000;
/// Asset ids such as "nep141:usdc.near" or "nep141:<64-char account>"; 128 covers any of them.
pub const MAX_PROCEEDS_ASSET_LEN: usize = 128;
/// A derived key response is ~100 bytes; anything far larger is not one.
const MAX_DERIVED_KEY_RESPONSE_BYTES: usize = 512;

#[near]
impl PlanRegistry {
    /// Creates a plan owned by the caller (an account or a DAO) and its keyless plan account.
    /// The deposit pays this plan's registry storage plus `PLAN_ACCOUNT_FUNDING`; the rest is
    /// refunded. Returns the plan id.
    #[payable]
    #[allow(clippy::too_many_arguments)] // flat JSON arguments are the public interface
    pub fn create_plan(
        &mut self,
        commitment: String,
        asset: Asset,
        token_decimals: u8,
        quote_decimals: u8,
        beneficiary: Beneficiary,
        envelope: Envelope,
        disclosure: Disclosure,
        cooling_off_ms: u64,
        start_ms: u64,
        end_ms: u64,
        label: String,
        proceeds_asset: String,
    ) -> u64 {
        let before = env::storage_usage();
        let now = env::block_timestamp_ms();
        let code_hash = self
            .config
            .plan_account_code_hash
            .unwrap_or_else(|| env::panic_str("code_not_ready"));
        require!(
            cooling_off_ms >= self.config.min_cooling_off_ms,
            "cooling_off_too_short"
        );
        let commitment = checks::normalize_hex32(&commitment, "invalid_commitment");
        let asset = normalize_asset(asset);
        require!(
            token_decimals <= MAX_DECIMALS && quote_decimals <= MAX_DECIMALS,
            "invalid_decimals"
        );
        let beneficiary = Beneficiary {
            evm_address: beneficiary.evm_address.as_deref().map(|a| {
                evm::normalize_address(a).unwrap_or_else(|| env::panic_str("invalid_evm_address"))
            }),
            near_account: beneficiary.near_account,
        };
        checks::validate_envelope(&envelope);
        require!(end_ms > start_ms && end_ms > now, "invalid_times");
        require!(label.chars().count() <= MAX_LABEL_LEN, "label_too_long");
        require!(
            !proceeds_asset.is_empty() && proceeds_asset.len() <= MAX_PROCEEDS_ASSET_LEN,
            "invalid_proceeds_asset"
        );
        let proceeds_decimals = *self
            .proceeds_assets
            .get(&proceeds_asset)
            .unwrap_or_else(|| env::panic_str("unknown_proceeds_asset"));
        require!(
            quote_decimals == proceeds_decimals,
            "quote_decimals_mismatch"
        );

        let id = self.next_plan_id;
        self.next_plan_id += 1;
        let plan_account = plan_account_for(id);
        let owner = env::predecessor_account_id();
        let is_evm = matches!(asset, Asset::EvmErc20 { .. });
        let token = match &asset {
            Asset::Nep141 { token_id } => Some(token_id.clone()),
            Asset::EvmErc20 { .. } => None,
        };
        events::emit(
            "plan_created",
            json!({
                "plan_id": id,
                "owner": owner,
                "plan_account": plan_account,
                "commitment": commitment,
                "asset": asset,
                "envelope": envelope,
                "disclosure": disclosure,
                "cooling_off_ms": cooling_off_ms,
                "start_ms": start_ms,
                "end_ms": end_ms,
                "proceeds_asset": proceeds_asset,
            }),
        );
        self.plans.insert(
            id,
            Plan {
                id,
                owner,
                commitment,
                asset,
                token_decimals,
                quote_decimals,
                beneficiary,
                envelope,
                disclosure,
                cooling_off_ms,
                start_ms,
                end_ms,
                status: PlanStatus::AwaitingAck,
                created_at_ms: now,
                acked_at_ms: None,
                acked_by: None,
                plan_account: plan_account.clone(),
                evm_address: None,
                evm_nonce: 0,
                evm_sign_pending: false,
                next_seq: 0,
                period_index: 0,
                sold_in_period: U128(0),
                sold_total: U128(0),
                last_sale_ms: None,
                pending_change: None,
                receipt_count: 0,
                label,
                proceeds_asset,
                evm_pending_sign: None,
            },
        );
        let reserve = if is_evm { EVM_ADDRESS_RESERVE_BYTES } else { 0 };
        self.charge_storage(before, reserve, PLAN_ACCOUNT_FUNDING);

        // No add_key action: the account is created keyless and only its code can act for it.
        Promise::new(plan_account)
            .create_account()
            .transfer(PLAN_ACCOUNT_FUNDING)
            .use_global_contract(code_hash)
            .function_call(
                "new".to_string(),
                json_bytes(&json!({ "registry": env::current_account_id(), "token": token })),
                NearToken::from_yoctonear(0),
                GAS_PLAN_ACCOUNT_INIT,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_ON_PLAN_ACCOUNT_CREATED)
                    .on_plan_account_created(id),
            )
            .detach();
        if is_evm {
            self.derive_evm_address(id).detach();
        }
        id
    }

    /// If the plan account could not be created, the plan can never hold tokens: end it and give
    /// the owner the funding back (the failed transfer was refunded to the registry).
    #[private]
    pub fn on_plan_account_created(&mut self, plan_id: u64) -> bool {
        if env::promise_result_checked(0, 0).is_ok() {
            return true;
        }
        let plan = self.plan_mut(plan_id);
        plan.status = PlanStatus::Ended;
        let owner = plan.owner.clone();
        Promise::new(owner).transfer(PLAN_ACCOUNT_FUNDING).detach();
        events::emit(
            "plan_ended",
            json!({ "plan_id": plan_id, "reason": "plan_account_failed" }),
        );
        false
    }

    /// Reads the raw result so a malformed response is a logged failure, never a panic.
    #[private]
    pub fn on_derived_key(&mut self, plan_id: u64) -> Option<String> {
        let xy = env::promise_result_checked(0, MAX_DERIVED_KEY_RESPONSE_BYTES)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<String>(&bytes).ok())
            .and_then(|value| {
                let encoded = value.strip_prefix("secp256k1:")?.to_string();
                let bytes = bs58::decode(encoded).into_vec().ok()?;
                (bytes.len() == 64).then_some(bytes)
            });
        let Some(xy) = xy else {
            // Left unset; anyone can retry with `refresh_evm_address`.
            events::emit("evm_address_failed", json!({ "plan_id": plan_id }));
            return None;
        };
        let address = evm::address_from_xy(&xy);
        let plan = self.plans.get_mut(&plan_id)?;
        plan.evm_address = Some(address.clone());
        events::emit(
            "evm_address_derived",
            json!({ "plan_id": plan_id, "evm_address": address }),
        );
        Some(address)
    }

    /// Anyone. Retries the derived-address lookup if the first one failed.
    pub fn refresh_evm_address(&mut self, plan_id: u64) -> Promise {
        let plan = self.plan(plan_id);
        require!(matches!(plan.asset, Asset::EvmErc20 { .. }), "wrong_asset");
        require!(plan.evm_address.is_none(), "evm_address_set");
        self.derive_evm_address(plan_id)
    }

    /// Anyone can relay. Activates a plan, or applies a modification whose cooling-off has passed,
    /// once a registered enclave signs that the sealed plan matches the commitment and envelope.
    /// `signature` is standard base64 of the 64-byte ed25519 signature over
    /// `"glidepath/ack/v1\n" || ack_json`.
    #[payable]
    pub fn ack_plan(
        &mut self,
        plan_id: u64,
        ack_json: String,
        signature: String,
        enclave_key: String,
    ) {
        require!(!self.config.paused, "paused");
        let (key, key_registered_at) = self.active_enclave_key(&enclave_key);
        require!(ack_json.len() <= MAX_SIGNED_JSON_BYTES, "bad_request");
        checks::verify_signature(&key, ACK_DOMAIN, &ack_json, &signature, "bad_signature");
        let ack: AckMessage =
            serde_json::from_str(&ack_json).unwrap_or_else(|_| env::panic_str("bad_request"));
        require!(ack.kind == "ack", "bad_request");
        require!(ack.plan_id == plan_id, "plan_mismatch");
        require!(ack.within_envelope, "not_compliant");
        let before = env::storage_usage();
        let now = env::block_timestamp_ms();
        require!(
            ack.issued_at_ms <= now.saturating_add(MAX_CLOCK_SKEW_MS),
            "stale_ack"
        );
        let commitment = ack.commitment.to_ascii_lowercase();
        let plan = self.plan_mut(plan_id);
        require_key_notice(key_registered_at, plan, now);
        match plan.status {
            PlanStatus::AwaitingAck => {
                require!(
                    ack.issued_at_ms.saturating_add(MAX_CLOCK_SKEW_MS) >= plan.created_at_ms,
                    "stale_ack"
                );
                require!(commitment == plan.commitment, "commitment_mismatch");
                require!(ack.envelope == plan.envelope, "envelope_mismatch");
                if matches!(plan.asset, Asset::EvmErc20 { .. }) {
                    require!(plan.evm_address.is_some(), "evm_address_missing");
                }
                plan.status = PlanStatus::Active;
                plan.acked_at_ms = Some(now);
                plan.acked_by = Some(enclave_key.clone());
                events::emit(
                    "plan_acked",
                    json!({ "plan_id": plan_id, "commitment": commitment, "enclave_key": enclave_key }),
                );
            }
            PlanStatus::Active => {
                let Some(change) = plan.pending_change.clone() else {
                    env::panic_str("already_acked")
                };
                require!(change.kind == ChangeKind::Modify, "already_acked");
                require!(change.effective_at_ms <= now, "cooling_off");
                require!(
                    now <= change
                        .effective_at_ms
                        .saturating_add(CHANGE_APPLY_WINDOW_MS),
                    "change_expired"
                );
                // The enclave must sign after the cooling-off ended, so an ack prepared early
                // cannot be held back and relayed the moment the change becomes effective.
                require!(ack.issued_at_ms >= change.effective_at_ms, "cooling_off");
                require!(
                    change.commitment.as_deref() == Some(commitment.as_str()),
                    "commitment_mismatch"
                );
                require!(
                    change.envelope.as_ref() == Some(&ack.envelope),
                    "envelope_mismatch"
                );
                plan.commitment = commitment.clone();
                plan.envelope = ack.envelope;
                plan.pending_change = None;
                plan.acked_at_ms = Some(now);
                plan.acked_by = Some(enclave_key.clone());
                events::emit(
                    "change_applied",
                    json!({ "plan_id": plan_id, "commitment": commitment, "enclave_key": enclave_key }),
                );
            }
            PlanStatus::Ended => env::panic_str("not_active"),
        }
        self.charge_storage(before, 0, NearToken::from_yoctonear(0));
    }

    /// Owner-only. The new commitment becomes usable only after the plan's cooling-off and an
    /// enclave acknowledgement; the current plan keeps executing meanwhile.
    #[payable]
    pub fn request_change(&mut self, plan_id: u64, commitment: String, envelope: Envelope) {
        let before = env::storage_usage();
        let commitment = checks::normalize_hex32(&commitment, "invalid_commitment");
        checks::validate_envelope(&envelope);
        let now = env::block_timestamp_ms();
        let plan = self.owned_plan_mut(plan_id);
        require!(plan.status == PlanStatus::Active, "not_active");
        require!(plan.pending_change.is_none(), "change_pending");
        let effective_at_ms = now.saturating_add(plan.cooling_off_ms);
        events::emit(
            "change_requested",
            json!({
                "plan_id": plan_id,
                "commitment": commitment,
                "envelope": envelope,
                "effective_at_ms": effective_at_ms,
            }),
        );
        plan.pending_change = Some(PendingChange {
            kind: ChangeKind::Modify,
            commitment: Some(commitment),
            envelope: Some(envelope),
            requested_at_ms: now,
            effective_at_ms,
        });
        self.charge_storage(before, 0, NearToken::from_yoctonear(0));
    }

    /// Owner-only. After the cooling-off anyone can `finalize`, which releases to the beneficiary.
    #[payable]
    pub fn request_cancel(&mut self, plan_id: u64) {
        let before = env::storage_usage();
        let now = env::block_timestamp_ms();
        let plan = self.owned_plan_mut(plan_id);
        require!(plan.status != PlanStatus::Ended, "not_active");
        require!(plan.pending_change.is_none(), "change_pending");
        let effective_at_ms = now.saturating_add(plan.cooling_off_ms);
        events::emit(
            "cancel_requested",
            json!({ "plan_id": plan_id, "effective_at_ms": effective_at_ms }),
        );
        plan.pending_change = Some(PendingChange {
            kind: ChangeKind::Cancel,
            commitment: None,
            envelope: None,
            requested_at_ms: now,
            effective_at_ms,
        });
        self.charge_storage(before, 0, NearToken::from_yoctonear(0));
    }

    /// Owner-only. Drops a pending modification, or a cancellation that has not yet taken effect.
    /// An effective cancel has already stopped sales; withdrawing it would let the owner resume
    /// them with no cooling-off, so from then on only `finalize` applies.
    pub fn withdraw_change(&mut self, plan_id: u64) {
        let now = env::block_timestamp_ms();
        let plan = self.owned_plan_mut(plan_id);
        require!(plan.status != PlanStatus::Ended, "not_active");
        if let Some(change) = &plan.pending_change {
            require!(
                change.kind != ChangeKind::Cancel || now < change.effective_at_ms,
                "cancel_effective"
            );
        }
        let change = plan
            .pending_change
            .take()
            .unwrap_or_else(|| env::panic_str("no_pending_change"));
        events::emit(
            "change_withdrawn",
            json!({ "plan_id": plan_id, "kind": change.kind }),
        );
    }

    /// Anyone, once the plan has ended, and only once. Publishes the sealed plan so anyone can
    /// audit it: `sha256(plan_json bytes || salt bytes)` must equal the plan's current commitment,
    /// where `salt` is the hex of the 32-byte salt. Payable for the storage it adds.
    #[payable]
    pub fn reveal_plan(&mut self, plan_id: u64, plan_json: String, salt: String) {
        let before = env::storage_usage();
        let plan = self.plan(plan_id);
        require!(plan.status == PlanStatus::Ended, "not_ended");
        require!(!self.reveals.contains_key(&plan_id), "already_revealed");
        require!(plan_json.len() <= MAX_SIGNED_JSON_BYTES, "bad_request");
        let salt = checks::normalize_hex32(&salt, "invalid_salt");
        let salt_bytes = hex::decode(&salt).unwrap_or_else(|_| env::panic_str("invalid_salt"));
        let digest = env::sha256_array([plan_json.as_bytes(), &salt_bytes].concat());
        require!(
            hex::encode(digest) == plan.commitment,
            "commitment_mismatch"
        );
        let revealed_by = env::predecessor_account_id();
        events::emit(
            "plan_revealed",
            json!({ "plan_id": plan_id, "commitment": plan.commitment, "revealed_by": revealed_by }),
        );
        self.reveals.insert(
            plan_id,
            Reveal {
                plan_json,
                salt,
                revealed_at_ms: env::block_timestamp_ms(),
                revealed_by,
            },
        );
        self.charge_storage(before, 0, NearToken::from_yoctonear(0));
    }

    /// Anyone. Clears a modification that was not applied within `CHANGE_APPLY_WINDOW_MS` of
    /// becoming effective, so the owner must request (and wait out) a fresh one.
    pub fn expire_change(&mut self, plan_id: u64) {
        let now = env::block_timestamp_ms();
        let plan = self.plan_mut(plan_id);
        let change = match &plan.pending_change {
            Some(change) if change.kind == ChangeKind::Modify => change.clone(),
            _ => env::panic_str("no_pending_change"),
        };
        require!(
            now > change
                .effective_at_ms
                .saturating_add(CHANGE_APPLY_WINDOW_MS),
            "change_not_expired"
        );
        plan.pending_change = None;
        events::emit(
            "change_expired",
            json!({ "plan_id": plan_id, "commitment": change.commitment }),
        );
    }

    /// Anyone. Ends the plan once `end_ms` has passed or a cancellation's cooling-off is over.
    /// NEP-141 plans then release the plan account's whole balance to the beneficiary; calling
    /// again on an ended NEP-141 plan retries that release (e.g. for tokens that arrived late).
    pub fn finalize(&mut self, plan_id: u64) -> Option<Promise> {
        let now = env::block_timestamp_ms();
        let plan = self.plan_mut(plan_id);
        if plan.status != PlanStatus::Ended {
            let reason = if now >= plan.end_ms {
                "end"
            } else {
                match &plan.pending_change {
                    Some(change) if change.kind == ChangeKind::Cancel => {
                        require!(change.effective_at_ms <= now, "cooling_off");
                        "cancel"
                    }
                    _ => env::panic_str("not_ended"),
                }
            };
            plan.status = PlanStatus::Ended;
            plan.pending_change = None;
            events::emit(
                "plan_ended",
                json!({ "plan_id": plan_id, "reason": reason }),
            );
        }
        let plan = self.plan(plan_id);
        match &plan.asset {
            Asset::Nep141 { token_id } => {
                events::emit(
                    "release_requested",
                    json!({
                        "plan_id": plan_id,
                        "token": token_id,
                        "receiver_id": plan.beneficiary.near_account,
                    }),
                );
                Some(Promise::new(plan.plan_account.clone()).function_call(
                    "release".to_string(),
                    json_bytes(&json!({
                        "token": token_id,
                        "receiver_id": plan.beneficiary.near_account,
                    })),
                    NearToken::from_yoctonear(0),
                    GAS_RELEASE,
                ))
            }
            // EVM balances are released with `release_evm`, one signed transfer at a time.
            Asset::EvmErc20 { .. } => None,
        }
    }
}

impl PlanRegistry {
    fn owned_plan_mut(&mut self, plan_id: u64) -> &mut Plan {
        let caller = env::predecessor_account_id();
        let plan = self.plan_mut(plan_id);
        require!(plan.owner == caller, "only_owner");
        plan
    }

    fn derive_evm_address(&self, plan_id: u64) -> Promise {
        Promise::new(self.config.signer_contract.clone())
            .function_call(
                "derived_public_key".to_string(),
                json_bytes(&json!({
                    "path": evm_path(plan_id),
                    "predecessor": env::current_account_id(),
                    "domain_id": 0,
                })),
                NearToken::from_yoctonear(0),
                GAS_DERIVED_PUBLIC_KEY,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_ON_DERIVED_KEY)
                    .on_derived_key(plan_id),
            )
    }
}

/// Chain Signatures path for a plan; the registry is the predecessor, so only it can sign for it.
pub fn evm_path(plan_id: u64) -> String {
    format!("plan/{plan_id}")
}

fn normalize_asset(asset: Asset) -> Asset {
    match asset {
        Asset::Nep141 { token_id } => Asset::Nep141 { token_id },
        Asset::EvmErc20 {
            chain_id,
            token_address,
        } => {
            require!(chain_id > 0, "bad_request");
            Asset::EvmErc20 {
                chain_id,
                token_address: evm::normalize_address(&token_address)
                    .unwrap_or_else(|| env::panic_str("invalid_evm_address")),
            }
        }
    }
}

pub fn json_bytes(value: &serde_json::Value) -> Vec<u8> {
    serde_json::to_vec(value).unwrap_or_else(|_| env::panic_str("bad_request"))
}
