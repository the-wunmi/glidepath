//! Glidepath blind trust (prototype).
//!
//! An official's assets sit in a keyless trust account and are managed by a sealed mandate the
//! official cannot see once sealed. Only an allowlisted enclave can trade, one signed request at a
//! time, and every trade must also fit a public envelope checked here: never into an excluded
//! asset, proceeds and refunds only to the trust account itself, a turnover cap per period and a
//! minimum gap. The owner has no method that moves or trades assets; envelope changes and a cancel
//! wait out a public cooling-off; at the end everything goes to a beneficiary fixed at creation.
//!
//! The same mechanism as the plan registry (sealed commitment, keyless account, enclave-signed
//! requests over `DOMAIN ‖ exact JSON`, 1Click quotes in 1Click's own format, receipts). There is
//! deliberately no upgrade method. Trust accounts run the plan account's code, already published
//! as a global contract by the registry, so they are byte-identical and obey only this contract.

// Shared with the registry, file for file, so both contracts read 1Click quotes and emit events
// the same way.
#[path = "../../plan-registry/src/events.rs"]
mod events;
#[path = "../../plan-registry/src/oneclick.rs"]
// The registry's fee bound (50 bps + $1) is not used here: trusts bound fees proportionally.
#[allow(dead_code)]
mod oneclick;
mod trade;
mod types;

#[cfg(test)]
mod tests;

pub use types::*;

use near_sdk::base64::engine::general_purpose::STANDARD as BASE64;
use near_sdk::base64::Engine;
use near_sdk::json_types::U128;
use near_sdk::serde_json::{self, json};
use near_sdk::store::{IterableMap, LookupMap, Vector};
use near_sdk::{
    bs58, env, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise,
};

/// NEAR sent to each new trust account: its small state plus NEP-145 registrations when the
/// account releases tokens to the beneficiary (it pays those from its own balance).
pub const TRUST_ACCOUNT_FUNDING: NearToken = NearToken::from_millinear(100);
/// NEP-145 registration cost on common tokens (storage_balance_bounds min of wrap.near).
pub const STORAGE_REGISTRATION_DEPOSIT: NearToken =
    NearToken::from_yoctonear(1_250_000_000_000_000_000_000);
/// NEP-141 `ft_transfer` takes exactly one yoctoNEAR.
pub const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
/// Pagination cap on every list view so a view never runs out of gas.
pub const MAX_PAGE: u32 = 50;
/// Labels are shown in UIs; 80 characters is a line, and the creator pays for it.
pub const MAX_LABEL_LEN: usize = 80;
/// Every held token costs a release call at the end; a dozen covers a diversified mandate.
pub const MAX_HOLDINGS: usize = 12;
/// A public exclusion list of sectors' tokens; the owner pays its storage.
pub const MAX_EXCLUDED_ASSETS: usize = 32;
/// 1Click asset ids are `nep141:<account>`; NEAR account ids are at most 64 characters.
pub const MAX_ASSET_ID_LEN: usize = 128;
/// A term longer than ten years outlives any official's office and this prototype.
pub const MAX_TERM_MS: u64 = 10 * 365 * 86_400_000;
/// The shortest public gap between trades. A trust that may trade every block would let anyone
/// who can make it rebalance (a relayer, a market move) spend gas and fees as fast as it likes.
pub const MIN_GAP_MS: u64 = 60_000;
/// Signed messages may be issued at most this far ahead of block time.
pub const MAX_CLOCK_SKEW_MS: u64 = 60_000;
/// An ack carries the envelope (up to 32 asset ids); 8 KB is far more than it needs.
const MAX_ACK_JSON_BYTES: usize = 8192;
const GAS_ACCOUNT_INIT: Gas = Gas::from_tgas(10);
const GAS_ON_ACCOUNT_CREATED: Gas = Gas::from_tgas(10);
/// trust_account.release: ft_balance_of (5) + on_balance (25) + storage_deposit and ft_transfer.
const GAS_RELEASE: Gas = Gas::from_tgas(60);
/// Domain prefix of an enclave's trust acknowledgement.
pub const TRUST_ACK_DOMAIN: &[u8] = b"vsp/trust-ack/v1\n";

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Trusts,
    Receipts,
    Enclaves,
    QuoteSigners,
    UsedQuotes,
    UsedQuoteQueue,
}

#[near(serializers = [borsh])]
pub struct Config {
    pub governance: AccountId,
    pub min_cooling_off_ms: u64,
    pub enclave_activation_delay_ms: u64,
    /// sha256 of the plan account code, published as a global contract by the plan registry.
    pub account_code_hash: [u8; 32],
    pub paused: bool,
    pub quote_signer: Option<QuoteSigner>,
}

#[near(serializers = [json])]
pub struct ConfigView {
    pub governance: AccountId,
    pub min_cooling_off_ms: u64,
    pub enclave_activation_delay_ms: u64,
    /// Base58, the encoding `view_account` uses for `global_contract_hash`.
    pub account_code_hash: String,
    pub paused: bool,
    pub trust_account_funding: U128,
    pub next_trust_id: u64,
    pub quote_signer: Option<String>,
    pub quote_signer_active_from_ms: Option<u64>,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct BlindTrust {
    config: Config,
    next_trust_id: u64,
    trusts: LookupMap<u64, Trust>,
    receipts: LookupMap<(u64, u64), Receipt>,
    enclaves: IterableMap<String, Enclave>,
    quote_signers: Vector<QuoteSigner>,
    used_quotes: LookupMap<[u8; 32], u64>,
    used_quote_queue: LookupMap<u64, UsedQuote>,
    used_quote_head: u64,
    used_quote_tail: u64,
}

#[near]
impl BlindTrust {
    /// `account_code_hash` is base58 of a global contract already on chain (the plan account
    /// code the plan registry published); trust accounts use it by hash.
    #[init]
    pub fn new(
        governance: AccountId,
        min_cooling_off_ms: u64,
        enclave_activation_delay_ms: u64,
        account_code_hash: String,
    ) -> Self {
        // A new enclave or quote key is public for at least one cooling-off before it can act.
        require!(
            enclave_activation_delay_ms >= min_cooling_off_ms,
            "activation_delay_too_short"
        );
        let account_code_hash: [u8; 32] = bs58::decode(&account_code_hash)
            .into_vec()
            .ok()
            .and_then(|v| v.try_into().ok())
            .unwrap_or_else(|| env::panic_str("invalid_code_hash"));
        Self {
            config: Config {
                governance,
                min_cooling_off_ms,
                enclave_activation_delay_ms,
                account_code_hash,
                paused: false,
                quote_signer: None,
            },
            next_trust_id: 1,
            trusts: LookupMap::new(StorageKey::Trusts),
            receipts: LookupMap::new(StorageKey::Receipts),
            enclaves: IterableMap::new(StorageKey::Enclaves),
            quote_signers: Vector::new(StorageKey::QuoteSigners),
            used_quotes: LookupMap::new(StorageKey::UsedQuotes),
            used_quote_queue: LookupMap::new(StorageKey::UsedQuoteQueue),
            used_quote_head: 0,
            used_quote_tail: 0,
        }
    }

    // ── Governance: the enclave allowlist and the quote key ────────────────────────────────────

    /// Governance-only, payable for its storage. The key can sign only after the activation
    /// delay, so the public sees a new enclave before it can act.
    #[payable]
    pub fn register_enclave(
        &mut self,
        public_key: String,
        measurements: Measurements,
        quote_hash: String,
    ) {
        self.only_governance();
        let before = env::storage_usage();
        parse_ed25519_key(&public_key);
        for value in [
            &measurements.mrtd,
            &measurements.rtmr0,
            &measurements.rtmr1,
            &measurements.rtmr2,
            &measurements.rtmr3,
        ] {
            require_hex(value, 96, "invalid_measurements");
        }
        let quote_hash = normalize_hex32(&quote_hash, "invalid_quote_hash");
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
            "trust_enclave_registered",
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
        self.charge_storage(before, NearToken::from_yoctonear(0));
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
        events::emit("trust_enclave_revoked", json!({ "public_key": public_key }));
    }

    /// Governance-only. Sets the 1Click quote key; usable after the activation delay, and a
    /// replaced key stops at once. Earlier keys stay listed so old receipts remain verifiable.
    pub fn set_quote_signer(&mut self, public_key: String) {
        self.only_governance();
        parse_ed25519_key(&public_key);
        let now = env::block_timestamp_ms();
        let active_from_ms = now.saturating_add(self.config.enclave_activation_delay_ms);
        events::emit(
            "trust_quote_signer_set",
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

    /// Governance-only. Pausing stops trades and acks; it never opens a way to move assets.
    pub fn set_paused(&mut self, paused: bool) {
        self.only_governance();
        self.config.paused = paused;
        events::emit("trust_paused", json!({ "paused": paused }));
    }

    // ── The official's side ────────────────────────────────────────────────────────────────────

    /// Creates a trust owned by the caller and its keyless trust account. `holdings` are the
    /// NEP-141 tokens the owner will transfer in (the trust may sell only tokens it holds). The
    /// deposit pays this trust's storage plus `TRUST_ACCOUNT_FUNDING`; the rest is refunded.
    #[payable]
    #[allow(clippy::too_many_arguments)] // flat JSON arguments are the public interface
    pub fn create_trust(
        &mut self,
        commitment: String,
        envelope: TrustEnvelope,
        beneficiary: AccountId,
        cooling_off_ms: u64,
        end_ms: u64,
        holdings: Vec<AccountId>,
        label: String,
    ) -> u64 {
        let before = env::storage_usage();
        let now = env::block_timestamp_ms();
        require!(
            cooling_off_ms >= self.config.min_cooling_off_ms,
            "cooling_off_too_short"
        );
        let commitment = normalize_hex32(&commitment, "invalid_commitment");
        validate_envelope(&envelope);
        require!(end_ms > now && end_ms - now <= MAX_TERM_MS, "invalid_term");
        require!(
            !holdings.is_empty() && holdings.len() <= MAX_HOLDINGS,
            "invalid_holdings"
        );
        for (i, token) in holdings.iter().enumerate() {
            require!(!holdings[..i].contains(token), "invalid_holdings");
        }
        require!(label.chars().count() <= MAX_LABEL_LEN, "label_too_long");

        let id = self.next_trust_id;
        self.next_trust_id += 1;
        let trust_account = trust_account_for(id);
        let owner = env::predecessor_account_id();
        events::emit(
            "trust_created",
            json!({
                "trust_id": id,
                "owner": owner,
                "trust_account": trust_account,
                "commitment": commitment,
                "envelope": envelope,
                "beneficiary": beneficiary,
                "cooling_off_ms": cooling_off_ms,
                "end_ms": end_ms,
                "holdings": holdings,
            }),
        );
        self.trusts.insert(
            id,
            Trust {
                id,
                owner,
                commitment,
                envelope,
                beneficiary,
                trust_account: trust_account.clone(),
                cooling_off_ms,
                start_ms: now,
                end_ms,
                status: TrustStatus::AwaitingAck,
                created_at_ms: now,
                acked_at_ms: None,
                acked_by: None,
                holdings,
                next_seq: 0,
                period_index: 0,
                turnover_in_period_usd_e6: U128(0),
                last_trade_ms: None,
                pending_change: None,
                ended_at_ms: None,
                label,
            },
        );
        self.charge_storage(before, TRUST_ACCOUNT_FUNDING);

        // No add_key action: the account is created keyless and only its code can act for it.
        // `token: null` makes it refund every ft_transfer_call; deposits arrive by ft_transfer.
        Promise::new(trust_account)
            .create_account()
            .transfer(TRUST_ACCOUNT_FUNDING)
            .use_global_contract(self.config.account_code_hash)
            .function_call(
                "new".to_string(),
                json_bytes(&json!({ "registry": env::current_account_id(), "token": null })),
                NearToken::from_yoctonear(0),
                GAS_ACCOUNT_INIT,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_ON_ACCOUNT_CREATED)
                    .on_account_created(id),
            )
            .detach();
        id
    }

    /// If the trust account could not be created, the trust can never hold anything: end it and
    /// give the owner the funding back (the failed transfer was refunded to this contract).
    #[private]
    pub fn on_account_created(&mut self, trust_id: u64) -> bool {
        if env::promise_result_checked(0, 0).is_ok() {
            return true;
        }
        let trust = self.trust_mut(trust_id);
        trust.status = TrustStatus::Ended;
        trust.ended_at_ms = Some(env::block_timestamp_ms());
        let owner = trust.owner.clone();
        Promise::new(owner).transfer(TRUST_ACCOUNT_FUNDING).detach();
        events::emit(
            "trust_ended",
            json!({ "trust_id": trust_id, "reason": "trust_account_failed" }),
        );
        false
    }

    /// Anyone can relay. Activates a trust once a registered enclave signs that the sealed mandate
    /// matches the commitment and sits inside the public envelope. `signature` is standard base64
    /// of the ed25519 signature over `"vsp/trust-ack/v1\n" || ack_json`.
    pub fn ack_trust(
        &mut self,
        trust_id: u64,
        ack_json: String,
        signature: String,
        enclave_key: String,
    ) {
        require!(!self.config.paused, "paused");
        let (key, key_registered_at) = self.active_enclave_key(&enclave_key);
        require!(ack_json.len() <= MAX_ACK_JSON_BYTES, "bad_request");
        verify_signature(
            &key,
            TRUST_ACK_DOMAIN,
            &ack_json,
            &signature,
            "bad_signature",
        );
        let ack: TrustAck =
            serde_json::from_str(&ack_json).unwrap_or_else(|_| env::panic_str("bad_request"));
        require!(ack.kind == "trust_ack", "bad_request");
        require!(ack.trust_id == trust_id, "trust_mismatch");
        require!(ack.within_envelope, "not_compliant");
        let now = env::block_timestamp_ms();
        let trust = self.trust_mut(trust_id);
        require!(trust.status == TrustStatus::AwaitingAck, "already_acked");
        require_key_notice(key_registered_at, trust, now);
        require!(
            ack.issued_at_ms <= now.saturating_add(MAX_CLOCK_SKEW_MS)
                && ack.issued_at_ms.saturating_add(MAX_CLOCK_SKEW_MS) >= trust.created_at_ms,
            "stale_ack"
        );
        require!(
            ack.commitment.to_ascii_lowercase() == trust.commitment,
            "commitment_mismatch"
        );
        require!(ack.envelope == trust.envelope, "envelope_mismatch");
        require!(
            ack.beneficiary == trust.beneficiary
                && ack.end_ms == trust.end_ms
                && ack.trust_account == trust.trust_account,
            "terms_mismatch"
        );
        trust.status = TrustStatus::Active;
        trust.acked_at_ms = Some(now);
        trust.acked_by = Some(enclave_key.clone());
        events::emit(
            "trust_acked",
            json!({ "trust_id": trust_id, "commitment": trust.commitment, "enclave_key": enclave_key }),
        );
    }

    /// Owner-only, payable for the pending change's storage. The new envelope applies after the
    /// trust's cooling-off; until then the current one holds. One change at a time.
    #[payable]
    pub fn propose_envelope(&mut self, trust_id: u64, envelope: TrustEnvelope) {
        let before = env::storage_usage();
        validate_envelope(&envelope);
        let now = env::block_timestamp_ms();
        let trust = self.owned_trust_mut(trust_id);
        apply_due_change(trust, now);
        require!(trust.status != TrustStatus::Ended, "ended");
        require!(trust.pending_change.is_none(), "change_pending");
        let effective_at_ms = now.saturating_add(trust.cooling_off_ms);
        events::emit(
            "trust_change_requested",
            json!({
                "trust_id": trust_id,
                "kind": ChangeKind::Envelope,
                "envelope": envelope,
                "effective_at_ms": effective_at_ms,
            }),
        );
        trust.pending_change = Some(PendingChange {
            kind: ChangeKind::Envelope,
            envelope: Some(envelope),
            requested_at_ms: now,
            effective_at_ms,
        });
        self.charge_storage(before, NearToken::from_yoctonear(0));
    }

    /// Owner-only. Ends the trust after the cooling-off; everything then goes to the beneficiary.
    /// Once effective it cannot be withdrawn.
    pub fn cancel(&mut self, trust_id: u64) {
        let now = env::block_timestamp_ms();
        let trust = self.owned_trust_mut(trust_id);
        apply_due_change(trust, now);
        require!(trust.status != TrustStatus::Ended, "ended");
        require!(trust.pending_change.is_none(), "change_pending");
        let effective_at_ms = now.saturating_add(trust.cooling_off_ms);
        events::emit(
            "trust_change_requested",
            json!({ "trust_id": trust_id, "kind": ChangeKind::Cancel, "effective_at_ms": effective_at_ms }),
        );
        trust.pending_change = Some(PendingChange {
            kind: ChangeKind::Cancel,
            envelope: None,
            requested_at_ms: now,
            effective_at_ms,
        });
    }

    /// Owner-only, before the change takes effect.
    pub fn withdraw_change(&mut self, trust_id: u64) {
        let now = env::block_timestamp_ms();
        let trust = self.owned_trust_mut(trust_id);
        apply_due_change(trust, now);
        let change = trust
            .pending_change
            .take()
            .unwrap_or_else(|| env::panic_str("no_change"));
        require!(now < change.effective_at_ms, "change_effective");
        events::emit(
            "trust_change_withdrawn",
            json!({ "trust_id": trust_id, "kind": change.kind }),
        );
    }

    /// Anyone. Ends the trust once its term is over or a cancel's cooling-off has passed.
    pub fn finalize(&mut self, trust_id: u64) {
        let now = env::block_timestamp_ms();
        let trust = self.trust_mut(trust_id);
        require!(trust.status != TrustStatus::Ended, "ended");
        apply_due_change(trust, now);
        let reason = if now >= trust.end_ms {
            "end"
        } else if cancel_effective(trust, now) {
            "cancel"
        } else {
            env::panic_str("not_ended")
        };
        trust.status = TrustStatus::Ended;
        trust.pending_change = None;
        trust.ended_at_ms = Some(now);
        events::emit(
            "trust_ended",
            json!({ "trust_id": trust_id, "reason": reason }),
        );
    }

    /// Anyone, once ended: the trust account sends its whole balance of `token` to the
    /// beneficiary. Calling again retries (or releases tokens that arrived late).
    pub fn release(&mut self, trust_id: u64, token: AccountId) -> Promise {
        let trust = self.trust(trust_id);
        require!(trust.status == TrustStatus::Ended, "not_ended");
        require!(trust.holdings.contains(&token), "not_held");
        events::emit(
            "trust_release_requested",
            json!({ "trust_id": trust_id, "token": token, "receiver_id": trust.beneficiary }),
        );
        Promise::new(trust.trust_account.clone()).function_call(
            "release".to_string(),
            json_bytes(&json!({ "token": token, "receiver_id": trust.beneficiary })),
            NearToken::from_yoctonear(0),
            GAS_RELEASE,
        )
    }

    // ── Views ──────────────────────────────────────────────────────────────────────────────────

    /// The trust with any envelope change whose cooling-off has passed already applied, as the
    /// next trade will see it.
    pub fn get_trust(&self, trust_id: u64) -> Option<Trust> {
        let mut trust = self.trusts.get(&trust_id).cloned()?;
        apply_due_change(&mut trust, env::block_timestamp_ms());
        Some(trust)
    }

    pub fn list_trusts(&self, from_index: Option<u64>, limit: Option<u32>) -> Vec<Trust> {
        let from = from_index.unwrap_or(1).max(1);
        let limit = u64::from(limit.unwrap_or(MAX_PAGE).min(MAX_PAGE));
        let now = env::block_timestamp_ms();
        (from..self.next_trust_id)
            .take(limit as usize)
            .filter_map(|id| self.trusts.get(&id).cloned())
            .map(|mut t| {
                apply_due_change(&mut t, now);
                t
            })
            .collect()
    }

    pub fn get_receipts(
        &self,
        trust_id: u64,
        from_seq: Option<u64>,
        limit: Option<u32>,
    ) -> Vec<Receipt> {
        let Some(trust) = self.trusts.get(&trust_id) else {
            return Vec::new();
        };
        let limit = u64::from(limit.unwrap_or(MAX_PAGE).min(MAX_PAGE));
        (from_seq.unwrap_or(0)..trust.next_seq)
            .take(limit as usize)
            .filter_map(|seq| self.receipts.get(&(trust_id, seq)).cloned())
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

    pub fn get_config(&self) -> ConfigView {
        ConfigView {
            governance: self.config.governance.clone(),
            min_cooling_off_ms: self.config.min_cooling_off_ms,
            enclave_activation_delay_ms: self.config.enclave_activation_delay_ms,
            account_code_hash: bs58::encode(self.config.account_code_hash).into_string(),
            paused: self.config.paused,
            trust_account_funding: U128(TRUST_ACCOUNT_FUNDING.as_yoctonear()),
            next_trust_id: self.next_trust_id,
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

    pub fn trust_account_id(&self, trust_id: u64) -> AccountId {
        trust_account_for(trust_id)
    }

    /// Anyone. Prunes up to `limit` expired used-quote entries; trades also prune a few.
    pub fn prune_used_quotes(&mut self, limit: Option<u32>) -> u32 {
        self.prune_expired_quotes(
            limit.unwrap_or(trade::MAX_PRUNE).min(trade::MAX_PRUNE),
            env::block_timestamp_ms(),
        )
    }
}

impl BlindTrust {
    fn only_governance(&self) {
        require!(
            env::predecessor_account_id() == self.config.governance,
            "only_governance"
        );
    }

    fn trust(&self, trust_id: u64) -> &Trust {
        self.trusts
            .get(&trust_id)
            .unwrap_or_else(|| env::panic_str("trust_not_found"))
    }

    fn trust_mut(&mut self, trust_id: u64) -> &mut Trust {
        self.trusts
            .get_mut(&trust_id)
            .unwrap_or_else(|| env::panic_str("trust_not_found"))
    }

    fn owned_trust_mut(&mut self, trust_id: u64) -> &mut Trust {
        let caller = env::predecessor_account_id();
        let trust = self.trust_mut(trust_id);
        require!(trust.owner == caller, "only_owner");
        trust
    }

    /// An enclave may sign only when registered, past its activation delay and not revoked.
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
        (parse_ed25519_key(enclave_key), enclave.registered_at_ms)
    }

    fn active_quote_signer(&self) -> (QuoteSigner, [u8; 32]) {
        let signer = self
            .config
            .quote_signer
            .clone()
            .unwrap_or_else(|| env::panic_str("quote_signer_not_set"));
        require!(
            signer.active_from_ms <= env::block_timestamp_ms(),
            "quote_signer_not_active"
        );
        let key = parse_ed25519_key(&signer.public_key);
        (signer, key)
    }

    /// Makes the caller pay for the bytes this call added and for `extra`, which this call
    /// forwards. Refunds the rest.
    fn charge_storage(&mut self, before: u64, extra: NearToken) {
        self.trusts.flush();
        self.receipts.flush();
        self.enclaves.flush();
        self.quote_signers.flush();
        self.used_quotes.flush();
        self.used_quote_queue.flush();
        let added = env::storage_usage().saturating_sub(before);
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
}

/// An envelope change whose cooling-off has passed is the envelope. A cancel stays pending (it
/// stops trades and allows `finalize`).
pub fn apply_due_change(trust: &mut Trust, now: u64) {
    let due = trust
        .pending_change
        .as_ref()
        .is_some_and(|c| c.kind == ChangeKind::Envelope && c.effective_at_ms <= now);
    if due {
        if let Some(envelope) = trust.pending_change.take().and_then(|c| c.envelope) {
            trust.envelope = envelope;
        }
    }
}

pub fn cancel_effective(trust: &Trust, now: u64) -> bool {
    trust
        .pending_change
        .as_ref()
        .is_some_and(|c| c.kind == ChangeKind::Cancel && c.effective_at_ms <= now)
}

/// A key may act for a trust if it was registered before the trust was created (the official and
/// the public knew it), or has been registered for at least the trust's own cooling-off.
fn require_key_notice(registered_at_ms: u64, trust: &Trust, now: u64) {
    require!(
        registered_at_ms < trust.created_at_ms
            || now >= registered_at_ms.saturating_add(trust.cooling_off_ms),
        "key_too_new_for_trust"
    );
}

pub fn validate_envelope(envelope: &TrustEnvelope) {
    require!(
        envelope.period_ms > 0
            && envelope.max_turnover_usd_e6.0 > 0
            && envelope.min_gap_ms >= MIN_GAP_MS
            && envelope.excluded_assets.len() <= MAX_EXCLUDED_ASSETS,
        "invalid_envelope"
    );
    for (i, asset) in envelope.excluded_assets.iter().enumerate() {
        // `nep141:` and a valid (lowercase) NEAR account, the only form a quote's
        // destinationAsset can take here; anything else could never match and would only look
        // like an exclusion.
        let account_ok = asset
            .strip_prefix("nep141:")
            .is_some_and(|id| id.parse::<AccountId>().is_ok());
        require!(
            account_ok
                && asset.len() <= MAX_ASSET_ID_LEN
                && !envelope.excluded_assets[..i].contains(asset),
            "invalid_envelope"
        );
    }
}

pub fn trust_account_for(trust_id: u64) -> AccountId {
    format!("t{trust_id}.{}", env::current_account_id())
        .parse()
        .unwrap_or_else(|_| env::panic_str("bad_request"))
}

pub fn json_bytes(value: &serde_json::Value) -> Vec<u8> {
    serde_json::to_vec(value).unwrap_or_else(|_| env::panic_str("bad_request"))
}

/// Lowercase 64-hex-digit string, e.g. a sha256 commitment.
fn normalize_hex32(value: &str, error: &str) -> String {
    require!(
        value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit()),
        error
    );
    value.to_ascii_lowercase()
}

/// Hex string of bounded length (TDX measurements are 48 bytes = 96 digits).
fn require_hex(value: &str, max_len: usize, error: &str) {
    require!(
        !value.is_empty()
            && value.len() <= max_len
            && value.len().is_multiple_of(2)
            && value.bytes().all(|b| b.is_ascii_hexdigit()),
        error
    );
}

/// "ed25519:<base58 of 32 bytes>" → raw key.
fn parse_ed25519_key(value: &str) -> [u8; 32] {
    value
        .strip_prefix("ed25519:")
        .and_then(|encoded| bs58::decode(encoded).into_vec().ok())
        .and_then(|bytes| bytes.try_into().ok())
        .unwrap_or_else(|| env::panic_str("invalid_public_key"))
}

/// Verifies standard-base64 `signature` over `domain || message`. The domain prefix stops a
/// signature for one message type (or a plan's) being replayed as another.
fn verify_signature(key: &[u8; 32], domain: &[u8], message: &str, signature: &str, error: &str) {
    let signature: [u8; 64] = BASE64
        .decode(signature)
        .ok()
        .and_then(|bytes| bytes.try_into().ok())
        .unwrap_or_else(|| env::panic_str(error));
    let signed = [domain, message.as_bytes()].concat();
    require!(env::ed25519_verify(&signature, &signed, key), error);
}
