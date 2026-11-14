//! Public state and message types. JSON field names here are the wire format the TypeScript side
//! uses (`packages/trust`).

use near_sdk::json_types::U128;
use near_sdk::{near, AccountId};

/// What the public can rely on whatever the sealed mandate says. The contract checks every trade
/// against it, so a compromised enclave still cannot trade outside it.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct TrustEnvelope {
    /// 1Click asset ids (e.g. "nep141:oil.near") the trust may never buy.
    pub excluded_assets: Vec<String>,
    pub period_ms: u64,
    /// Turnover cap per period in USD × 10^6, measured by the USD value 1Click signs in each
    /// quote (`amountInUsd`), so no price oracle is needed.
    pub max_turnover_usd_e6: U128,
    pub min_gap_ms: u64,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum TrustStatus {
    AwaitingAck,
    Active,
    Ended,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ChangeKind {
    Envelope,
    Cancel,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct PendingChange {
    pub kind: ChangeKind,
    pub envelope: Option<TrustEnvelope>,
    pub requested_at_ms: u64,
    pub effective_at_ms: u64,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Trust {
    pub id: u64,
    /// The official. Can propose envelope changes and cancel, both after a public cooling-off;
    /// has no method that moves or trades assets.
    pub owner: AccountId,
    /// sha256(canonical_json(mandate) ‖ salt), lowercase hex.
    pub commitment: String,
    pub envelope: TrustEnvelope,
    /// Receives everything the trust holds at the end of the term or after a cancel.
    pub beneficiary: AccountId,
    pub trust_account: AccountId,
    pub cooling_off_ms: u64,
    /// Period counting starts here (creation).
    pub start_ms: u64,
    pub end_ms: u64,
    pub status: TrustStatus,
    pub created_at_ms: u64,
    pub acked_at_ms: Option<u64>,
    pub acked_by: Option<String>,
    /// NEP-141 tokens the trust may hold and so sell: those named at creation plus every token a
    /// trade bought.
    pub holdings: Vec<AccountId>,
    pub next_seq: u64,
    pub period_index: u64,
    pub turnover_in_period_usd_e6: U128,
    pub last_trade_ms: Option<u64>,
    pub pending_change: Option<PendingChange>,
    pub ended_at_ms: Option<u64>,
    pub label: String,
}

/// A 1Click quote as 1Click returns it: `payload` is the stable-stringified quote Q and
/// `signature` is `"ed25519:<base58>"` over the text of base58(sha256(Q)).
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SignedQuote {
    pub payload: String,
    pub signature: String,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Settlement {
    pub venue: String,
    /// 1Click's id for the swap; not signed by 1Click, shown to verifiers only.
    pub correlation_id: String,
    pub deposit_address: String,
    pub quote: SignedQuote,
}

/// The enclave's yes/no statements about a trade. The contract checks the last two itself; the
/// first only the sealed mandate can answer.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Attestation {
    pub within_mandate: bool,
    pub not_excluded: bool,
    pub within_turnover: bool,
}

impl Attestation {
    pub fn all_true(&self) -> bool {
        self.within_mandate && self.not_excluded && self.within_turnover
    }
}

/// What the enclave signs for one trade; `seq` is the replay guard.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct TradeRequest {
    pub trust_id: u64,
    pub seq: u64,
    pub commitment: String,
    pub origin_token: AccountId,
    pub amount: U128,
    pub settlement: Settlement,
    pub attestation: Attestation,
    pub issued_at_ms: u64,
    pub expires_at_ms: u64,
}

/// What the enclave signs to accept a trust after opening its sealed mandate.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct TrustAck {
    #[serde(rename = "type")]
    pub kind: String,
    pub trust_id: u64,
    pub commitment: String,
    pub envelope: TrustEnvelope,
    /// The public facts the sealed mandate was checked against, so an ack for one trust's terms
    /// can never activate a trust with another beneficiary, term or account.
    pub beneficiary: AccountId,
    pub end_ms: u64,
    pub trust_account: AccountId,
    pub within_envelope: bool,
    pub issued_at_ms: u64,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ReceiptKind {
    Trade,
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
#[derive(Clone, Debug)]
pub struct Receipt {
    pub trust_id: u64,
    pub seq: u64,
    pub kind: ReceiptKind,
    pub commitment: String,
    pub period_index: u64,
    /// The token that left the trust account (a trade's origin, or the released token).
    pub token: AccountId,
    /// Base units sent to 1Click; 0 for a release (the trust account sends its whole balance).
    pub amount: U128,
    /// The 1Click deposit address, or the beneficiary for a release.
    pub receiver: String,
    pub destination_asset: Option<String>,
    /// The turnover this trade counted, from the quote's signed `amountInUsd` (rounded up).
    pub turnover_usd_e6: U128,
    /// sha256 of the exact `ft_transfer` arguments the trust account sent.
    pub action_hash: String,
    /// The exact signed request, so anyone can re-verify the enclave signature from chain data.
    pub request_json: Option<String>,
    pub signature: Option<String>,
    pub enclave_key: Option<String>,
    pub quote_signer: Option<String>,
    /// The trade added the bought token to the holdings; a failure removes it again.
    pub added_holding: bool,
    pub status: ReceiptStatus,
    pub created_at_ms: u64,
    pub finished_at_ms: Option<u64>,
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

/// A 1Click quote signing key, when it may first be used, and when it was replaced.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct QuoteSigner {
    pub public_key: String,
    pub registered_at_ms: u64,
    pub active_from_ms: u64,
    pub replaced_at_ms: Option<u64>,
}

/// A quote payload already used, kept until its deadline so it cannot be used twice.
#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct UsedQuote {
    pub hash: [u8; 32],
    pub deadline_ms: u64,
}
