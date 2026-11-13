//! Public state and message types. JSON field names here are the wire format the TypeScript side uses.

use near_sdk::json_types::U128;
use near_sdk::{near, AccountId};

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Asset {
    Nep141 {
        token_id: AccountId,
    },
    EvmErc20 {
        chain_id: u64,
        token_address: String,
    },
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Beneficiary {
    pub near_account: AccountId,
    #[serde(default)]
    pub evm_address: Option<String>,
}

/// Public bounds of a sealed plan. The registry enforces them on every sale even if the enclave
/// signs something outside them.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Envelope {
    pub period_ms: u64,
    pub max_amount_per_period: U128,
    pub max_amount_per_tx: U128,
    pub min_price_usd_e6: U128,
    pub min_gap_ms: u64,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Disclosure {
    Realtime,
    Delayed { delay_ms: u64 },
    EndReveal,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum PlanStatus {
    AwaitingAck,
    Active,
    Ended,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ChangeKind {
    Modify,
    Cancel,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct PendingChange {
    pub kind: ChangeKind,
    pub commitment: Option<String>,
    pub envelope: Option<Envelope>,
    pub requested_at_ms: u64,
    pub effective_at_ms: u64,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Plan {
    pub id: u64,
    pub owner: AccountId,
    pub commitment: String,
    pub asset: Asset,
    pub token_decimals: u8,
    pub quote_decimals: u8,
    pub beneficiary: Beneficiary,
    pub envelope: Envelope,
    pub disclosure: Disclosure,
    pub cooling_off_ms: u64,
    pub start_ms: u64,
    pub end_ms: u64,
    pub status: PlanStatus,
    pub created_at_ms: u64,
    pub acked_at_ms: Option<u64>,
    pub acked_by: Option<String>,
    pub plan_account: AccountId,
    pub evm_address: Option<String>,
    pub evm_nonce: u64,
    /// Set while a Chain Signatures request is in flight; one at a time keeps EVM nonces gap-free.
    pub evm_sign_pending: bool,
    pub next_seq: u64,
    pub period_index: u64,
    pub sold_in_period: U128,
    pub sold_total: U128,
    pub last_sale_ms: Option<u64>,
    pub pending_change: Option<PendingChange>,
    pub receipt_count: u64,
    pub label: String,
    /// The only asset sale proceeds may settle into, e.g. "nep141:usdc.near"; quotes must match it.
    pub proceeds_asset: String,
    /// The Chain Signatures request in flight, if any (mirrored by `evm_sign_pending`).
    pub evm_pending_sign: Option<PendingSign>,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PendingSign {
    pub seq: u64,
    /// Block height when the request started; `clear_stale_sign` works from it.
    pub started_block_height: u64,
    /// A re-sign of a finished receipt (failure leaves the receipt as it was) rather than a new one.
    pub resign: bool,
}

/// A 1Click quote signing key, when it may first be used, and when it was replaced (null for
/// the current key). Old keys stay listed so receipts signed under them remain verifiable.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct QuoteSigner {
    pub public_key: String,
    pub registered_at_ms: u64,
    pub active_from_ms: u64,
    pub replaced_at_ms: Option<u64>,
}

/// A 1Click quote payload already used, kept until its deadline so it cannot be used twice.
#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct UsedQuote {
    pub hash: [u8; 32],
    pub deadline_ms: u64,
}

/// The plan a holder can now check against its commitment, published after the plan ended.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Reveal {
    /// The exact canonical JSON the commitment was computed over.
    pub plan_json: String,
    /// Lowercase hex of the 32-byte salt.
    pub salt: String,
    pub revealed_at_ms: u64,
    pub revealed_by: AccountId,
}

#[near(serializers = [json])]
pub struct ProceedsAssetView {
    pub asset_id: String,
    pub decimals: u8,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Measurements {
    pub mrtd: String,
    pub rtmr0: String,
    pub rtmr1: String,
    pub rtmr2: String,
    pub rtmr3: String,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Enclave {
    pub public_key: String,
    pub measurements: Measurements,
    pub quote_hash: String,
    pub registered_at_ms: u64,
    pub active_from_ms: u64,
    pub revoked_at_ms: Option<u64>,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Action {
    Nep141Transfer {
        receiver_id: AccountId,
        amount: U128,
        register_receiver: bool,
    },
    EvmErc20Transfer {
        to: String,
        amount: U128,
        nonce: u64,
        gas_limit: u64,
        max_fee_per_gas: U128,
        max_priority_fee_per_gas: U128,
    },
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Settlement {
    pub venue: String,
    /// The venue's id for the swap (1Click's deposit address or quote id), shown to verifiers.
    /// 1Click does not sign it, so the registry does not bind it to the quote.
    pub correlation_id: String,
    pub deposit_address: String,
    pub min_amount_out: U128,
    pub destination_asset: String,
    pub quote: SignedQuote,
}

/// A 1Click quote as 1Click returns it: `payload` is the stable-stringified quote Q (keys sorted,
/// no spaces) and `signature` is `"ed25519:<base58>"` of 1Click's signature over the UTF-8 text
/// of base58(sha256(Q)). See `oneclick.rs`.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SignedQuote {
    pub payload: String,
    pub signature: String,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Compliance {
    pub within_period_budget: bool,
    pub within_tx_cap: bool,
    pub above_floor: bool,
    pub venue_allowed: bool,
    pub prices_agree: bool,
    pub schedule_ok: bool,
}

impl Compliance {
    pub fn all_true(&self) -> bool {
        self.within_period_budget
            && self.within_tx_cap
            && self.above_floor
            && self.venue_allowed
            && self.prices_agree
            && self.schedule_ok
    }
}

/// What the enclave signs for one sale; `seq` is the replay guard.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct ExecuteRequest {
    pub plan_id: u64,
    pub seq: u64,
    pub commitment: String,
    pub action: Action,
    pub settlement: Settlement,
    pub compliance: Compliance,
    pub issued_at_ms: u64,
    pub expires_at_ms: u64,
}

/// What the enclave signs to accept a plan (or a change) after checking it against the commitment.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct AckMessage {
    #[serde(rename = "type")]
    pub kind: String,
    pub plan_id: u64,
    pub commitment: String,
    pub envelope: Envelope,
    pub within_envelope: bool,
    pub issued_at_ms: u64,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ReceiptKind {
    Sale,
    Release,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ReceiptStatus {
    Pending,
    Done,
    Failed,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct EvmSignature {
    /// Compressed R, 33 bytes hex; r is bytes 1..33.
    pub big_r: String,
    pub s: String,
    pub recovery_id: u8,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Receipt {
    pub plan_id: u64,
    pub seq: u64,
    pub commitment: String,
    pub period_index: u64,
    pub kind: ReceiptKind,
    pub amount: U128,
    pub receiver: String,
    pub action_hash: String,
    /// The exact signed request, so anyone can re-verify the enclave signature from chain data.
    pub request_json: Option<String>,
    pub signature: Option<String>,
    pub enclave_key: Option<String>,
    pub settlement: Option<Settlement>,
    pub status: ReceiptStatus,
    pub evm_nonce: Option<u64>,
    /// Kept so `resign_evm` can rebuild the same transaction with new fees.
    pub evm_gas_limit: Option<u64>,
    /// Fees of the transaction currently signed; a re-sign must raise both by 12.5%.
    pub evm_max_fee_per_gas: Option<U128>,
    pub evm_max_priority_fee_per_gas: Option<U128>,
    /// Block height when the current signature landed; re-signs wait 30 blocks after it.
    pub evm_signed_at_block: Option<u64>,
    /// The 1Click quote key that signed this sale's quote, so the quote stays verifiable after the
    /// key is rotated.
    pub quote_signer: Option<String>,
    pub evm_unsigned_tx: Option<String>,
    pub evm_signature: Option<EvmSignature>,
    pub created_at_ms: u64,
    pub finished_at_ms: Option<u64>,
}

/// Response of the signer's `sign`, as serialised by near/mpc (`#[serde(tag = "scheme")]`).
#[near(serializers = [json])]
#[derive(Clone, Debug)]
#[serde(tag = "scheme")]
pub enum SignatureResponse {
    Secp256k1(K256Signature),
    Ed25519 { signature: Vec<u8> },
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct K256Signature {
    pub big_r: K256AffinePoint,
    pub s: K256Scalar,
    pub recovery_id: u8,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct K256AffinePoint {
    pub affine_point: String,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct K256Scalar {
    pub scalar: String,
}

#[near(serializers = [json])]
pub struct EvmTxPreview {
    pub unsigned_tx: String,
    pub hash: String,
}
