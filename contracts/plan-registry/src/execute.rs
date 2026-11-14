//! Enclave-signed sales and post-end EVM releases. Every limit in the public envelope is checked
//! here again, so a compromised enclave still cannot sell outside it.

use crate::checks;
use crate::events;
use crate::evm::{self, Erc20Transfer};
use crate::oneclick::{self, OneClickQuote};
use crate::plans::{evm_path, json_bytes, MAX_CLOCK_SKEW_MS};
use crate::types::*;
use crate::{
    require_key_notice, PlanRegistry, PlanRegistryExt, ONE_YOCTO, STORAGE_REGISTRATION_DEPOSIT,
};
use near_sdk::json_types::U128;
use near_sdk::serde::Serialize;
use near_sdk::serde_json::{self, json};
use near_sdk::{env, near, require, AccountId, Gas, Promise};

/// Domain prefix of every enclave execution signature.
pub const EXECUTE_DOMAIN: &[u8] = b"glidepath/execute/v1\n";
/// A quote may be valid for at most 7 days. Used quotes are remembered until their deadline, so
/// this bounds how long each entry must be kept.
pub const MAX_QUOTE_TTL_MS: u64 = 7 * 24 * 60 * 60 * 1000;
/// Expired used-quote entries pruned on each `execute`, so the set shrinks as it grows.
const PRUNE_PER_EXECUTE: u32 = 10;
/// A real 1Click quote is about 1.1 KB (26 fields, long asset ids); 4 KB leaves room for new
/// fields and EVM addresses while bounding what the relayer makes us hash and store.
const MAX_QUOTE_PAYLOAD_BYTES: usize = 4096;
/// An execute request embeds the quote payload as an escaped string (up to about 5 KB for a
/// 4 KB payload) plus about 1 KB of its own; the relayer pays to store it in the receipt.
const MAX_EXECUTE_JSON_BYTES: usize = 8192;
/// The only swap type whose `amountIn` is exactly what the plan sends.
const EXACT_INPUT: &str = "EXACT_INPUT";
/// A signature response is ~250 bytes of JSON; anything far larger is not one.
const MAX_SIGNATURE_RESPONSE_BYTES: usize = 1024;
/// A sign whose callback never arrived is cleared after 300 blocks; the signer's own yield times
/// out after about 200, so by then the request can no longer produce a signature.
pub const STALE_SIGN_BLOCKS: u64 = 300;
/// An ERC-20 transfer uses roughly 35-65k gas; 150k leaves room for unusual tokens while capping
/// how much of the plan address's ETH one signed transaction can burn.
pub const MAX_EVM_GAS_LIMIT: u64 = 150_000;
/// 500 gwei is far above normal L1/L2 fees; together with the gas limit it bounds a single
/// transaction's fee at 0.075 ETH even if the enclave or a relayer is hostile.
pub const MAX_FEE_PER_GAS: u128 = 500_000_000_000;
/// Text fields of a settlement are shown to verifiers and stored; these caps bound that storage.
const MAX_SETTLEMENT_FIELD_LEN: usize = 64;
const MAX_CORRELATION_ID_LEN: usize = 128;
/// Storage a later callback adds to a receipt (status, finish time, and for EVM the signature),
/// charged to the relayer up front because callbacks cannot charge anyone.
const RECEIPT_FINISH_RESERVE_BYTES: u64 = 16;
const EVM_SIGNATURE_RESERVE_BYTES: u64 = 192;
/// plan_account.send: one batch of storage_deposit (5 Tgas) + ft_transfer (10 Tgas) + overhead.
const GAS_SEND: Gas = Gas::from_tgas(40);
const GAS_ON_SEND_DONE: Gas = Gas::from_tgas(20);
/// The signer requires at least 15 Tgas; the rest covers its yield callback (7 Tgas live).
const GAS_SIGN: Gas = Gas::from_tgas(50);
/// Parses the response and runs ecrecover (about 3 Tgas measured in total) with wide headroom.
const GAS_ON_SIGNED: Gas = Gas::from_tgas(30);
/// Checked up front so a relayer cannot starve the settlement callback that rolls back failures.
pub const MIN_EXECUTE_GAS: Gas = Gas::from_tgas(150);
/// Room for a re-signed transaction with larger fee fields.
const RESIGN_RESERVE_BYTES: u64 = 32;
/// A re-sign must raise both fees to at least 112.5% of the current ones: the replacement rule
/// most EVM mempools apply, so every re-sign can actually replace the previous transaction, and
/// a re-sign can never lower fees until the broadcast stops mining.
const RESIGN_FEE_BUMP_PER_MILLE: u128 = 1_125;
/// Blocks (about 30 s) a signature must stand before it is replaced, so nobody can keep the
/// plan's single sign slot busy or churn signatures faster than a relayer can broadcast them.
pub const RESIGN_MIN_BLOCKS: u64 = 30;

/// Mirrors `plan_account::FtTransferArgs` field for field (same order), so `action_hash` is the
/// sha256 of the exact `ft_transfer` argument bytes the plan account sends.
#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct FtTransferArgs<'a> {
    receiver_id: &'a AccountId,
    amount: U128,
    memo: Option<&'a str>,
}

#[near]
impl PlanRegistry {
    /// Anyone can relay an enclave-signed sale. `signature` is standard base64 of the 64-byte
    /// ed25519 signature over `"glidepath/execute/v1\n" || request_json`. The deposit pays the
    /// receipt's storage plus what the action forwards (1 yocto, plus 0.00125 NEAR when
    /// registering the receiver); the rest is refunded.
    #[payable]
    pub fn execute(
        &mut self,
        plan_id: u64,
        request_json: String,
        signature: String,
        enclave_key: String,
    ) -> Promise {
        require!(!self.config.paused, "paused");
        let (quote_key, quote_registered_at) = self.active_quote_signer();
        let quote_signer = self
            .config
            .quote_signer
            .as_ref()
            .map(|q| q.public_key.clone());
        let (key, enclave_registered_at) = self.active_enclave_key(&enclave_key);
        require!(request_json.len() <= MAX_EXECUTE_JSON_BYTES, "bad_request");
        checks::verify_signature(
            &key,
            EXECUTE_DOMAIN,
            &request_json,
            &signature,
            "bad_signature",
        );
        let request: ExecuteRequest =
            serde_json::from_str(&request_json).unwrap_or_else(|_| env::panic_str("bad_request"));
        require!(request.plan_id == plan_id, "plan_mismatch");
        require!(env::prepaid_gas() >= MIN_EXECUTE_GAS, "insufficient_gas");

        let before = env::storage_usage();
        let now = env::block_timestamp_ms();
        self.prune_expired_quotes(PRUNE_PER_EXECUTE, now);
        let mut plan = self.plan(plan_id).clone();
        require!(plan.status == PlanStatus::Active, "not_active");
        require_key_notice(enclave_registered_at, &plan, now);
        require_key_notice(quote_registered_at, &plan, now);
        // Once a cancel has taken effect the plan sells nothing more, even before `finalize`.
        if let Some(change) = &plan.pending_change {
            require!(
                change.kind != ChangeKind::Cancel || now < change.effective_at_ms,
                "cancel_effective"
            );
        }
        require!(now >= plan.start_ms, "not_started");
        require!(now < plan.end_ms, "plan_ended");
        // A pending change is not usable until acked, because only `plan.commitment` passes.
        require!(
            request.commitment.to_ascii_lowercase() == plan.commitment,
            "commitment_mismatch"
        );
        require!(request.seq == plan.next_seq, "bad_seq");
        require!(
            request.issued_at_ms <= now.saturating_add(MAX_CLOCK_SKEW_MS)
                && now <= request.expires_at_ms,
            "expired"
        );
        require!(request.compliance.all_true(), "not_compliant");
        validate_settlement(&request.settlement);
        let amount = action_amount(&request.action);
        let receiver = check_action_target(&plan, &request);
        let quote_deadline = check_quote(&quote_key, &plan, &request, amount, &receiver, now);
        let quote_hash = env::sha256_array(request.settlement.quote.payload.as_bytes());
        require!(!self.used_quotes.contains_key(&quote_hash), "quote_used");

        require!(amount > 0, "bad_request");
        require!(
            amount <= plan.envelope.max_amount_per_tx.0,
            "tx_cap_exceeded"
        );
        let period_index = (now - plan.start_ms) / plan.envelope.period_ms;
        if period_index != plan.period_index {
            plan.period_index = period_index;
            plan.sold_in_period = U128(0);
        }
        let sold_in_period = checks::checked_add(plan.sold_in_period.0, amount);
        require!(
            sold_in_period <= plan.envelope.max_amount_per_period.0,
            "period_cap_exceeded"
        );
        if let Some(last) = plan.last_sale_ms {
            require!(
                now.saturating_sub(last) >= plan.envelope.min_gap_ms,
                "gap_too_short"
            );
        }
        require!(
            checks::meets_floor(&plan, amount, request.settlement.min_amount_out.0),
            "below_floor"
        );

        let seq = plan.next_seq;
        plan.next_seq += 1;
        plan.sold_in_period = U128(sold_in_period);
        plan.sold_total = U128(checks::checked_add(plan.sold_total.0, amount));
        plan.last_sale_ms = Some(now);
        plan.receipt_count += 1;

        let mut receipt = Receipt {
            plan_id,
            seq,
            commitment: plan.commitment.clone(),
            period_index,
            kind: ReceiptKind::Sale,
            amount: U128(amount),
            receiver: receiver.clone(),
            action_hash: String::new(),
            request_json: Some(request_json),
            signature: Some(signature),
            enclave_key: Some(enclave_key.clone()),
            settlement: Some(request.settlement.clone()),
            quote_signer,
            status: ReceiptStatus::Pending,
            evm_nonce: None,
            evm_gas_limit: None,
            evm_max_fee_per_gas: None,
            evm_max_priority_fee_per_gas: None,
            evm_signed_at_block: None,
            evm_unsigned_tx: None,
            evm_signature: None,
            created_at_ms: now,
            finished_at_ms: None,
        };

        let (promise, reserve, forwarded) = match &request.action {
            Action::Nep141Transfer {
                receiver_id,
                register_receiver,
                ..
            } => {
                let Asset::Nep141 { token_id } = &plan.asset else {
                    env::panic_str("wrong_asset")
                };
                let memo = format!("glidepath/{plan_id}/{seq}");
                let ft_args = serde_json::to_vec(&FtTransferArgs {
                    receiver_id,
                    amount: U128(amount),
                    memo: Some(&memo),
                })
                .unwrap_or_else(|_| env::panic_str("bad_request"));
                receipt.action_hash = hex::encode(env::sha256_array(&ft_args));
                let forwarded = if *register_receiver {
                    STORAGE_REGISTRATION_DEPOSIT.saturating_add(ONE_YOCTO)
                } else {
                    ONE_YOCTO
                };
                let promise = Promise::new(plan.plan_account.clone())
                    .function_call(
                        "send".to_string(),
                        json_bytes(&json!({
                            "token": token_id,
                            "receiver_id": receiver_id,
                            "amount": U128(amount),
                            "memo": memo,
                            "register_receiver": register_receiver,
                        })),
                        forwarded,
                        GAS_SEND,
                    )
                    .then(
                        Self::ext(env::current_account_id())
                            .with_static_gas(GAS_ON_SEND_DONE)
                            .on_send_done(plan_id, seq),
                    );
                (promise, RECEIPT_FINISH_RESERVE_BYTES, forwarded)
            }
            Action::EvmErc20Transfer {
                to,
                nonce,
                gas_limit,
                max_fee_per_gas,
                max_priority_fee_per_gas,
                ..
            } => {
                let fees = EvmFees {
                    nonce: *nonce,
                    gas_limit: *gas_limit,
                    max_fee_per_gas: max_fee_per_gas.0,
                    max_priority_fee_per_gas: max_priority_fee_per_gas.0,
                };
                let to = evm::normalize_address(to)
                    .unwrap_or_else(|| env::panic_str("invalid_evm_address"));
                let promise = self.start_evm_signing(&mut plan, &mut receipt, &to, amount, &fees);
                (promise, EVM_SIGNATURE_RESERVE_BYTES, ONE_YOCTO)
            }
        };

        self.record_used_quote(quote_hash, quote_deadline);
        events::emit(
            "executed",
            json!({
                "plan_id": plan_id,
                "seq": seq,
                "kind": receipt.kind,
                "amount": receipt.amount,
                "receiver": receipt.receiver,
                "action_hash": receipt.action_hash,
                "period_index": period_index,
                "enclave_key": enclave_key,
                "venue": request.settlement.venue,
                "correlation_id": request.settlement.correlation_id,
            }),
        );
        self.receipts.insert((plan_id, seq), receipt);
        self.plans.insert(plan_id, plan);
        self.charge_storage(before, reserve, forwarded);
        promise
    }

    /// Owner or beneficiary, after the plan ended: signs an ERC-20 transfer from the plan's derived
    /// address to `beneficiary.evm_address` only. Same nonce and fee caps as sales.
    #[payable]
    pub fn release_evm(
        &mut self,
        plan_id: u64,
        amount: U128,
        nonce: u64,
        gas_limit: u64,
        max_fee_per_gas: U128,
        max_priority_fee_per_gas: U128,
    ) -> Promise {
        require!(env::prepaid_gas() >= MIN_EXECUTE_GAS, "insufficient_gas");
        let before = env::storage_usage();
        let now = env::block_timestamp_ms();
        let caller = env::predecessor_account_id();
        let mut plan = self.plan(plan_id).clone();
        // Anyone could otherwise burn the plan address's ETH on fees with pointless releases.
        require!(
            caller == plan.owner || caller == plan.beneficiary.near_account,
            "only_owner_or_beneficiary"
        );
        require!(plan.status == PlanStatus::Ended, "not_ended");
        require!(matches!(plan.asset, Asset::EvmErc20 { .. }), "wrong_asset");
        let to = plan
            .beneficiary
            .evm_address
            .clone()
            .unwrap_or_else(|| env::panic_str("no_evm_beneficiary"));
        require!(amount.0 > 0, "bad_request");

        let seq = plan.next_seq;
        plan.next_seq += 1;
        plan.receipt_count += 1;
        let mut receipt = Receipt {
            plan_id,
            seq,
            commitment: plan.commitment.clone(),
            period_index: plan.period_index,
            kind: ReceiptKind::Release,
            amount,
            receiver: to.clone(),
            action_hash: String::new(),
            request_json: None,
            signature: None,
            enclave_key: None,
            settlement: None,
            quote_signer: None,
            status: ReceiptStatus::Pending,
            evm_nonce: None,
            evm_gas_limit: None,
            evm_max_fee_per_gas: None,
            evm_max_priority_fee_per_gas: None,
            evm_signed_at_block: None,
            evm_unsigned_tx: None,
            evm_signature: None,
            created_at_ms: now,
            finished_at_ms: None,
        };
        let fees = EvmFees {
            nonce,
            gas_limit,
            max_fee_per_gas: max_fee_per_gas.0,
            max_priority_fee_per_gas: max_priority_fee_per_gas.0,
        };
        let promise = self.start_evm_signing(&mut plan, &mut receipt, &to, amount.0, &fees);
        events::emit(
            "executed",
            json!({
                "plan_id": plan_id,
                "seq": seq,
                "kind": receipt.kind,
                "amount": amount,
                "receiver": to,
                "action_hash": receipt.action_hash,
                "period_index": receipt.period_index,
            }),
        );
        self.receipts.insert((plan_id, seq), receipt);
        self.plans.insert(plan_id, plan);
        self.charge_storage(before, EVM_SIGNATURE_RESERVE_BYTES, ONE_YOCTO);
        promise
    }

    /// Owner or beneficiary only. Re-signs the plan's latest EVM transaction (sale or release)
    /// with higher fees, keeping its recipient, amount, nonce and gas limit, for a transaction
    /// that was never mined because fees rose. Both fees must rise by at least 12.5% and stay
    /// under the caps, and the current signature must be at least 30 blocks old. On success the
    /// receipt's signature, transaction and action_hash are replaced; on failure they are kept.
    #[payable]
    pub fn resign_evm(
        &mut self,
        plan_id: u64,
        seq: u64,
        max_fee_per_gas: U128,
        max_priority_fee_per_gas: U128,
    ) -> Promise {
        require!(env::prepaid_gas() >= MIN_EXECUTE_GAS, "insufficient_gas");
        let before = env::storage_usage();
        let mut plan = self.plan(plan_id).clone();
        let caller = env::predecessor_account_id();
        require!(
            caller == plan.owner || caller == plan.beneficiary.near_account,
            "only_owner_or_beneficiary"
        );
        require!(matches!(plan.asset, Asset::EvmErc20 { .. }), "wrong_asset");
        let receipt = self
            .receipts
            .get(&(plan_id, seq))
            .cloned()
            .unwrap_or_else(|| env::panic_str("receipt_not_found"));
        let (Some(nonce), Some(gas_limit)) = (receipt.evm_nonce, receipt.evm_gas_limit) else {
            env::panic_str("wrong_asset")
        };
        require!(receipt.status == ReceiptStatus::Done, "not_done");
        require!(plan.evm_nonce == nonce + 1, "not_latest");
        require!(plan.evm_pending_sign.is_none(), "sign_pending");
        let signed_at = receipt.evm_signed_at_block.unwrap_or_default();
        require!(
            env::block_height() >= signed_at.saturating_add(RESIGN_MIN_BLOCKS),
            "too_soon"
        );
        let fees = EvmFees {
            nonce,
            gas_limit,
            max_fee_per_gas: max_fee_per_gas.0,
            max_priority_fee_per_gas: max_priority_fee_per_gas.0,
        };
        check_fees(&fees);
        let bumped = |new: u128, old: Option<U128>| {
            new.saturating_mul(1_000)
                >= old
                    .unwrap_or(U128(0))
                    .0
                    .saturating_mul(RESIGN_FEE_BUMP_PER_MILLE)
        };
        require!(
            bumped(fees.max_fee_per_gas, receipt.evm_max_fee_per_gas)
                && bumped(
                    fees.max_priority_fee_per_gas,
                    receipt.evm_max_priority_fee_per_gas
                ),
            "fee_bump_too_small"
        );
        let unsigned = build_unsigned(&plan, &receipt.receiver, receipt.amount.0, &fees);
        let hash = env::keccak256_array(&unsigned);
        set_pending_sign(&mut plan, seq, true);
        let promise = self.sign_request(plan_id, hash).then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_ON_SIGNED)
                .on_resigned(
                    plan_id,
                    seq,
                    hex::encode(&unsigned),
                    max_fee_per_gas,
                    max_priority_fee_per_gas,
                ),
        );
        self.plans.insert(plan_id, plan);
        self.charge_storage(before, RESIGN_RESERVE_BYTES, ONE_YOCTO);
        promise
    }

    /// Anyone. If a signature request has been pending for more than `STALE_SIGN_BLOCKS` (its
    /// callback was lost), fails it with the normal rollback so the plan is not stuck.
    pub fn clear_stale_sign(&mut self, plan_id: u64) {
        let plan = self.plan_mut(plan_id);
        let pending = plan
            .evm_pending_sign
            .unwrap_or_else(|| env::panic_str("no_sign_pending"));
        require!(
            env::block_height()
                > pending
                    .started_block_height
                    .saturating_add(STALE_SIGN_BLOCKS),
            "sign_not_stale"
        );
        clear_pending_sign(plan);
        if pending.resign {
            events::emit(
                "resign_failed",
                json!({ "plan_id": plan_id, "seq": pending.seq, "reason": "sign_stale" }),
            );
        } else {
            self.finish_receipt(plan_id, pending.seq, None, "sign_stale");
        }
    }

    /// Reads the raw result so a large return value cannot make this callback panic.
    #[private]
    pub fn on_send_done(&mut self, plan_id: u64, seq: u64) -> bool {
        // Only success or failure matters; a large return value is still a completed transfer.
        let ok = !matches!(
            env::promise_result_checked(0, 0),
            Err(near_sdk::PromiseError::Failed)
        );
        let pending = self
            .receipts
            .get(&(plan_id, seq))
            .is_some_and(|r| r.status == ReceiptStatus::Pending);
        if pending {
            self.finish_receipt(plan_id, seq, ok.then_some(None), "ft_transfer_failed");
        }
        ok
    }

    /// Accepts the signature only if it recovers to the plan's own address; anything else
    /// (timeout, malformed response, wrong key) fails the sale with the normal rollback.
    #[private]
    pub fn on_signed(&mut self, plan_id: u64, seq: u64) -> Option<EvmSignature> {
        let plan = self.plans.get(&plan_id)?;
        // A late callback for a request already cleared as stale changes nothing.
        if !is_pending_sign(plan, seq, false) {
            return None;
        }
        let hash = self
            .receipts
            .get(&(plan_id, seq))
            .map(|r| r.action_hash.clone())
            .unwrap_or_default();
        let outcome = verified_signature(plan, &hash);
        clear_pending_sign(self.plan_mut(plan_id));
        match outcome {
            Ok(signature) => {
                self.finish_receipt(plan_id, seq, Some(Some(signature.clone())), "");
                Some(signature)
            }
            Err(reason) => {
                self.finish_receipt(plan_id, seq, None, reason);
                None
            }
        }
    }

    #[private]
    pub fn on_resigned(
        &mut self,
        plan_id: u64,
        seq: u64,
        unsigned_tx: String,
        max_fee_per_gas: U128,
        max_priority_fee_per_gas: U128,
    ) -> Option<EvmSignature> {
        let plan = self.plans.get(&plan_id)?;
        if !is_pending_sign(plan, seq, true) {
            return None;
        }
        let hash = hex::encode(env::keccak256_array(
            hex::decode(&unsigned_tx).unwrap_or_default(),
        ));
        let outcome = verified_signature(plan, &hash);
        clear_pending_sign(self.plan_mut(plan_id));
        match outcome {
            Ok(signature) => {
                let mut old_action_hash = String::new();
                if let Some(receipt) = self.receipts.get_mut(&(plan_id, seq)) {
                    old_action_hash = std::mem::replace(&mut receipt.action_hash, hash.clone());
                    receipt.evm_unsigned_tx = Some(unsigned_tx);
                    receipt.evm_signature = Some(signature.clone());
                    receipt.evm_max_fee_per_gas = Some(max_fee_per_gas);
                    receipt.evm_max_priority_fee_per_gas = Some(max_priority_fee_per_gas);
                    receipt.evm_signed_at_block = Some(env::block_height());
                }
                events::emit(
                    "resigned",
                    json!({
                        "plan_id": plan_id,
                        "seq": seq,
                        "old_action_hash": old_action_hash,
                        "action_hash": hash,
                        "evm_signature": signature,
                    }),
                );
                Some(signature)
            }
            Err(reason) => {
                events::emit(
                    "resign_failed",
                    json!({ "plan_id": plan_id, "seq": seq, "reason": reason }),
                );
                None
            }
        }
    }

    /// Unsigned EIP-1559 bytes and keccak256 the registry would sign for `action` (plain hex).
    pub fn evm_tx_preview(&self, plan_id: u64, action: Action) -> EvmTxPreview {
        let plan = self.plan(plan_id);
        let Action::EvmErc20Transfer {
            to,
            amount,
            nonce,
            gas_limit,
            max_fee_per_gas,
            max_priority_fee_per_gas,
        } = action
        else {
            env::panic_str("wrong_asset")
        };
        let to =
            evm::normalize_address(&to).unwrap_or_else(|| env::panic_str("invalid_evm_address"));
        let unsigned = build_unsigned(
            plan,
            &to,
            amount.0,
            &EvmFees {
                nonce,
                gas_limit,
                max_fee_per_gas: max_fee_per_gas.0,
                max_priority_fee_per_gas: max_priority_fee_per_gas.0,
            },
        );
        EvmTxPreview {
            hash: hex::encode(env::keccak256_array(&unsigned)),
            unsigned_tx: hex::encode(unsigned),
        }
    }
}

struct EvmFees {
    nonce: u64,
    gas_limit: u64,
    max_fee_per_gas: u128,
    max_priority_fee_per_gas: u128,
}

impl PlanRegistry {
    /// Builds and hashes the transaction itself, then asks the signer for path `plan/<id>`. Only
    /// one signature may be in flight per plan, so a failed one can always return its nonce.
    fn start_evm_signing(
        &self,
        plan: &mut Plan,
        receipt: &mut Receipt,
        to: &str,
        amount: u128,
        fees: &EvmFees,
    ) -> Promise {
        require!(plan.evm_address.is_some(), "evm_address_missing");
        require!(plan.evm_pending_sign.is_none(), "sign_pending");
        require!(fees.nonce == plan.evm_nonce, "bad_nonce");
        check_fees(fees);
        let unsigned = build_unsigned(plan, to, amount, fees);
        let hash = env::keccak256_array(&unsigned);
        plan.evm_nonce += 1;
        set_pending_sign(plan, receipt.seq, false);
        receipt.evm_nonce = Some(fees.nonce);
        receipt.evm_gas_limit = Some(fees.gas_limit);
        receipt.evm_max_fee_per_gas = Some(U128(fees.max_fee_per_gas));
        receipt.evm_max_priority_fee_per_gas = Some(U128(fees.max_priority_fee_per_gas));
        receipt.action_hash = hex::encode(hash);
        receipt.evm_unsigned_tx = Some(hex::encode(&unsigned));
        self.sign_request(plan.id, hash).then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_ON_SIGNED)
                .on_signed(plan.id, receipt.seq),
        )
    }

    fn sign_request(&self, plan_id: u64, hash: [u8; 32]) -> Promise {
        Promise::new(self.config.signer_contract.clone()).function_call(
            "sign".to_string(),
            json_bytes(&json!({
                "request": {
                    "path": evm_path(plan_id),
                    "payload_v2": { "Ecdsa": hex::encode(hash) },
                    "domain_id": 0,
                }
            })),
            ONE_YOCTO,
            GAS_SIGN,
        )
    }

    /// Settles a receipt. `outcome` is `Some(signature)` on success and `None` on failure; a
    /// failed sale gives back its budget (the seq stays used) and, if nothing was signed after
    /// it, its EVM nonce.
    fn finish_receipt(
        &mut self,
        plan_id: u64,
        seq: u64,
        outcome: Option<Option<EvmSignature>>,
        failure_reason: &str,
    ) {
        let now = env::block_timestamp_ms();
        // Callbacks must not panic: a missing receipt is simply nothing to settle.
        let Some(mut receipt) = self.receipts.get(&(plan_id, seq)).cloned() else {
            return;
        };
        receipt.finished_at_ms = Some(now);
        match outcome {
            Some(signature) => {
                receipt.status = ReceiptStatus::Done;
                if signature.is_some() {
                    receipt.evm_signed_at_block = Some(env::block_height());
                }
                receipt.evm_signature = signature;
                events::emit(
                    "settled",
                    json!({
                        "plan_id": plan_id,
                        "seq": seq,
                        "kind": receipt.kind,
                        "evm_signature": receipt.evm_signature,
                    }),
                );
            }
            None => {
                receipt.status = ReceiptStatus::Failed;
                let plan = self.plan_mut(plan_id);
                roll_back(plan, &receipt);
                events::emit(
                    "settle_failed",
                    json!({
                        "plan_id": plan_id,
                        "seq": seq,
                        "kind": receipt.kind,
                        "reason": failure_reason,
                    }),
                );
            }
        }
        self.receipts.insert((plan_id, seq), receipt);
    }
}

fn set_pending_sign(plan: &mut Plan, seq: u64, resign: bool) {
    plan.evm_pending_sign = Some(PendingSign {
        seq,
        started_block_height: env::block_height(),
        resign,
    });
    plan.evm_sign_pending = true;
}

fn clear_pending_sign(plan: &mut Plan) {
    plan.evm_pending_sign = None;
    plan.evm_sign_pending = false;
}

fn is_pending_sign(plan: &Plan, seq: u64, resign: bool) -> bool {
    plan.evm_pending_sign
        .is_some_and(|p| p.seq == seq && p.resign == resign)
}

fn check_fees(fees: &EvmFees) {
    require!(fees.gas_limit > 0, "bad_request");
    require!(
        fees.gas_limit <= MAX_EVM_GAS_LIMIT
            && fees.max_fee_per_gas <= MAX_FEE_PER_GAS
            && fees.max_priority_fee_per_gas <= fees.max_fee_per_gas,
        "gas_too_high"
    );
}

/// Parses the signer's response (promise result 0) and checks with ecrecover (low s required)
/// that it signs `hash_hex` for the plan's own address. Returns the failure reason otherwise.
pub(crate) fn verified_signature(
    plan: &Plan,
    hash_hex: &str,
) -> Result<EvmSignature, &'static str> {
    let bytes =
        env::promise_result_checked(0, MAX_SIGNATURE_RESPONSE_BYTES).map_err(|_| "sign_failed")?;
    let response: SignatureResponse =
        serde_json::from_slice(&bytes).map_err(|_| "bad_signature_response")?;
    let SignatureResponse::Secp256k1(sig) = response else {
        return Err("bad_signature_response");
    };
    let big_r = hex::decode(&sig.big_r.affine_point).map_err(|_| "bad_signature_response")?;
    let s = hex::decode(&sig.s.scalar).map_err(|_| "bad_signature_response")?;
    let hash = hex::decode(hash_hex).map_err(|_| "bad_signature_response")?;
    if big_r.len() != 33 || s.len() != 32 || hash.len() != 32 || sig.recovery_id > 3 {
        return Err("bad_signature_response");
    }
    let mut rs = [0u8; 64];
    rs[..32].copy_from_slice(&big_r[1..]);
    rs[32..].copy_from_slice(&s);
    let key = env::ecrecover(&hash, &rs, sig.recovery_id, true).ok_or("signature_mismatch")?;
    if plan.evm_address.as_deref() != Some(evm::address_from_xy(&key).as_str()) {
        return Err("signature_mismatch");
    }
    Ok(EvmSignature {
        big_r: hex::encode(&big_r),
        s: hex::encode(&s),
        recovery_id: sig.recovery_id,
    })
}

/// Binds the sale to a quote 1Click signed in its own format (verified on a live quote,
/// 2026-11-11): a real, non-dry EXACT_INPUT swap of exactly this amount of the plan's
/// token, deposited at the action's receiver, paying the beneficiary in the plan's proceeds asset
/// with this minimum output, refunding to the plan itself, unexpired, and costing no more than
/// the fee bound. Without this a compromised enclave could name itself as both receiver and
/// deposit address. `settlement.correlation_id` is not bound: 1Click does not sign it.
pub(crate) fn check_quote(
    key: &[u8; 32],
    plan: &Plan,
    request: &ExecuteRequest,
    amount: u128,
    receiver: &str,
    now: u64,
) -> u64 {
    let settlement = &request.settlement;
    let signed = &settlement.quote;
    require!(signed.payload.len() <= MAX_QUOTE_PAYLOAD_BYTES, "bad_quote");
    require!(
        oneclick::verify_signature(key, &signed.payload, &signed.signature),
        "bad_quote_signature"
    );
    let quote: OneClickQuote =
        serde_json::from_str(&signed.payload).unwrap_or_else(|_| env::panic_str("bad_quote"));
    // A refund must come back to the plan, or a quote that is made to fail would hand the
    // principal to whoever the refund address names.
    let (deposit_matches, refund_matches, origin_matches) = match &plan.asset {
        Asset::Nep141 { token_id } => (
            quote.deposit_address == receiver,
            quote.refund_to == plan.plan_account.as_str(),
            quote.origin_asset == format!("nep141:{token_id}"),
        ),
        // 1Click's asset ids for bridged ERC-20s (e.g. `nep141:eth-0x….omft.near`) come from its
        // token list and cannot be derived on-chain from chain id and address, so the origin is
        // not bound; the deposit address and amount still are.
        Asset::EvmErc20 { .. } => (
            evm::normalize_address(&quote.deposit_address).as_deref() == Some(receiver),
            plan.evm_address.is_some()
                && evm::normalize_address(&quote.refund_to) == plan.evm_address,
            true,
        ),
    };
    require!(
        !quote.dry
            && quote.swap_type == EXACT_INPUT
            && deposit_matches
            && refund_matches
            && origin_matches
            && quote.amount.0 == amount
            && quote.amount_in.0 == amount
            && quote.min_amount_out == settlement.min_amount_out
            && quote.recipient == plan.beneficiary.near_account.as_str()
            && quote.destination_asset == settlement.destination_asset
            && settlement.destination_asset == plan.proceeds_asset,
        "quote_mismatch"
    );
    let deadline_ms = oneclick::parse_timestamp_ms(&quote.deadline)
        .unwrap_or_else(|| env::panic_str("bad_quote"));
    require!(now <= deadline_ms, "quote_expired");
    require!(
        deadline_ms <= now.saturating_add(MAX_QUOTE_TTL_MS),
        "quote_deadline_too_far"
    );
    let usd =
        |value: &str| oneclick::parse_usd_e12(value).unwrap_or_else(|| env::panic_str("bad_quote"));
    let within_bound =
        oneclick::cost_within_bound(usd(&quote.amount_in_usd), usd(&quote.amount_out_usd))
            .unwrap_or_else(|| env::panic_str("bad_quote"));
    require!(within_bound, "quote_fee_too_high");
    // Not in the registry deployed on testnet (2026-11-12); its quotes all route on-chain.
    require!(oneclick::routes_on_chain(&signed.payload), "quote_routing");
    deadline_ms
}

fn roll_back(plan: &mut Plan, receipt: &Receipt) {
    if receipt.kind == ReceiptKind::Sale {
        if plan.period_index == receipt.period_index {
            plan.sold_in_period = U128(plan.sold_in_period.0.saturating_sub(receipt.amount.0));
        }
        plan.sold_total = U128(plan.sold_total.0.saturating_sub(receipt.amount.0));
    }
    if let Some(nonce) = receipt.evm_nonce {
        if plan.evm_nonce == nonce + 1 {
            plan.evm_nonce = nonce;
        }
    }
}

fn build_unsigned(plan: &Plan, to: &str, amount: u128, fees: &EvmFees) -> Vec<u8> {
    let Asset::EvmErc20 {
        chain_id,
        token_address,
    } = &plan.asset
    else {
        env::panic_str("wrong_asset")
    };
    let token =
        evm::address_bytes(token_address).unwrap_or_else(|| env::panic_str("invalid_evm_address"));
    let to = evm::address_bytes(to).unwrap_or_else(|| env::panic_str("invalid_evm_address"));
    evm::unsigned_erc20_transfer(&Erc20Transfer {
        chain_id: *chain_id,
        nonce: fees.nonce,
        max_priority_fee_per_gas: fees.max_priority_fee_per_gas,
        max_fee_per_gas: fees.max_fee_per_gas,
        gas_limit: fees.gas_limit,
        token: &token,
        to: &to,
        amount,
    })
}

fn action_amount(action: &Action) -> u128 {
    match action {
        Action::Nep141Transfer { amount, .. } | Action::EvmErc20Transfer { amount, .. } => amount.0,
    }
}

/// The action must match the plan's asset, and the settlement's deposit address must be the
/// action's receiver, so the enclave cannot sign a quote for one address and pay another.
fn check_action_target(plan: &Plan, request: &ExecuteRequest) -> String {
    match (&plan.asset, &request.action) {
        (Asset::Nep141 { .. }, Action::Nep141Transfer { receiver_id, .. }) => {
            require!(
                request.settlement.deposit_address == receiver_id.as_str(),
                "receiver_mismatch"
            );
            receiver_id.to_string()
        }
        (Asset::EvmErc20 { .. }, Action::EvmErc20Transfer { to, .. }) => {
            let to =
                evm::normalize_address(to).unwrap_or_else(|| env::panic_str("invalid_evm_address"));
            require!(
                evm::normalize_address(&request.settlement.deposit_address).as_deref()
                    == Some(to.as_str()),
                "receiver_mismatch"
            );
            to
        }
        _ => env::panic_str("wrong_asset"),
    }
}

fn validate_settlement(settlement: &Settlement) {
    require!(
        settlement.venue.len() <= MAX_SETTLEMENT_FIELD_LEN
            && settlement.deposit_address.len() <= MAX_SETTLEMENT_FIELD_LEN
            && settlement.correlation_id.len() <= MAX_CORRELATION_ID_LEN
            && settlement.destination_asset.len() <= MAX_CORRELATION_ID_LEN,
        "bad_request"
    );
}
