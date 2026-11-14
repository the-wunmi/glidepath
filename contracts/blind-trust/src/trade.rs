//! Enclave-signed trades. Every rule of the public envelope is checked here again, so a
//! compromised enclave still cannot buy an excluded asset, pay anyone but the trust, or trade
//! faster or more than the envelope allows.

use crate::oneclick::{self, OneClickQuote};
use crate::types::*;
use crate::{
    apply_due_change, cancel_effective, events, json_bytes, require_key_notice, verify_signature,
    BlindTrust, BlindTrustExt, MAX_ASSET_ID_LEN, MAX_CLOCK_SKEW_MS, MAX_HOLDINGS, ONE_YOCTO,
    STORAGE_REGISTRATION_DEPOSIT,
};
use near_sdk::json_types::U128;
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::serde_json::{self, json};
use near_sdk::{env, near, require, AccountId, Gas, Promise};

/// Domain prefix of every enclave trade signature (distinct from the registry's sales).
pub const TRADE_DOMAIN: &[u8] = b"vsp/trust-trade/v1\n";
/// A quote may be valid for at most 7 days; used quotes are remembered until their deadline.
pub const MAX_QUOTE_TTL_MS: u64 = 7 * 24 * 60 * 60 * 1000;
/// Bound on one `prune_used_quotes` call, so it always fits in a transaction's gas.
pub const MAX_PRUNE: u32 = 100;
const PRUNE_PER_TRADE: u32 = 10;
/// A real 1Click quote is about 1.1 KB; 4 KB leaves room while bounding what is hashed and stored.
const MAX_QUOTE_PAYLOAD_BYTES: usize = 4096;
/// The quote payload escaped inside the request plus about 1 KB of the request's own fields.
const MAX_TRADE_JSON_BYTES: usize = 8192;
const MAX_SETTLEMENT_FIELD_LEN: usize = 128;
/// The only swap type whose `amountIn` is exactly what the trust sends.
const EXACT_INPUT: &str = "EXACT_INPUT";
/// `minAmountOut` may sit at most 1% under `amountOut`: the most a trade can lose to slippage
/// beyond the fee bound.
pub const MAX_SLIPPAGE_BPS: u128 = 100;
const BPS: u128 = 10_000;
/// The trust account's `send`: storage_deposit (5 Tgas) + ft_transfer (10 Tgas) + overhead.
const GAS_SEND: Gas = Gas::from_tgas(40);
const GAS_ON_TRADE_DONE: Gas = Gas::from_tgas(20);
/// NEP-145 `storage_deposit` on the bought token, registering the trust account.
const GAS_REGISTER: Gas = Gas::from_tgas(10);
/// Starts the send and its callback after a registration.
const GAS_ON_REGISTERED: Gas = Gas::from_tgas(80);
/// Checked up front so a relayer cannot starve the callbacks that roll a failed trade back.
pub const MIN_TRADE_GAS: Gas = Gas::from_tgas(150);
/// The smallest trade, in USD × 10^6 of the quote's signed `amountInUsd`: $10. Withdrawal fees are
/// near-flat, so many tiny trades could spend the turnover cap on fees; with the proportional fee
/// bound below, every trade loses at most 0.5% of itself.
pub const MIN_TRADE_USD_E6: u128 = 10_000_000;
/// A trust's quote may cost at most 50 bps of its input value, with no flat part (the registry's
/// bound adds $1, which on a $10 trade would be 10%).
pub const TRUST_COST_MAX_BPS: u128 = 50;
/// Status and finish time a callback writes later, paid by the relayer up front.
const RECEIPT_FINISH_RESERVE_BYTES: u64 = 16;
/// 1e-12 USD per 1e-6 USD.
const USD_E12_PER_E6: u128 = 1_000_000;

/// Mirrors plan_account's `FtTransferArgs` field for field, so `action_hash` is the sha256 of the
/// exact `ft_transfer` argument bytes the trust account sends.
#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct FtTransferArgs<'a> {
    receiver_id: &'a AccountId,
    amount: U128,
    memo: Option<&'a str>,
}

/// The one quote field the registry's struct does not read.
#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde", rename_all = "camelCase")]
struct AmountOut {
    amount_out: U128,
}

/// What a checked quote tells the trade.
struct CheckedQuote {
    destination_asset: String,
    destination_token: AccountId,
    turnover_usd_e6: u128,
    deadline_ms: u64,
}

#[near]
impl BlindTrust {
    /// Anyone can relay an enclave-signed trade. `signature` is standard base64 of the ed25519
    /// signature over `"vsp/trust-trade/v1\n" || request_json`. The deposit pays the receipt's
    /// storage plus what the trust account forwards (registering 1Click's deposit address and
    /// one yocto); the rest is refunded.
    #[payable]
    pub fn trade(
        &mut self,
        trust_id: u64,
        request_json: String,
        signature: String,
        enclave_key: String,
    ) -> Promise {
        require!(!self.config.paused, "paused");
        let (quote_signer, quote_key) = self.active_quote_signer();
        let (key, enclave_registered_at) = self.active_enclave_key(&enclave_key);
        require!(request_json.len() <= MAX_TRADE_JSON_BYTES, "bad_request");
        verify_signature(
            &key,
            TRADE_DOMAIN,
            &request_json,
            &signature,
            "bad_signature",
        );
        let request: TradeRequest =
            serde_json::from_str(&request_json).unwrap_or_else(|_| env::panic_str("bad_request"));
        require!(request.trust_id == trust_id, "trust_mismatch");
        require!(env::prepaid_gas() >= MIN_TRADE_GAS, "insufficient_gas");

        let before = env::storage_usage();
        let now = env::block_timestamp_ms();
        self.prune_expired_quotes(PRUNE_PER_TRADE, now);
        let mut trust = self.trust(trust_id).clone();
        apply_due_change(&mut trust, now);
        require!(trust.status == TrustStatus::Active, "not_active");
        require_key_notice(enclave_registered_at, &trust, now);
        // A quote key decides where a trade's deposit goes, so only keys the official could see
        // when the trust was made may act for it; a later rotation never applies to this trust.
        require!(
            quote_signer.registered_at_ms < trust.created_at_ms,
            "key_too_new_for_trust"
        );
        require!(!cancel_effective(&trust, now), "cancel_effective");
        require!(now < trust.end_ms, "trust_ended");
        require!(
            request.commitment.to_ascii_lowercase() == trust.commitment,
            "commitment_mismatch"
        );
        require!(request.seq == trust.next_seq, "bad_seq");
        require!(
            request.issued_at_ms <= now.saturating_add(MAX_CLOCK_SKEW_MS)
                && now <= request.expires_at_ms,
            "expired"
        );
        require!(request.attestation.all_true(), "not_compliant");
        validate_settlement(&request.settlement);
        let amount = request.amount.0;
        require!(amount > 0, "bad_request");
        // Only a token the trust holds can leave it; anything else it would not have.
        require!(
            trust.holdings.contains(&request.origin_token),
            "origin_not_held"
        );
        let deposit: AccountId = request
            .settlement
            .deposit_address
            .parse()
            .unwrap_or_else(|_| env::panic_str("bad_request"));
        let quoted = check_quote(&quote_key, &trust, &request, now);
        let quote_hash = env::sha256_array(request.settlement.quote.payload.as_bytes());
        require!(!self.used_quotes.contains_key(&quote_hash), "quote_used");

        let period_index = (now - trust.start_ms) / trust.envelope.period_ms;
        if period_index != trust.period_index {
            trust.period_index = period_index;
            trust.turnover_in_period_usd_e6 = U128(0);
        }
        let turnover = trust
            .turnover_in_period_usd_e6
            .0
            .checked_add(quoted.turnover_usd_e6)
            .unwrap_or_else(|| env::panic_str("amount_overflow"));
        require!(
            turnover <= trust.envelope.max_turnover_usd_e6.0,
            "turnover_cap_exceeded"
        );
        if let Some(last) = trust.last_trade_ms {
            require!(
                now.saturating_sub(last) >= trust.envelope.min_gap_ms,
                "gap_too_short"
            );
        }
        // A token bought for the first time becomes a holding now (so a concurrent trade cannot
        // take the last slot) and is removed again if the trade fails.
        let added_holding = !trust.holdings.contains(&quoted.destination_token);
        if added_holding {
            require!(trust.holdings.len() < MAX_HOLDINGS, "too_many_holdings");
            trust.holdings.push(quoted.destination_token.clone());
        }

        let seq = trust.next_seq;
        trust.next_seq += 1;
        trust.turnover_in_period_usd_e6 = U128(turnover);
        trust.last_trade_ms = Some(now);

        let memo = format!("vsp/trust/{trust_id}/{seq}");
        let ft_args = serde_json::to_vec(&FtTransferArgs {
            receiver_id: &deposit,
            amount: U128(amount),
            memo: Some(&memo),
        })
        .unwrap_or_else(|_| env::panic_str("bad_request"));
        let receipt = Receipt {
            trust_id,
            seq,
            kind: ReceiptKind::Trade,
            commitment: trust.commitment.clone(),
            period_index,
            token: request.origin_token.clone(),
            amount: U128(amount),
            receiver: deposit.to_string(),
            destination_asset: Some(quoted.destination_asset.clone()),
            turnover_usd_e6: U128(quoted.turnover_usd_e6),
            action_hash: hex(&env::sha256_array(&ft_args)),
            request_json: Some(request_json),
            signature: Some(signature),
            enclave_key: Some(enclave_key.clone()),
            quote_signer: Some(quote_signer.public_key),
            added_holding,
            status: ReceiptStatus::Pending,
            created_at_ms: now,
            finished_at_ms: None,
        };
        // 1Click's deposit addresses are fresh accounts, so the trust account registers each one.
        // A token the trust has not held gets the trust account registered on it first: NEP-141
        // transfers to an unregistered account fail, and 1Click would then hold the proceeds.
        let send_cost = STORAGE_REGISTRATION_DEPOSIT.saturating_add(ONE_YOCTO);
        let (promise, forwarded) = if added_holding {
            let promise = Promise::new(quoted.destination_token.clone())
                .function_call(
                    "storage_deposit".to_string(),
                    json_bytes(&json!({
                        "account_id": trust.trust_account,
                        "registration_only": true,
                    })),
                    STORAGE_REGISTRATION_DEPOSIT,
                    GAS_REGISTER,
                )
                .then(
                    Self::ext(env::current_account_id())
                        .with_static_gas(GAS_ON_REGISTERED)
                        .on_registered(trust_id, seq),
                );
            (
                promise,
                send_cost.saturating_add(STORAGE_REGISTRATION_DEPOSIT),
            )
        } else {
            (send_trade(&trust.trust_account, &receipt), send_cost)
        };

        self.record_used_quote(quote_hash, quoted.deadline_ms);
        events::emit(
            "trust_traded",
            json!({
                "trust_id": trust_id,
                "seq": seq,
                "period_index": period_index,
                "enclave_key": enclave_key,
                "correlation_id": request.settlement.correlation_id,
                "action_hash": receipt.action_hash,
            }),
        );
        self.receipts.insert((trust_id, seq), receipt);
        self.trusts.insert(trust_id, trust);
        self.charge_trade_storage(before, forwarded);
        promise
    }

    /// After the trust account was registered on the bought token: sends, or fails the trade.
    #[private]
    pub fn on_registered(&mut self, trust_id: u64, seq: u64) -> Option<Promise> {
        let registered = env::promise_result_checked(0, 0).is_ok()
            || matches!(
                env::promise_result_checked(0, 0),
                Err(near_sdk::PromiseError::TooLong(_))
            );
        let receipt = self.receipts.get(&(trust_id, seq)).cloned()?;
        if receipt.status != ReceiptStatus::Pending {
            return None;
        }
        if !registered {
            self.fail_trade(trust_id, receipt, "registration_failed");
            return None;
        }
        let account = self.trusts.get(&trust_id)?.trust_account.clone();
        Some(send_trade(&account, &receipt))
    }

    /// Settles a trade's receipt. A failed send gives back its turnover (the seq stays used).
    #[private]
    pub fn on_trade_done(&mut self, trust_id: u64, seq: u64) -> bool {
        let ok = !matches!(
            env::promise_result_checked(0, 0),
            Err(near_sdk::PromiseError::Failed)
        );
        // Callbacks must not panic: a missing or settled receipt is simply nothing to do.
        let Some(mut receipt) = self.receipts.get(&(trust_id, seq)).cloned() else {
            return ok;
        };
        if receipt.status != ReceiptStatus::Pending {
            return ok;
        }
        if !ok {
            self.fail_trade(trust_id, receipt, "ft_transfer_failed");
            return ok;
        }
        receipt.finished_at_ms = Some(env::block_timestamp_ms());
        receipt.status = ReceiptStatus::Done;
        events::emit("trust_settled", json!({ "trust_id": trust_id, "seq": seq }));
        self.receipts.insert((trust_id, seq), receipt);
        ok
    }
}

/// The trust account's transfer of a receipt's tokens to 1Click, then its settlement callback.
fn send_trade(trust_account: &AccountId, receipt: &Receipt) -> Promise {
    Promise::new(trust_account.clone())
        .function_call(
            "send".to_string(),
            json_bytes(&json!({
                "token": receipt.token,
                "receiver_id": receipt.receiver,
                "amount": receipt.amount,
                "memo": format!("vsp/trust/{}/{}", receipt.trust_id, receipt.seq),
                "register_receiver": true,
            })),
            STORAGE_REGISTRATION_DEPOSIT.saturating_add(ONE_YOCTO),
            GAS_SEND,
        )
        .then(
            BlindTrust::ext(env::current_account_id())
                .with_static_gas(GAS_ON_TRADE_DONE)
                .on_trade_done(receipt.trust_id, receipt.seq),
        )
}

impl BlindTrust {
    /// A failed trade gives back its turnover and, if it added the bought token as a holding,
    /// frees that slot. The seq stays used.
    fn fail_trade(&mut self, trust_id: u64, mut receipt: Receipt, reason: &str) {
        let seq = receipt.seq;
        receipt.status = ReceiptStatus::Failed;
        receipt.finished_at_ms = Some(env::block_timestamp_ms());
        if let Some(trust) = self.trusts.get_mut(&trust_id) {
            if trust.period_index == receipt.period_index {
                trust.turnover_in_period_usd_e6 = U128(
                    trust
                        .turnover_in_period_usd_e6
                        .0
                        .saturating_sub(receipt.turnover_usd_e6.0),
                );
            }
            let bought = receipt
                .destination_asset
                .as_deref()
                .and_then(|a| a.strip_prefix("nep141:"));
            if receipt.added_holding {
                trust.holdings.retain(|t| Some(t.as_str()) != bought);
            }
        }
        events::emit(
            "trust_settle_failed",
            json!({ "trust_id": trust_id, "seq": seq, "reason": reason }),
        );
        self.receipts.insert((trust_id, seq), receipt);
    }

    fn charge_trade_storage(&mut self, before: u64, forwarded: near_sdk::NearToken) {
        // The callback's write is paid now: callbacks cannot charge anyone.
        let reserve = env::storage_byte_cost()
            .saturating_mul(u128::from(RECEIPT_FINISH_RESERVE_BYTES))
            .saturating_add(forwarded);
        self.charge_storage(before, reserve);
    }
}

/// Binds the 1Click quote to this trust and this trade: signed by the registered quote key, live
/// exact-input for exactly this amount of a held token, deposited where the trust sends, paying
/// and refunding only the trust account, into an asset that is not excluded, at a bounded cost.
fn check_quote(key: &[u8; 32], trust: &Trust, request: &TradeRequest, now: u64) -> CheckedQuote {
    let signed = &request.settlement.quote;
    require!(signed.payload.len() <= MAX_QUOTE_PAYLOAD_BYTES, "bad_quote");
    require!(
        oneclick::verify_signature(key, &signed.payload, &signed.signature),
        "bad_quote_signature"
    );
    let quote: OneClickQuote =
        serde_json::from_str(&signed.payload).unwrap_or_else(|_| env::panic_str("bad_quote"));
    let out: AmountOut =
        serde_json::from_str(&signed.payload).unwrap_or_else(|_| env::panic_str("bad_quote"));
    let trust_account = trust.trust_account.as_str();
    // INTENTS routing would leave proceeds or refunds inside intents.near, out of reach.
    require!(oneclick::routes_on_chain(&signed.payload), "quote_routing");
    // Proceeds and refunds can only come back to the trust: a trade that pays someone else, or a
    // quote made to fail so its refund goes elsewhere, would move assets out.
    require!(
        quote.recipient == trust_account && quote.refund_to == trust_account,
        "pays_outside_trust"
    );
    require!(
        !quote.dry
            && quote.swap_type == EXACT_INPUT
            && quote.deposit_address == request.settlement.deposit_address
            && quote.origin_asset == format!("nep141:{}", request.origin_token)
            && quote.amount.0 == request.amount.0
            && quote.amount_in.0 == request.amount.0,
        "quote_mismatch"
    );
    let destination = quote.destination_asset;
    require!(
        !trust.envelope.excluded_assets.contains(&destination),
        "excluded_asset"
    );
    let destination_token: AccountId = destination
        .strip_prefix("nep141:")
        .filter(|_| destination.len() <= MAX_ASSET_ID_LEN)
        .and_then(|id| id.parse().ok())
        .unwrap_or_else(|| env::panic_str("unsupported_asset"));
    require!(destination_token != request.origin_token, "quote_mismatch");
    // minAmountOut ≥ amountOut × (10^4 − 100) / 10^4, rounded down as 1Click rounds its own
    // minAmountOut down; comparing without the division would refuse its exact 1% quotes.
    let slippage_ok = out
        .amount_out
        .0
        .checked_mul(BPS - MAX_SLIPPAGE_BPS)
        .is_some_and(|floor| quote.min_amount_out.0 >= floor / BPS);
    require!(slippage_ok, "slippage_too_high");
    let deadline_ms = oneclick::parse_timestamp_ms(&quote.deadline)
        .unwrap_or_else(|| env::panic_str("bad_quote"));
    require!(now <= deadline_ms, "quote_expired");
    require!(
        deadline_ms <= now.saturating_add(MAX_QUOTE_TTL_MS),
        "quote_deadline_too_far"
    );
    let usd =
        |value: &str| oneclick::parse_usd_e12(value).unwrap_or_else(|| env::panic_str("bad_quote"));
    let amount_in_usd_e12 = usd(&quote.amount_in_usd);
    // cost × 10^4 ≤ in × 50, cost = in − out (0 when out exceeds in): no division, no rounding.
    let cost = amount_in_usd_e12.saturating_sub(usd(&quote.amount_out_usd));
    let within_bound = cost
        .checked_mul(BPS)
        .zip(amount_in_usd_e12.checked_mul(TRUST_COST_MAX_BPS))
        .is_some_and(|(cost, allowed)| cost <= allowed);
    require!(within_bound, "quote_fee_too_high");
    // Rounded up, so the turnover counted is never less than the value 1Click signed.
    let turnover_usd_e6 = amount_in_usd_e12.div_ceil(USD_E12_PER_E6);
    require!(turnover_usd_e6 >= MIN_TRADE_USD_E6, "trade_too_small");
    CheckedQuote {
        destination_asset: destination,
        destination_token,
        turnover_usd_e6,
        deadline_ms,
    }
}

fn validate_settlement(settlement: &Settlement) {
    require!(
        settlement.venue == "1click"
            && settlement.deposit_address.len() <= MAX_SETTLEMENT_FIELD_LEN
            && settlement.correlation_id.len() <= MAX_SETTLEMENT_FIELD_LEN,
        "bad_request"
    );
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
