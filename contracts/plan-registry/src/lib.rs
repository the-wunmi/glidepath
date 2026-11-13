//! Glidepath plan registry.
//!
//! Holds sealed-plan commitments, creates one keyless plan account per plan, keeps the enclave
//! allowlist and accepts only enclave-signed sales that also fit the plan's public envelope.
//! There is deliberately no upgrade method: a keyless plan account whose controlling contract
//! could be swapped would not really be keyless. Fixing a bug means deploying a new registry.

mod checks;
mod events;
mod evm;
mod execute;
mod oneclick;
mod plans;
mod types;

#[cfg(test)]
mod flow_tests;
#[cfg(test)]
mod tests;

pub use types::*;

use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::store::{IterableMap, LookupMap, Vector};
use near_sdk::{
    bs58, env, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise,
};

/// NEAR sent to each new plan account. With the shared global code the account only stores its
/// small state; the rest pays NEP-145 registrations when tokens are released to the beneficiary.
pub const PLAN_ACCOUNT_FUNDING: NearToken = NearToken::from_millinear(100);
/// NEP-145 registration cost on wrap.near and usdt.tether-token.near (storage_balance_bounds min).
pub const STORAGE_REGISTRATION_DEPOSIT: NearToken =
    NearToken::from_yoctonear(1_250_000_000_000_000_000_000);
/// NEP-141 `ft_transfer` and the signer's `sign` both take exactly/at least one yoctoNEAR.
pub const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
/// Global contract deploys are charged 10× normal storage, burnt.
const GLOBAL_CONTRACT_STORAGE_MULTIPLIER: u128 = 10;
/// Pagination cap on every list view so a view never runs out of gas.
pub const MAX_PAGE: u32 = 50;
/// Labels are shown in UIs; 80 characters is a line, and the creator pays for it.
pub const MAX_LABEL_LEN: usize = 80;
/// Bound on one `prune_used_quotes` call, so it always fits in a transaction's gas.
pub const MAX_PRUNE: u32 = 100;

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Plans,
    Receipts,
    Enclaves,
    QuoteSigners,
    ProceedsAssets,
    UsedQuotes,
    UsedQuoteQueue,
    Reveals,
}

#[near(serializers = [borsh])]
pub struct Config {
    pub governance: AccountId,
    pub signer_contract: AccountId,
    pub min_cooling_off_ms: u64,
    pub enclave_activation_delay_ms: u64,
    /// sha256 of plan_account.wasm, set once by `setup_plan_account_code`.
    pub plan_account_code_hash: Option<[u8; 32]>,
    pub paused: bool,
    /// Key that signs 1Click quotes; every sale must carry a quote it signed.
    pub quote_signer: Option<QuoteSigner>,
}

#[near(serializers = [json])]
pub struct ConfigView {
    pub governance: AccountId,
    pub signer_contract: AccountId,
    pub min_cooling_off_ms: u64,
    pub enclave_activation_delay_ms: u64,
    /// Base58, the same encoding `view_account` uses for `global_contract_hash`.
    pub plan_account_code_hash: Option<String>,
    pub paused: bool,
    pub plan_account_funding: U128,
    pub next_plan_id: u64,
    pub quote_signer: Option<String>,
    pub quote_signer_active_from_ms: Option<u64>,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct PlanRegistry {
    config: Config,
    next_plan_id: u64,
    plans: LookupMap<u64, Plan>,
    receipts: LookupMap<(u64, u64), Receipt>,
    enclaves: IterableMap<String, Enclave>,
    /// Every quote key ever set, oldest first; the last one is current.
    quote_signers: Vector<QuoteSigner>,
    /// Allowed proceeds assets and their decimals, so `quote_decimals` (which scales the public
    /// floor) cannot be misstated for the asset the plan is paid in.
    proceeds_assets: IterableMap<String, u8>,
    /// sha256(quote payload) → deadline of every quote used and not yet pruned.
    used_quotes: LookupMap<[u8; 32], u64>,
    /// The same entries in insertion order (a queue from `used_quote_head` to `used_quote_tail`),
    /// so expired ones can be pruned from the front in bounded steps.
    used_quote_queue: LookupMap<u64, UsedQuote>,
    used_quote_head: u64,
    used_quote_tail: u64,
    reveals: LookupMap<u64, Reveal>,
}

#[near]
impl PlanRegistry {
    #[init]
    pub fn new(
        governance: AccountId,
        signer_contract: AccountId,
        min_cooling_off_ms: u64,
        enclave_activation_delay_ms: u64,
    ) -> Self {
        // A new enclave or quote key must be public for at least one cooling-off before it can
        // act, or a governance change could outrun the notice plan changes have to give.
        // Limitation: this compares with the global minimum cooling-off, not each plan's own
        // (which may be longer). Tracking the longest live cooling-off was rejected because any
        // creator could then block new keys indefinitely with a very long one; plans needing more
        // notice than the global delay must rely on watching `enclave_registered` events.
        require!(
            enclave_activation_delay_ms >= min_cooling_off_ms,
            "activation_delay_too_short"
        );
        Self {
            config: Config {
                governance,
                signer_contract,
                min_cooling_off_ms,
                enclave_activation_delay_ms,
                plan_account_code_hash: None,
                paused: false,
                quote_signer: None,
            },
            next_plan_id: 1,
            plans: LookupMap::new(StorageKey::Plans),
            receipts: LookupMap::new(StorageKey::Receipts),
            enclaves: IterableMap::new(StorageKey::Enclaves),
            quote_signers: Vector::new(StorageKey::QuoteSigners),
            proceeds_assets: IterableMap::new(StorageKey::ProceedsAssets),
            used_quotes: LookupMap::new(StorageKey::UsedQuotes),
            used_quote_queue: LookupMap::new(StorageKey::UsedQuoteQueue),
            used_quote_head: 0,
            used_quote_tail: 0,
            reveals: LookupMap::new(StorageKey::Reveals),
        }
    }

    /// Governance-only, once. Input is the raw plan_account.wasm (not JSON). Deploys it as a
    /// global contract by hash so every plan account runs byte-identical, immutable code.
    /// The attached deposit must cover the 10× storage charge, which is burnt.
    #[payable]
    pub fn setup_plan_account_code(&mut self) -> Promise {
        self.only_governance();
        require!(self.config.plan_account_code_hash.is_none(), "already_set");
        let code = env::input().unwrap_or_default();
        require!(!code.is_empty(), "bad_request");
        let cost = env::storage_byte_cost()
            .saturating_mul(code.len() as u128 * GLOBAL_CONTRACT_STORAGE_MULTIPLIER);
        require!(env::attached_deposit() >= cost, "insufficient_deposit");
        let hash = env::sha256_array(&code);
        Promise::new(env::current_account_id())
            .deploy_global_contract(code)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(Gas::from_tgas(10))
                    .on_code_deployed(
                        bs58::encode(hash).into_string(),
                        U128(env::attached_deposit().as_yoctonear()),
                    ),
            )
    }

    #[private]
    pub fn on_code_deployed(&mut self, code_hash: String, deposit: U128) {
        if env::promise_result_checked(0, 0).is_err() {
            // Nothing was burnt, so governance gets its deposit back and can retry.
            Promise::new(self.config.governance.clone())
                .transfer(NearToken::from_yoctonear(deposit.0))
                .detach();
            events::emit(
                "plan_account_code_failed",
                json!({ "code_hash": code_hash }),
            );
            return;
        }
        let hash: [u8; 32] = bs58::decode(&code_hash)
            .into_vec()
            .ok()
            .and_then(|v| v.try_into().ok())
            .unwrap_or_else(|| env::panic_str("bad_request"));
        self.config.plan_account_code_hash = Some(hash);
        events::emit("plan_account_code_set", json!({ "code_hash": code_hash }));
    }

    /// Governance-only. The key can sign only after the activation delay, so the public sees a new
    /// enclave before it can act.
    #[payable]
    pub fn register_enclave(
        &mut self,
        public_key: String,
        measurements: Measurements,
        quote_hash: String,
    ) {
        self.only_governance();
        let before = env::storage_usage();
        checks::parse_ed25519_key(&public_key);
        for value in [
            &measurements.mrtd,
            &measurements.rtmr0,
            &measurements.rtmr1,
            &measurements.rtmr2,
            &measurements.rtmr3,
        ] {
            checks::require_hex(value, 96, "invalid_measurements");
        }
        let quote_hash = checks::normalize_hex32(&quote_hash, "invalid_quote_hash");
        require!(!self.enclaves.contains_key(&public_key), "enclave_exists");
        let now = env::block_timestamp_ms();
        let active_from_ms = now.saturating_add(self.config.enclave_activation_delay_ms);
        let measurements = Measurements {
            mrtd: measurements.mrtd.to_ascii_lowercase(),
            rtmr0: measurements.rtmr0.to_ascii_lowercase(),
            rtmr1: measurements.rtmr1.to_ascii_lowercase(),
            rtmr2: measurements.rtmr2.to_ascii_lowercase(),
            rtmr3: measurements.rtmr3.to_ascii_lowercase(),
        };
        events::emit(
            "enclave_registered",
            json!({
                "public_key": public_key,
                "measurements": measurements,
                "quote_hash": quote_hash,
                "active_from_ms": active_from_ms,
            }),
        );
        self.enclaves.insert(
            public_key.clone(),
            Enclave {
                public_key,
                measurements,
                quote_hash,
                registered_at_ms: now,
                active_from_ms,
                revoked_at_ms: None,
            },
        );
        self.charge_storage(before, 0, NearToken::from_yoctonear(0));
    }

    /// Governance-only, immediate: a compromised enclave must stop at once.
    pub fn revoke_enclave(&mut self, public_key: String) {
        self.only_governance();
        let enclave = self
            .enclaves
            .get_mut(&public_key)
            .unwrap_or_else(|| env::panic_str("unknown_enclave"));
        require!(enclave.revoked_at_ms.is_none(), "enclave_revoked");
        enclave.revoked_at_ms = Some(env::block_timestamp_ms());
        events::emit("enclave_revoked", json!({ "public_key": public_key }));
    }

    /// Governance-only. Sets the 1Click quote signing key ("ed25519:<base58>"). Like an enclave it
    /// becomes usable only after the activation delay; a replaced key stops at once.
    /// The previous key is kept in `get_quote_signers` with its `replaced_at_ms`. Not payable:
    /// the ~100 bytes per rotation come from the registry's balance, and only governance can add
    /// them.
    pub fn set_quote_signer(&mut self, public_key: String) {
        self.only_governance();
        checks::parse_ed25519_key(&public_key);
        let now = env::block_timestamp_ms();
        let active_from_ms = now.saturating_add(self.config.enclave_activation_delay_ms);
        events::emit(
            "quote_signer_set",
            json!({ "public_key": public_key, "active_from_ms": active_from_ms }),
        );
        let last = self.quote_signers.len();
        if let Some(previous) = last
            .checked_sub(1)
            .and_then(|i| self.quote_signers.get_mut(i))
        {
            previous.replaced_at_ms = Some(now);
        }
        let signer = QuoteSigner {
            public_key,
            registered_at_ms: now,
            active_from_ms,
            replaced_at_ms: None,
        };
        self.quote_signers.push(signer.clone());
        self.config.quote_signer = Some(signer);
    }

    /// Governance-only, payable for its storage. Allows `asset_id` (e.g. "nep141:usdc.near") as
    /// a plan's proceeds asset with the given decimals; `create_plan` then requires
    /// `quote_decimals` to match. Re-setting changes only future plans.
    #[payable]
    pub fn set_proceeds_asset(&mut self, asset_id: String, decimals: u8) {
        self.only_governance();
        let before = env::storage_usage();
        require!(
            !asset_id.is_empty() && asset_id.len() <= plans::MAX_PROCEEDS_ASSET_LEN,
            "invalid_proceeds_asset"
        );
        require!(decimals <= checks::MAX_DECIMALS, "invalid_decimals");
        events::emit(
            "proceeds_asset_set",
            json!({ "asset_id": asset_id, "decimals": decimals }),
        );
        self.proceeds_assets.insert(asset_id, decimals);
        self.charge_storage(before, 0, NearToken::from_yoctonear(0));
    }

    pub fn get_proceeds_assets(
        &self,
        from_index: Option<u32>,
        limit: Option<u32>,
    ) -> Vec<ProceedsAssetView> {
        self.proceeds_assets
            .iter()
            .skip(from_index.unwrap_or(0) as usize)
            .take(limit.unwrap_or(MAX_PAGE).min(MAX_PAGE) as usize)
            .map(|(asset_id, decimals)| ProceedsAssetView {
                asset_id: asset_id.clone(),
                decimals: *decimals,
            })
            .collect()
    }

    pub fn get_quote_signers(
        &self,
        from_index: Option<u32>,
        limit: Option<u32>,
    ) -> Vec<QuoteSigner> {
        self.quote_signers
            .iter()
            .skip(from_index.unwrap_or(0) as usize)
            .take(limit.unwrap_or(MAX_PAGE).min(MAX_PAGE) as usize)
            .cloned()
            .collect()
    }

    /// Governance-only. Pausing stops `execute` and `ack_plan`; it never opens a way to withdraw.
    pub fn set_paused(&mut self, paused: bool) {
        self.only_governance();
        self.config.paused = paused;
        events::emit("paused", json!({ "paused": paused }));
    }

    pub fn get_config(&self) -> ConfigView {
        ConfigView {
            governance: self.config.governance.clone(),
            signer_contract: self.config.signer_contract.clone(),
            min_cooling_off_ms: self.config.min_cooling_off_ms,
            enclave_activation_delay_ms: self.config.enclave_activation_delay_ms,
            plan_account_code_hash: self
                .config
                .plan_account_code_hash
                .map(|h| bs58::encode(h).into_string()),
            paused: self.config.paused,
            plan_account_funding: U128(PLAN_ACCOUNT_FUNDING.as_yoctonear()),
            next_plan_id: self.next_plan_id,
            quote_signer: self
                .config
                .quote_signer
                .as_ref()
                .map(|q| q.public_key.clone()),
            quote_signer_active_from_ms: self
                .config
                .quote_signer
                .as_ref()
                .map(|q| q.active_from_ms),
        }
    }

    /// Anyone. Prunes up to `limit` (capped at `MAX_PRUNE`) expired used-quote entries; returns
    /// how many were removed. `execute` also prunes a few on every call.
    pub fn prune_used_quotes(&mut self, limit: Option<u32>) -> u32 {
        let now = env::block_timestamp_ms();
        self.prune_expired_quotes(limit.unwrap_or(MAX_PRUNE).min(MAX_PRUNE), now)
    }

    /// Number of used quotes still remembered (pruned entries excluded).
    pub fn used_quote_count(&self) -> u64 {
        self.used_quote_tail - self.used_quote_head
    }

    pub fn get_reveal(&self, plan_id: u64) -> Option<Reveal> {
        self.reveals.get(&plan_id).cloned()
    }

    pub fn get_plan(&self, plan_id: u64) -> Option<Plan> {
        self.plans.get(&plan_id).cloned()
    }

    pub fn list_plans(&self, from_index: Option<u64>, limit: Option<u32>) -> Vec<Plan> {
        let from = from_index.unwrap_or(1).max(1);
        let limit = u64::from(limit.unwrap_or(MAX_PAGE).min(MAX_PAGE));
        (from..self.next_plan_id)
            .take(limit as usize)
            .filter_map(|id| self.plans.get(&id).cloned())
            .collect()
    }

    pub fn get_receipts(
        &self,
        plan_id: u64,
        from_seq: Option<u64>,
        limit: Option<u32>,
    ) -> Vec<Receipt> {
        let Some(plan) = self.plans.get(&plan_id) else {
            return Vec::new();
        };
        let limit = u64::from(limit.unwrap_or(MAX_PAGE).min(MAX_PAGE));
        (from_seq.unwrap_or(0)..plan.next_seq)
            .take(limit as usize)
            .filter_map(|seq| self.receipts.get(&(plan_id, seq)).cloned())
            .collect()
    }

    pub fn get_enclaves(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<Enclave> {
        self.enclaves
            .values()
            .skip(from_index.unwrap_or(0) as usize)
            .take(limit.unwrap_or(MAX_PAGE).min(MAX_PAGE) as usize)
            .cloned()
            .collect()
    }

    pub fn plan_account_id(&self, plan_id: u64) -> AccountId {
        plan_account_for(plan_id)
    }
}

/// A key may act for a plan if it was registered before the plan was created (holders knew it),
/// or has been registered for at least the plan's own cooling-off, so a plan with a longer
/// cooling-off than the global minimum still gets its full notice of any new key.
fn require_key_notice(registered_at_ms: u64, plan: &Plan, now: u64) {
    require!(
        registered_at_ms < plan.created_at_ms
            || now >= registered_at_ms.saturating_add(plan.cooling_off_ms),
        "key_too_new_for_plan"
    );
}

impl PlanRegistry {
    fn only_governance(&self) {
        require!(
            env::predecessor_account_id() == self.config.governance,
            "only_governance"
        );
    }

    fn plan(&self, plan_id: u64) -> &Plan {
        self.plans
            .get(&plan_id)
            .unwrap_or_else(|| env::panic_str("plan_not_found"))
    }

    fn plan_mut(&mut self, plan_id: u64) -> &mut Plan {
        self.plans
            .get_mut(&plan_id)
            .unwrap_or_else(|| env::panic_str("plan_not_found"))
    }

    /// An enclave may sign only when registered, past its activation delay and not revoked.
    /// Returns the key and when it was registered (for the per-plan notice rule).
    fn active_enclave_key(&self, enclave_key: &str) -> ([u8; 32], u64) {
        let enclave = self
            .enclaves
            .get(enclave_key)
            .unwrap_or_else(|| env::panic_str("unknown_enclave"));
        require!(enclave.revoked_at_ms.is_none(), "enclave_revoked");
        require!(
            enclave.active_from_ms <= env::block_timestamp_ms(),
            "enclave_not_active"
        );
        (
            checks::parse_ed25519_key(enclave_key),
            enclave.registered_at_ms,
        )
    }

    fn active_quote_signer(&self) -> ([u8; 32], u64) {
        let signer = self
            .config
            .quote_signer
            .as_ref()
            .unwrap_or_else(|| env::panic_str("quote_signer_not_set"));
        require!(
            signer.active_from_ms <= env::block_timestamp_ms(),
            "quote_signer_not_active"
        );
        (
            checks::parse_ed25519_key(&signer.public_key),
            signer.registered_at_ms,
        )
    }

    /// Removes up to `limit` used-quote entries from the front of the queue whose deadline has
    /// passed. An expired quote is refused by its deadline anyway, so forgetting it is safe.
    fn prune_expired_quotes(&mut self, limit: u32, now: u64) -> u32 {
        let mut pruned = 0;
        while pruned < limit && self.used_quote_head < self.used_quote_tail {
            let Some(front) = self.used_quote_queue.get(&self.used_quote_head).cloned() else {
                self.used_quote_head += 1;
                continue;
            };
            if front.deadline_ms >= now {
                break;
            }
            self.used_quote_queue.remove(&self.used_quote_head);
            self.used_quotes.remove(&front.hash);
            self.used_quote_head += 1;
            pruned += 1;
        }
        pruned
    }

    fn record_used_quote(&mut self, hash: [u8; 32], deadline_ms: u64) {
        self.used_quotes.insert(hash, deadline_ms);
        self.used_quote_queue
            .insert(self.used_quote_tail, UsedQuote { hash, deadline_ms });
        self.used_quote_tail += 1;
    }

    /// Makes the caller pay for the bytes this call added (plus `reserve_bytes` that a later
    /// callback will add) and for `extra`, which this call forwards. Refunds the rest.
    fn charge_storage(&mut self, before: u64, reserve_bytes: u64, extra: NearToken) {
        self.plans.flush();
        self.receipts.flush();
        self.enclaves.flush();
        self.quote_signers.flush();
        self.proceeds_assets.flush();
        self.used_quotes.flush();
        self.used_quote_queue.flush();
        self.reveals.flush();
        let added = env::storage_usage()
            .saturating_sub(before)
            .saturating_add(reserve_bytes);
        let cost = env::storage_byte_cost()
            .saturating_mul(u128::from(added))
            .saturating_add(extra);
        let attached = env::attached_deposit();
        require!(attached >= cost, "insufficient_deposit");
        let refund = attached.saturating_sub(cost);
        if !refund.is_zero() {
            Promise::new(env::predecessor_account_id())
                .transfer(refund)
                .detach();
        }
    }
}

pub fn plan_account_for(plan_id: u64) -> AccountId {
    format!("p{plan_id}.{}", env::current_account_id())
        .parse()
        .unwrap_or_else(|_| env::panic_str("bad_request"))
}
