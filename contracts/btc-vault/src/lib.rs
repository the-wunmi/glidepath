//! Coercion-safe Bitcoin vault (prototype, testnet4).
//!
//! Each vault is a native Bitcoin P2WPKH address whose only signer is this contract, through
//! Chain Signatures. The owner's withdrawals are public at once and wait out the vault's delay;
//! any guardian can veto one before it is signed, or claw the funds back, with no delay, to the
//! recovery address fixed when the vault was created. After the delay anyone can execute: the
//! contract builds the transaction and its BIP143 signature hashes from the stored request and
//! asks the MPC network to sign each input, then stores the signatures so anyone can broadcast.
//! There is no upgrade method, and the account's key is deleted at deployment.

mod bitcoin;
mod events;

use bitcoin::{Tx, TxIn, TxOut};
use near_sdk::json_types::U64;
use near_sdk::serde_json::{self, json};
use near_sdk::store::{LookupMap, LookupSet};
use near_sdk::{
    bs58, env, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise,
};

const DAY_MS: u64 = 86_400_000;
/// No vault may wait less than this. A minute keeps the testnet demo watchable; a vault guarding
/// real savings would choose days, which the contract's own `min_delay_ms` can require.
pub const MIN_DELAY_FLOOR_MS: u64 = 60_000;
/// Longer delays would lock the owner out for no added safety: guardians can claw back anyway.
pub const MAX_DELAY_MS: u64 = 30 * DAY_MS;
/// Each guardian is stored on the vault and checked on every veto; a handful is plenty.
pub const MAX_GUARDIANS: usize = 5;
/// Each input needs its own MPC signature in the same transaction (40 Tgas each, under 300 Tgas).
pub const MAX_INPUTS: usize = 4;
pub const MAX_PATH_LEN: usize = 64;
/// The largest standard dust threshold (P2PKH at 3 sat/vB): no output pays less.
pub const DUST_SATS: u64 = 546;
/// Below 1 sat/vB nodes do not relay the transaction.
pub const MIN_FEE_RATE_SAT_VB: u64 = 1;
/// A withdrawal's fee cap: well above ordinary rates, and far below the claw-back cap, so a
/// claw-back can always pay more than any withdrawal it has to replace (BIP125).
pub const MAX_WITHDRAWAL_FEE_RATE_SAT_VB: u64 = 25;
/// A claw-back's fee cap: room to outbid a withdrawal, while a guardian still cannot burn the vault
/// on fees.
pub const MAX_FEE_RATE_SAT_VB: u64 = 200;
/// BIP125 rule 4: a replacement pays the original's fee plus this rate on its own size.
pub const INCREMENTAL_RELAY_SAT_VB: u64 = 1;
/// 21 million BTC in satoshis: no amount can be more.
const MAX_SATS: u64 = 2_100_000_000_000_000;
/// A sign whose callback never ran is retried after this many blocks. Assumption, unverified on
/// testnet: the signer's yield times out after about 200 blocks (measured in the sandbox only), so
/// by then the old round can no longer produce a signature. Either way a retry signs the same
/// hashes, so a late signature from the old round is no different from the new one.
pub const STALE_SIGN_BLOCKS: u64 = 300;
/// The signer requires at least 15 Tgas; the rest covers its own yield callback.
const GAS_SIGN: Gas = Gas::from_tgas(40);
const GAS_ON_SIGNED: Gas = Gas::from_tgas(30);
const GAS_DERIVED_PUBLIC_KEY: Gas = Gas::from_tgas(10);
const GAS_ON_DERIVED_KEY: Gas = Gas::from_tgas(10);
/// The live signer takes at least 1 yoctoNEAR per request; owner and guardian actions take 1 yocto
/// too, so a leaked function-call key cannot act for them.
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
/// A signature response is ~250 bytes of JSON; a derived key ~100.
const MAX_SIGNATURE_RESPONSE_BYTES: usize = 1024;
const MAX_DERIVED_KEY_RESPONSE_BYTES: usize = 256;
/// Storage the derive callback adds (33-byte key, ~45-byte address), paid by the creator up front.
const KEY_RESERVE_BYTES: u64 = 128;
/// Storage each input's signature adds when the signer answers, paid by whoever executes.
const SIGNATURE_RESERVE_BYTES: u64 = 96;
/// Storage a finished spend adds (signed time, the signed-outpoint index), paid up front.
const SPEND_RESERVE_BYTES: u64 = 64;
const PAGE: u32 = 50;

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Vaults,
    Paths,
    Spends,
    BoundTxs,
    WithdrawalOutpoints,
}

#[near(serializers = [borsh])]
pub struct Vault {
    pub owner: AccountId,
    pub guardians: Vec<AccountId>,
    pub recovery_address: String,
    pub delay_ms: u64,
    pub path: String,
    /// Compressed secp256k1 key the signer derives for (this contract, path); set by the callback.
    pub public_key: Option<Vec<u8>>,
    pub open_withdrawal: Option<u64>,
    pub open_clawback: Option<u64>,
    pub next_spend_id: u64,
    pub created_at_ms: u64,
}

#[near(serializers = [json, borsh])]
#[serde(rename_all = "snake_case")]
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum SpendKind {
    Withdrawal,
    Clawback,
}

#[near(serializers = [json, borsh])]
#[serde(rename_all = "snake_case")]
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum SpendStatus {
    /// Waiting out the delay (withdrawals), or ready to execute again after a failed signing round.
    Pending,
    Signing,
    /// Every input is signed; anyone can assemble and broadcast it.
    Signed,
    Vetoed,
    /// A claw-back replaced it before it was signed.
    Cancelled,
}

#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct Signature {
    /// R, compressed (33 bytes).
    pub big_r: Vec<u8>,
    pub s: [u8; 32],
    pub recovery_id: u8,
}

#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct SpendInput {
    /// Display order, as explorers show it.
    pub txid: [u8; 32],
    pub vout: u32,
    pub amount: u64,
    pub signature: Option<Signature>,
}

#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct Spend {
    pub kind: SpendKind,
    pub requested_by: AccountId,
    pub requested_at_ms: u64,
    pub effective_at_ms: u64,
    pub destination: String,
    pub amount: u64,
    /// Back to the vault's own address; 0 means no change output.
    pub change: u64,
    pub fee: u64,
    pub inputs: Vec<SpendInput>,
    pub status: SpendStatus,
    pub vetoed_by: Option<AccountId>,
    /// Each execute starts a new round; callbacks of an older round change nothing.
    pub sign_round: u32,
    pub sign_started_block: Option<u64>,
    pub signed_at_ms: Option<u64>,
}

/// A UTXO of the vault to spend. The amount is signed into each BIP143 hash, so a wrong amount
/// only produces signatures the network rejects; it can never move more than the request says.
#[near(serializers = [json])]
pub struct InputArg {
    pub txid: String,
    pub vout: u32,
    pub amount: U64,
}

#[near(serializers = [json])]
pub struct ConfigView {
    pub signer_contract: AccountId,
    pub min_delay_ms: u64,
    pub max_delay_ms: u64,
    pub next_vault_id: u64,
    pub max_guardians: u32,
    pub max_inputs: u32,
    pub dust_sats: U64,
    pub min_fee_rate_sat_vb: u64,
    pub max_withdrawal_fee_rate_sat_vb: u64,
    /// Claw-backs' cap.
    pub max_fee_rate_sat_vb: u64,
    pub network: String,
}

#[near(serializers = [json])]
pub struct VaultView {
    pub id: u64,
    pub owner: AccountId,
    pub guardians: Vec<AccountId>,
    pub recovery_address: String,
    pub delay_ms: u64,
    pub path: String,
    pub public_key: Option<String>,
    pub address: Option<String>,
    pub open_withdrawal: Option<u64>,
    pub open_clawback: Option<u64>,
    pub spend_count: u64,
    pub created_at_ms: u64,
}

#[near(serializers = [json])]
pub struct SignatureView {
    pub big_r: String,
    pub s: String,
    pub recovery_id: u8,
}

#[near(serializers = [json])]
pub struct InputView {
    pub txid: String,
    pub vout: u32,
    pub amount: U64,
    pub signature: Option<SignatureView>,
}

#[near(serializers = [json])]
pub struct SpendView {
    pub vault_id: u64,
    pub id: u64,
    pub kind: SpendKind,
    pub status: SpendStatus,
    pub requested_by: AccountId,
    pub requested_at_ms: u64,
    pub effective_at_ms: u64,
    pub destination: String,
    pub amount: U64,
    pub change: U64,
    pub fee: U64,
    pub inputs: Vec<InputView>,
    pub vetoed_by: Option<AccountId>,
    /// Signing rounds started. After the first, signatures may be public: no veto, only claw-back.
    pub sign_rounds: u32,
    pub signed_at_ms: Option<u64>,
    /// The non-witness transaction and each input's BIP143 hash, exactly what the MPC signs.
    pub unsigned_tx: String,
    pub sighashes: Vec<String>,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct BtcVault {
    signer_contract: AccountId,
    min_delay_ms: u64,
    next_vault_id: u64,
    vaults: LookupMap<u64, Vault>,
    /// Paths already used, so no two vaults share an address.
    paths: LookupSet<String>,
    spends: LookupMap<(u64, u64), Spend>,
    /// (vault, sha256(hashPrevouts ‖ hashOutputs)) → the input amounts first sent for signing.
    /// BIP143 signs each input's own amount but every input's outpoint and every output, so only
    /// signatures from requests with the same outpoints (in order) and the same outputs can be
    /// combined into one transaction. If two such requests named different amounts, mixing their
    /// signatures would pay far more fee than either allowed; so a later request with the same
    /// outpoints and outputs must repeat the amounts. A request with corrected amounts has
    /// different outputs, so a wrong first amount never freezes a coin.
    bound_txs: LookupMap<(u64, [u8; 32]), Vec<u64>>,
    /// (vault, txid, vout) → the last withdrawal that started signing with that outpoint, so a
    /// claw-back over it pays enough to replace it (BIP125).
    withdrawal_outpoints: LookupMap<(u64, [u8; 32], u32), u64>,
}

#[near]
impl BtcVault {
    #[init]
    pub fn new(signer_contract: AccountId, min_delay_ms: u64) -> Self {
        require!(min_delay_ms >= MIN_DELAY_FLOOR_MS, "delay_too_short");
        require!(min_delay_ms <= MAX_DELAY_MS, "delay_too_long");
        Self {
            signer_contract,
            min_delay_ms,
            next_vault_id: 1,
            vaults: LookupMap::new(StorageKey::Vaults),
            paths: LookupSet::new(StorageKey::Paths),
            spends: LookupMap::new(StorageKey::Spends),
            bound_txs: LookupMap::new(StorageKey::BoundTxs),
            withdrawal_outpoints: LookupMap::new(StorageKey::WithdrawalOutpoints),
        }
    }

    /// Creates a vault owned by the caller and asks the signer for its key; the promise resolves
    /// to the vault id. The caller pays the storage (excess refunded).
    #[payable]
    pub fn create_vault(
        &mut self,
        guardians: Vec<AccountId>,
        recovery_address: String,
        delay_ms: u64,
        path: String,
    ) -> Promise {
        let before = env::storage_usage();
        let owner = env::predecessor_account_id();
        require!(
            !guardians.is_empty() && guardians.len() <= MAX_GUARDIANS,
            "bad_guardians"
        );
        for (i, guardian) in guardians.iter().enumerate() {
            require!(*guardian != owner, "owner_is_guardian");
            require!(!guardians[..i].contains(guardian), "duplicate_guardian");
        }
        require!(
            bitcoin::script_for_address(&recovery_address).is_some(),
            "invalid_btc_address"
        );
        require!(delay_ms >= self.min_delay_ms, "delay_too_short");
        require!(delay_ms <= MAX_DELAY_MS, "delay_too_long");
        require!(
            !path.is_empty()
                && path.len() <= MAX_PATH_LEN
                && path
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"-_./".contains(&b)),
            "bad_path"
        );
        require!(self.paths.insert(path.clone()), "path_taken");
        let id = self.next_vault_id;
        self.next_vault_id += 1;
        events::emit(
            "vault_created",
            json!({
                "vault_id": id,
                "owner": owner,
                "guardians": guardians,
                "recovery_address": recovery_address,
                "delay_ms": delay_ms,
                "path": path,
            }),
        );
        self.vaults.insert(
            id,
            Vault {
                owner,
                guardians,
                recovery_address,
                delay_ms,
                path,
                public_key: None,
                open_withdrawal: None,
                open_clawback: None,
                next_spend_id: 1,
                created_at_ms: env::block_timestamp_ms(),
            },
        );
        self.charge_storage(before, KEY_RESERVE_BYTES, NearToken::from_yoctonear(0));
        self.derive_key(id)
    }

    /// Anyone. Retries the key lookup if the first one failed.
    pub fn refresh_key(&mut self, vault_id: u64) -> Promise {
        require!(self.vault(vault_id).public_key.is_none(), "key_set");
        self.derive_key(vault_id)
    }

    #[private]
    pub fn on_derived_key(&mut self, vault_id: u64) -> u64 {
        let xy = env::promise_result_checked(0, MAX_DERIVED_KEY_RESPONSE_BYTES)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<String>(&bytes).ok())
            .and_then(|value| {
                let bytes = bs58::decode(value.strip_prefix("secp256k1:")?)
                    .into_vec()
                    .ok()?;
                (bytes.len() == 64).then_some(bytes)
            });
        let Some(xy) = xy else {
            events::emit("key_failed", json!({ "vault_id": vault_id }));
            return vault_id;
        };
        let mut compressed = vec![0x02 | (xy[63] & 1)];
        compressed.extend_from_slice(&xy[..32]);
        let address = bitcoin::p2wpkh_address(&bitcoin::hash160(&compressed));
        if let Some(vault) = self.vaults.get_mut(&vault_id) {
            vault.public_key = Some(compressed.clone());
        }
        events::emit(
            "vault_address",
            json!({
                "vault_id": vault_id,
                "public_key": hex::encode(&compressed),
                "address": address,
            }),
        );
        vault_id
    }

    /// Owner only, 1 yocto plus storage. Public at once; executable after the vault's delay unless
    /// a guardian vetoes it. Pays `amount` to `destination` and any change back to the vault.
    #[payable]
    pub fn request_withdrawal(
        &mut self,
        vault_id: u64,
        destination: String,
        amount: U64,
        inputs: Vec<InputArg>,
        fee: U64,
    ) -> u64 {
        let before = env::storage_usage();
        let caller = env::predecessor_account_id();
        let vault = self.vault(vault_id);
        require!(vault.owner == caller, "only_owner");
        require!(vault.public_key.is_some(), "key_missing");
        require!(vault.open_withdrawal.is_none(), "withdrawal_open");
        let delay_ms = vault.delay_ms;
        let inputs = parse_inputs(inputs);
        self.check_no_overlap_while_signing(vault_id, &inputs, None);
        require!(
            bitcoin::script_for_address(&destination).is_some(),
            "invalid_btc_address"
        );
        let total = input_total(&inputs);
        let (amount, fee) = (amount.0, fee.0);
        require!(amount >= DUST_SATS, "amount_below_dust");
        let change = total
            .checked_sub(amount)
            .and_then(|rest| rest.checked_sub(fee))
            .unwrap_or_else(|| env::panic_str("insufficient_inputs"));
        require!(change == 0 || change >= DUST_SATS, "change_below_dust");
        let now = env::block_timestamp_ms();
        let spend = Spend {
            kind: SpendKind::Withdrawal,
            requested_by: caller,
            requested_at_ms: now,
            effective_at_ms: now.saturating_add(delay_ms),
            destination,
            amount,
            change,
            fee,
            inputs,
            status: SpendStatus::Pending,
            vetoed_by: None,
            sign_round: 0,
            sign_started_block: None,
            signed_at_ms: None,
        };
        check_fee(&spend, self.vault(vault_id), 0);
        self.check_binding(vault_id, &spend);
        let id = self.open_spend(vault_id, spend);
        self.charge_storage(before, SPEND_RESERVE_BYTES, ONE_YOCTO);
        id
    }

    /// Any guardian, 1 yocto. Stops a withdrawal before its first signing round; the contract never
    /// signs it after that. Once a round has started, signatures may already be public (in the
    /// signer's answer, even when this contract's callback failed), so only a claw-back can act.
    #[payable]
    pub fn veto(&mut self, vault_id: u64, spend_id: u64) {
        let before = env::storage_usage();
        let caller = env::predecessor_account_id();
        require!(
            self.vault(vault_id).guardians.contains(&caller),
            "only_guardian"
        );
        let spend = self.spend_mut(vault_id, spend_id);
        require!(spend.kind == SpendKind::Withdrawal, "not_a_withdrawal");
        require!(spend.status == SpendStatus::Pending, "not_pending");
        require!(spend.sign_round == 0, "signing_started");
        spend.status = SpendStatus::Vetoed;
        spend.vetoed_by = Some(caller.clone());
        self.close_spend(vault_id, spend_id);
        events::emit(
            "withdrawal_vetoed",
            json!({ "vault_id": vault_id, "spend_id": spend_id, "guardian": caller }),
        );
        self.charge_storage(before, 0, ONE_YOCTO);
    }

    /// Any guardian, with no delay: signs a sweep of `inputs` to the recovery address and nowhere
    /// else. A withdrawal that has not started signing is cancelled. Over the outpoints of one that
    /// has, the fee must beat it by BIP125's margin, so the sweep can replace it if it is still
    /// unconfirmed. The deposit covers storage and 1 yocto per input for the signer.
    #[payable]
    pub fn claw_back(&mut self, vault_id: u64, inputs: Vec<InputArg>, fee: U64) -> Promise {
        let before = env::storage_usage();
        let caller = env::predecessor_account_id();
        let vault = self.vault(vault_id);
        require!(vault.guardians.contains(&caller), "only_guardian");
        require!(vault.public_key.is_some(), "key_missing");
        require!(vault.open_clawback.is_none(), "clawback_open");
        let destination = vault.recovery_address.clone();
        let open_withdrawal = vault.open_withdrawal;
        let inputs = parse_inputs(inputs);
        self.check_no_overlap_while_signing(vault_id, &inputs, None);
        let replaces_fee = self.signed_withdrawal_fee(vault_id, &inputs);
        let total = input_total(&inputs);
        let amount = total
            .checked_sub(fee.0)
            .filter(|rest| *rest >= DUST_SATS)
            .unwrap_or_else(|| env::panic_str("insufficient_inputs"));
        let now = env::block_timestamp_ms();
        let spend = Spend {
            kind: SpendKind::Clawback,
            requested_by: caller.clone(),
            requested_at_ms: now,
            effective_at_ms: now,
            destination,
            amount,
            change: 0,
            fee: fee.0,
            inputs,
            status: SpendStatus::Pending,
            vetoed_by: None,
            sign_round: 0,
            sign_started_block: None,
            signed_at_ms: None,
        };
        check_fee(&spend, self.vault(vault_id), replaces_fee);
        self.check_binding(vault_id, &spend);
        // A withdrawal that has started signing cannot be cancelled (its signatures may exist); the
        // claw-back can still try to replace it in the mempool, since both signal replace-by-fee.
        if let Some(withdrawal_id) = open_withdrawal {
            let withdrawal = self.spend_mut(vault_id, withdrawal_id);
            if withdrawal.status == SpendStatus::Pending && withdrawal.sign_round == 0 {
                withdrawal.status = SpendStatus::Cancelled;
                withdrawal.vetoed_by = Some(caller.clone());
                self.close_spend(vault_id, withdrawal_id);
                events::emit(
                    "withdrawal_cancelled",
                    json!({ "vault_id": vault_id, "spend_id": withdrawal_id, "guardian": caller }),
                );
            }
        }
        let id = self.open_spend(vault_id, spend);
        self.sign_spend(vault_id, id, before)
    }

    /// Anyone, once a withdrawal's delay is over (a claw-back at once), or to retry a signing
    /// round that failed or went stale. The deposit covers 1 yocto per input for the signer and the
    /// storage of the signatures; excess is refunded.
    #[payable]
    pub fn execute(&mut self, vault_id: u64, spend_id: u64) -> Promise {
        let before = env::storage_usage();
        let spend = self.spend(vault_id, spend_id);
        match spend.status {
            SpendStatus::Pending => require!(
                env::block_timestamp_ms() >= spend.effective_at_ms,
                "delay_not_over"
            ),
            SpendStatus::Signing => require!(
                env::block_height()
                    >= spend
                        .sign_started_block
                        .unwrap_or_default()
                        .saturating_add(STALE_SIGN_BLOCKS),
                "sign_pending"
            ),
            _ => env::panic_str("not_pending"),
        }
        self.sign_spend(vault_id, spend_id, before)
    }

    /// Keeps each signature only if it recovers to the vault's own key over the hash this contract
    /// built. When every input is signed the spend is final; otherwise it can be executed again.
    #[private]
    pub fn on_signed(
        &mut self,
        vault_id: u64,
        spend_id: u64,
        round: u32,
        indexes: Vec<u32>,
        sighashes: Vec<String>,
    ) -> bool {
        let Some(public_key) = self
            .vaults
            .get(&vault_id)
            .and_then(|v| v.public_key.clone())
        else {
            return false;
        };
        let Some(spend) = self.spends.get_mut(&(vault_id, spend_id)) else {
            return false;
        };
        if spend.status != SpendStatus::Signing || spend.sign_round != round {
            return false;
        }
        let mut failures = Vec::new();
        for (k, (index, sighash)) in indexes.iter().zip(&sighashes).enumerate() {
            match verified_signature(k as u64, sighash, &public_key) {
                Ok(signature) => {
                    if let Some(input) = spend.inputs.get_mut(*index as usize) {
                        input.signature = Some(signature);
                    }
                }
                Err(reason) => failures.push(json!({ "input": index, "reason": reason })),
            }
        }
        let complete = spend.inputs.iter().all(|i| i.signature.is_some());
        if !complete {
            spend.status = SpendStatus::Pending;
            events::emit(
                "sign_failed",
                json!({ "vault_id": vault_id, "spend_id": spend_id, "failures": failures }),
            );
            return false;
        }
        spend.status = SpendStatus::Signed;
        spend.signed_at_ms = Some(env::block_timestamp_ms());
        let kind = spend.kind;
        self.close_spend(vault_id, spend_id);
        events::emit(
            "spend_signed",
            json!({ "vault_id": vault_id, "spend_id": spend_id, "kind": kind }),
        );
        true
    }

    pub fn get_config(&self) -> ConfigView {
        ConfigView {
            signer_contract: self.signer_contract.clone(),
            min_delay_ms: self.min_delay_ms,
            max_delay_ms: MAX_DELAY_MS,
            next_vault_id: self.next_vault_id,
            max_guardians: MAX_GUARDIANS as u32,
            max_inputs: MAX_INPUTS as u32,
            dust_sats: U64(DUST_SATS),
            min_fee_rate_sat_vb: MIN_FEE_RATE_SAT_VB,
            max_withdrawal_fee_rate_sat_vb: MAX_WITHDRAWAL_FEE_RATE_SAT_VB,
            max_fee_rate_sat_vb: MAX_FEE_RATE_SAT_VB,
            network: "testnet4".to_string(),
        }
    }

    pub fn get_vault(&self, vault_id: u64) -> Option<VaultView> {
        self.vaults.get(&vault_id).map(|v| vault_view(vault_id, v))
    }

    pub fn list_vaults(&self, from_index: Option<u64>, limit: Option<u32>) -> Vec<VaultView> {
        let start = from_index.unwrap_or(1).max(1);
        (start..self.next_vault_id)
            .take(limit.unwrap_or(PAGE).min(PAGE) as usize)
            .filter_map(|id| self.get_vault(id))
            .collect()
    }

    pub fn get_spend(&self, vault_id: u64, spend_id: u64) -> Option<SpendView> {
        let vault = self.vaults.get(&vault_id)?;
        let spend = self.spends.get(&(vault_id, spend_id))?;
        Some(spend_view(vault_id, spend_id, vault, spend))
    }

    /// Newest first.
    pub fn list_spends(
        &self,
        vault_id: u64,
        from_index: Option<u64>,
        limit: Option<u32>,
    ) -> Vec<SpendView> {
        let Some(vault) = self.vaults.get(&vault_id) else {
            return Vec::new();
        };
        let newest = vault.next_spend_id.saturating_sub(1);
        let start = from_index.unwrap_or(newest).min(newest);
        (1..=start)
            .rev()
            .take(limit.unwrap_or(PAGE).min(PAGE) as usize)
            .filter_map(|id| {
                let spend = self.spends.get(&(vault_id, id))?;
                Some(spend_view(vault_id, id, vault, spend))
            })
            .collect()
    }
}

impl BtcVault {
    fn vault(&self, vault_id: u64) -> &Vault {
        self.vaults
            .get(&vault_id)
            .unwrap_or_else(|| env::panic_str("vault_not_found"))
    }

    fn spend(&self, vault_id: u64, spend_id: u64) -> &Spend {
        self.spends
            .get(&(vault_id, spend_id))
            .unwrap_or_else(|| env::panic_str("spend_not_found"))
    }

    fn spend_mut(&mut self, vault_id: u64, spend_id: u64) -> &mut Spend {
        self.spends
            .get_mut(&(vault_id, spend_id))
            .unwrap_or_else(|| env::panic_str("spend_not_found"))
    }

    /// While a spend is signing, no other request may use any of its outpoints.
    fn check_no_overlap_while_signing(
        &self,
        vault_id: u64,
        inputs: &[SpendInput],
        except: Option<u64>,
    ) {
        let vault = self.vault(vault_id);
        for id in [vault.open_withdrawal, vault.open_clawback]
            .into_iter()
            .flatten()
        {
            if Some(id) == except {
                continue;
            }
            let other = self.spend(vault_id, id);
            if other.status != SpendStatus::Signing {
                continue;
            }
            let overlaps = inputs.iter().any(|a| {
                other
                    .inputs
                    .iter()
                    .any(|b| a.txid == b.txid && a.vout == b.vout)
            });
            require!(!overlaps, "inputs_overlap");
        }
    }

    /// Refuses a spend whose outpoints and outputs were already sent for signing with other amounts.
    fn check_binding(&self, vault_id: u64, spend: &Spend) {
        if let Some(amounts) = self
            .bound_txs
            .get(&(vault_id, self.binding_of(vault_id, spend)))
        {
            let same = amounts.len() == spend.inputs.len()
                && amounts
                    .iter()
                    .zip(&spend.inputs)
                    .all(|(a, i)| *a == i.amount);
            require!(same, "input_amount_mismatch");
        }
    }

    fn binding_of(&self, vault_id: u64, spend: &Spend) -> [u8; 32] {
        let key = self
            .vault(vault_id)
            .public_key
            .as_deref()
            .unwrap_or_else(|| env::panic_str("key_missing"));
        bitcoin::binding_hash(&spend_tx(spend, &bitcoin::hash160(key)))
    }

    /// The largest fee of a withdrawal that started signing over any of `inputs`, or 0.
    fn signed_withdrawal_fee(&self, vault_id: u64, inputs: &[SpendInput]) -> u64 {
        inputs
            .iter()
            .filter_map(|i| {
                let id = self.withdrawal_outpoints.get(&(vault_id, i.txid, i.vout))?;
                let withdrawal = self.spends.get(&(vault_id, *id))?;
                (withdrawal.sign_round > 0).then_some(withdrawal.fee)
            })
            .max()
            .unwrap_or(0)
    }

    /// Stores a new spend as the vault's open withdrawal or claw-back and announces it.
    fn open_spend(&mut self, vault_id: u64, spend: Spend) -> u64 {
        let vault = self
            .vaults
            .get_mut(&vault_id)
            .unwrap_or_else(|| env::panic_str("vault_not_found"));
        let id = vault.next_spend_id;
        vault.next_spend_id += 1;
        match spend.kind {
            SpendKind::Withdrawal => vault.open_withdrawal = Some(id),
            SpendKind::Clawback => vault.open_clawback = Some(id),
        }
        let event = match spend.kind {
            SpendKind::Withdrawal => "withdrawal_requested",
            SpendKind::Clawback => "clawback_requested",
        };
        events::emit(
            event,
            json!({
                "vault_id": vault_id,
                "spend_id": id,
                "requested_by": spend.requested_by,
                "destination": spend.destination,
                "amount": U64(spend.amount),
                "change": U64(spend.change),
                "fee": U64(spend.fee),
                "effective_at_ms": spend.effective_at_ms,
                "inputs": spend.inputs.iter().map(|i| json!({
                    "txid": hex::encode(i.txid),
                    "vout": i.vout,
                    "amount": U64(i.amount),
                })).collect::<Vec<_>>(),
            }),
        );
        self.spends.insert((vault_id, id), spend);
        id
    }

    fn close_spend(&mut self, vault_id: u64, spend_id: u64) {
        if let Some(vault) = self.vaults.get_mut(&vault_id) {
            if vault.open_withdrawal == Some(spend_id) {
                vault.open_withdrawal = None;
            }
            if vault.open_clawback == Some(spend_id) {
                vault.open_clawback = None;
            }
        }
    }

    /// Asks the signer for every input still unsigned, each over the BIP143 hash built here from
    /// the stored spend, and joins the answers into one `on_signed` callback.
    fn sign_spend(&mut self, vault_id: u64, spend_id: u64, before: u64) -> Promise {
        let vault = self.vault(vault_id);
        let public_key = vault
            .public_key
            .clone()
            .unwrap_or_else(|| env::panic_str("key_missing"));
        let path = vault.path.clone();
        let pubkey_hash = bitcoin::hash160(&public_key);
        let spend = self.spend(vault_id, spend_id);
        let tx = spend_tx(spend, &pubkey_hash);
        let (indexes, sighashes): (Vec<u32>, Vec<String>) = spend
            .inputs
            .iter()
            .enumerate()
            .filter(|(_, input)| input.signature.is_none())
            .map(|(i, _)| {
                (
                    i as u32,
                    hex::encode(bitcoin::bip143_sighash(&tx, i, &pubkey_hash)),
                )
            })
            .unzip();
        // Re-checked here, not only at request time: another spend may have started signing over
        // the same outpoints, or bound the same transaction, since this one was requested.
        let inputs = spend.inputs.clone();
        let kind = spend.kind;
        let binding = bitcoin::binding_hash(&tx);
        self.check_no_overlap_while_signing(vault_id, &inputs, Some(spend_id));
        match self.bound_txs.get(&(vault_id, binding)) {
            Some(amounts) => require!(
                amounts.iter().eq(inputs.iter().map(|i| &i.amount)),
                "input_amount_mismatch"
            ),
            None => {
                self.bound_txs.insert(
                    (vault_id, binding),
                    inputs.iter().map(|i| i.amount).collect(),
                );
            }
        }
        if kind == SpendKind::Withdrawal {
            for input in &inputs {
                self.withdrawal_outpoints
                    .insert((vault_id, input.txid, input.vout), spend_id);
            }
        }
        let spend = self.spend_mut(vault_id, spend_id);
        spend.status = SpendStatus::Signing;
        spend.sign_round = spend.sign_round.wrapping_add(1);
        spend.sign_started_block = Some(env::block_height());
        let round = spend.sign_round;
        let signer = self.signer_contract.clone();
        let sign = |sighash: &String| {
            Promise::new(signer.clone()).function_call(
                "sign".to_string(),
                json_bytes(&json!({
                    "request": {
                        "path": path,
                        "payload_v2": { "Ecdsa": sighash },
                        "domain_id": 0,
                    }
                })),
                ONE_YOCTO,
                GAS_SIGN,
            )
        };
        let mut joint = sign(&sighashes[0]);
        for sighash in &sighashes[1..] {
            joint = joint.and(sign(sighash));
        }
        let count = indexes.len() as u64;
        self.charge_storage(
            before,
            SIGNATURE_RESERVE_BYTES * count,
            ONE_YOCTO.saturating_mul(u128::from(count)),
        );
        joint.then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_ON_SIGNED)
                .on_signed(vault_id, spend_id, round, indexes, sighashes),
        )
    }

    fn derive_key(&self, vault_id: u64) -> Promise {
        Promise::new(self.signer_contract.clone())
            .function_call(
                "derived_public_key".to_string(),
                json_bytes(&json!({
                    "path": self.vault(vault_id).path,
                    "predecessor": env::current_account_id(),
                    "domain_id": 0,
                })),
                NearToken::from_yoctonear(0),
                GAS_DERIVED_PUBLIC_KEY,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_ON_DERIVED_KEY)
                    .on_derived_key(vault_id),
            )
    }

    /// The caller pays for the storage this call added plus `reserve_bytes` a later callback will
    /// add, and `extra`; the rest of the deposit is refunded.
    fn charge_storage(&mut self, before: u64, reserve_bytes: u64, extra: NearToken) {
        // LookupSet writes through; the maps cache until flushed.
        self.vaults.flush();
        self.spends.flush();
        self.bound_txs.flush();
        self.withdrawal_outpoints.flush();
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

fn parse_inputs(inputs: Vec<InputArg>) -> Vec<SpendInput> {
    require!(
        !inputs.is_empty() && inputs.len() <= MAX_INPUTS,
        "bad_inputs"
    );
    let parsed: Vec<SpendInput> = inputs
        .into_iter()
        .map(|input| SpendInput {
            txid: hex::decode(&input.txid)
                .ok()
                .and_then(|bytes| bytes.try_into().ok())
                .unwrap_or_else(|| env::panic_str("invalid_txid")),
            vout: input.vout,
            amount: input.amount.0,
            signature: None,
        })
        .collect();
    for (i, input) in parsed.iter().enumerate() {
        require!(
            input.amount > 0 && input.amount <= MAX_SATS,
            "bad_input_amount"
        );
        require!(
            !parsed[..i]
                .iter()
                .any(|p| p.txid == input.txid && p.vout == input.vout),
            "duplicate_input"
        );
    }
    parsed
}

fn input_total(inputs: &[SpendInput]) -> u64 {
    // At most 4 inputs of at most 21M BTC each: no overflow.
    inputs.iter().map(|i| i.amount).sum()
}

/// The fee must pay between the relay minimum and the cap for its kind per virtual byte of the
/// signed spend; a claw-back over a signing or signed withdrawal must also outbid it (BIP125).
fn check_fee(spend: &Spend, vault: &Vault, replaces_fee: u64) {
    let public_key = vault
        .public_key
        .as_deref()
        .unwrap_or_else(|| env::panic_str("key_missing"));
    let tx = spend_tx(spend, &bitcoin::hash160(public_key));
    let vsize = bitcoin::estimated_vsize(tx.inputs.len(), &tx.outputs);
    require!(
        spend.fee >= vsize * MIN_FEE_RATE_SAT_VB,
        "fee_below_relay_minimum"
    );
    let cap = match spend.kind {
        SpendKind::Withdrawal => MAX_WITHDRAWAL_FEE_RATE_SAT_VB,
        SpendKind::Clawback => MAX_FEE_RATE_SAT_VB,
    };
    require!(spend.fee <= vsize * cap, "fee_too_high");
    if replaces_fee > 0 {
        require!(
            spend.fee >= replaces_fee + vsize * INCREMENTAL_RELAY_SAT_VB,
            "fee_below_replacement"
        );
    }
}

/// The only transaction a spend can sign: its inputs in order, `amount` to the destination, then
/// change (if any) to the vault's own P2WPKH. Version 2, locktime 0, every input signalling RBF.
fn spend_tx(spend: &Spend, pubkey_hash: &[u8; 20]) -> Tx {
    let mut outputs = vec![TxOut {
        value: spend.amount,
        script: bitcoin::script_for_address(&spend.destination)
            .unwrap_or_else(|| env::panic_str("invalid_btc_address")),
    }];
    if spend.change > 0 {
        outputs.push(TxOut {
            value: spend.change,
            script: bitcoin::p2wpkh_script(pubkey_hash),
        });
    }
    Tx {
        version: bitcoin::TX_VERSION,
        locktime: 0,
        inputs: spend
            .inputs
            .iter()
            .map(|i| TxIn {
                txid: i.txid,
                vout: i.vout,
                amount: i.amount,
                sequence: bitcoin::SEQUENCE_RBF,
            })
            .collect(),
        outputs,
    }
}

/// Reads promise result `index` as the signer's response and checks it recovers to `public_key`
/// over `sighash_hex`.
fn verified_signature(
    index: u64,
    sighash_hex: &str,
    public_key: &[u8],
) -> Result<Signature, &'static str> {
    let bytes = env::promise_result_checked(index, MAX_SIGNATURE_RESPONSE_BYTES)
        .map_err(|_| "sign_failed")?;
    let response: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|_| "bad_signature_response")?;
    let big_r = response["big_r"]["affine_point"]
        .as_str()
        .and_then(|h| hex::decode(h).ok())
        .filter(|b| b.len() == 33)
        .ok_or("bad_signature_response")?;
    let s: [u8; 32] = response["s"]["scalar"]
        .as_str()
        .and_then(|h| hex::decode(h).ok())
        .and_then(|b| b.try_into().ok())
        .ok_or("bad_signature_response")?;
    let recovery_id = response["recovery_id"]
        .as_u64()
        .filter(|v| *v <= 3)
        .ok_or("bad_signature_response")? as u8;
    let hash = hex::decode(sighash_hex).map_err(|_| "bad_signature_response")?;
    let mut rs = [0u8; 64];
    rs[..32].copy_from_slice(&big_r[1..]);
    rs[32..].copy_from_slice(&s);
    // High s is accepted here and normalised when the witness is assembled: Bitcoin relays only low s.
    let xy = env::ecrecover(&hash, &rs, recovery_id, false).ok_or("signature_mismatch")?;
    let mut compressed = vec![0x02 | (xy[63] & 1)];
    compressed.extend_from_slice(&xy[..32]);
    if compressed != public_key {
        return Err("signature_mismatch");
    }
    Ok(Signature {
        big_r,
        s,
        recovery_id,
    })
}

fn vault_view(id: u64, vault: &Vault) -> VaultView {
    VaultView {
        id,
        owner: vault.owner.clone(),
        guardians: vault.guardians.clone(),
        recovery_address: vault.recovery_address.clone(),
        delay_ms: vault.delay_ms,
        path: vault.path.clone(),
        public_key: vault.public_key.as_ref().map(hex::encode),
        address: vault
            .public_key
            .as_ref()
            .map(|k| bitcoin::p2wpkh_address(&bitcoin::hash160(k))),
        open_withdrawal: vault.open_withdrawal,
        open_clawback: vault.open_clawback,
        spend_count: vault.next_spend_id - 1,
        created_at_ms: vault.created_at_ms,
    }
}

fn spend_view(vault_id: u64, id: u64, vault: &Vault, spend: &Spend) -> SpendView {
    let (unsigned_tx, sighashes) = match &vault.public_key {
        Some(key) => {
            let pubkey_hash = bitcoin::hash160(key);
            let tx = spend_tx(spend, &pubkey_hash);
            let sighashes = (0..tx.inputs.len())
                .map(|i| hex::encode(bitcoin::bip143_sighash(&tx, i, &pubkey_hash)))
                .collect();
            (hex::encode(bitcoin::serialize_unsigned(&tx)), sighashes)
        }
        None => (String::new(), Vec::new()),
    };
    SpendView {
        vault_id,
        id,
        kind: spend.kind,
        status: spend.status,
        requested_by: spend.requested_by.clone(),
        requested_at_ms: spend.requested_at_ms,
        effective_at_ms: spend.effective_at_ms,
        destination: spend.destination.clone(),
        amount: U64(spend.amount),
        change: U64(spend.change),
        fee: U64(spend.fee),
        inputs: spend
            .inputs
            .iter()
            .map(|i| InputView {
                txid: hex::encode(i.txid),
                vout: i.vout,
                amount: U64(i.amount),
                signature: i.signature.as_ref().map(|s| SignatureView {
                    big_r: hex::encode(&s.big_r),
                    s: hex::encode(s.s),
                    recovery_id: s.recovery_id,
                }),
            })
            .collect(),
        vetoed_by: spend.vetoed_by.clone(),
        sign_rounds: spend.sign_round,
        signed_at_ms: spend.signed_at_ms,
        unsigned_tx,
        sighashes,
    }
}

fn json_bytes(value: &serde_json::Value) -> Vec<u8> {
    serde_json::to_vec(value).unwrap_or_else(|_| env::panic_str("bad_request"))
}
