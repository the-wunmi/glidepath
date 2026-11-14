//! The blind trust (prototype): a sealed mandate the official cannot see, a keyless trust account,
//! and enclave-signed trades the contract checks against the public envelope.

use integration_tests::*;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::NearToken;
use near_workspaces::{Account, AccountId, Contract};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};

const TRADE_DOMAIN: &str = "vsp/trust-trade/v1\n";
const ACK_DOMAIN: &str = "vsp/trust-ack/v1\n";
/// Long enough to try a change before it applies, short enough to wait out in the sandbox.
const COOLING_OFF_MS: u64 = 10_000;
/// A day; the turnover test uses a short period so the sandbox can reach the next one quickly.
const PERIOD_MS: u64 = DAY_MS;
const SHORT_PERIOD_MS: u64 = 300_000;
/// $1 in USD × 10^6.
const USD: u128 = 1_000_000;
const TRADE_DEPOSIT: NearToken = NearToken::from_millinear(100);
static QUOTES: AtomicU64 = AtomicU64::new(0);

struct Trust {
    env: Env,
    contract: Contract,
    idx: Contract,
    bond: Contract,
    oil: Contract,
    id: u64,
    account: AccountId,
}

/// The envelope every test starts with: oil excluded, $500 of turnover a day, no minimum gap.
fn envelope(excluded: &[&AccountId], cap_usd: u128, min_gap_ms: u64) -> Value {
    envelope_with_period(excluded, cap_usd, min_gap_ms, PERIOD_MS)
}

fn envelope_with_period(
    excluded: &[&AccountId],
    cap_usd: u128,
    min_gap_ms: u64,
    period_ms: u64,
) -> Value {
    let excluded: Vec<String> = excluded.iter().map(|t| format!("nep141:{t}")).collect();
    json!({
        "excluded_assets": excluded,
        "period_ms": period_ms,
        "max_turnover_usd_e6": (cap_usd * USD).to_string(),
        "min_gap_ms": min_gap_ms,
    })
}

async fn deploy_trust_contract(env: &Env) -> anyhow::Result<Contract> {
    let config: Value = env.registry.view("get_config").await?.json()?;
    let contract = subaccount(&env.root, "trust", 30)
        .await?
        .deploy(&wasm("blind_trust.wasm")?)
        .await?
        .into_result()?;
    contract
        .call("new")
        .args_json(json!({
            "governance": env.governance.id(),
            "min_cooling_off_ms": 1_000,
            "enclave_activation_delay_ms": 1_000,
            "account_code_hash": config["plan_account_code_hash"],
        }))
        .transact()
        .await?
        .into_result()?;
    env.governance
        .call(contract.id(), "register_enclave")
        .args_json(json!({
            "public_key": env.enclave.public_key(),
            "measurements": {
                "mrtd": "aa".repeat(48), "rtmr0": "bb".repeat(48), "rtmr1": "cc".repeat(48),
                "rtmr2": "dd".repeat(48), "rtmr3": "ee".repeat(48),
            },
            "quote_hash": "ab".repeat(32),
        }))
        .deposit(NearToken::from_millinear(50))
        .transact()
        .await?
        .into_result()?;
    env.governance
        .call(contract.id(), "set_quote_signer")
        .args_json(json!({ "public_key": env.quote_signer.public_key() }))
        .transact()
        .await?
        .into_result()?;
    let now = env.now_ms().await?;
    env.advance_to(now + 1_000).await?;
    Ok(contract)
}

/// A trust holding 1,000 IDX, acked by the enclave, with the given envelope and a one-year term.
async fn active_trust(envelope_of: impl Fn(&Contract) -> Value) -> anyhow::Result<Trust> {
    let env = Env::new().await?;
    let contract = deploy_trust_contract(&env).await?;
    let owner = env.owner.id().clone();
    let idx = env
        .deploy_token("idx", 18, vec![(owner.clone(), 1_000 * ONE_TOKEN)])
        .await?;
    let bond = env.deploy_token("bond", 18, vec![]).await?;
    let oil = env.deploy_token("oil", 18, vec![]).await?;
    let envelope = envelope_of(&oil);
    let now = env.now_ms().await?;
    let id: u64 = env
        .owner
        .call(contract.id(), "create_trust")
        .args_json(json!({
            "commitment": "11".repeat(32),
            "envelope": envelope,
            "beneficiary": env.beneficiary.id(),
            "cooling_off_ms": COOLING_OFF_MS,
            "end_ms": now + 365 * DAY_MS,
            "holdings": [idx.id()],
            "label": "Blind trust",
        }))
        .deposit(NearToken::from_millinear(200))
        .max_gas()
        .transact()
        .await?
        .into_result()?
        .json()?;
    let account: AccountId = format!("t{id}.{}", contract.id()).parse()?;
    fund(&env.owner, &idx, &account, 1_000 * ONE_TOKEN).await?;
    let trust = Trust {
        env,
        contract,
        idx,
        bond,
        oil,
        id,
        account,
    };
    trust.ack(&trust.env.enclave).await?.into_result()?;
    Ok(trust)
}

/// The official moves tokens in the ordinary NEP-141 way: register the account, then transfer.
async fn fund(
    from: &Account,
    token: &Contract,
    to: &AccountId,
    amount: u128,
) -> anyhow::Result<()> {
    from.call(token.id(), "storage_deposit")
        .args_json(json!({ "account_id": to, "registration_only": true }))
        .deposit(NearToken::from_millinear(10))
        .transact()
        .await?
        .into_result()?;
    from.call(token.id(), "ft_transfer")
        .args_json(json!({ "receiver_id": to, "amount": amount.to_string() }))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

/// The quote terms 1Click would give for selling `amount` IDX into `destination` for $2 a token,
/// paying and refunding the trust.
struct Quote {
    /// What 1Click keeps, in bps of the input value.
    fee_bps: u128,
    /// Applied to the payload before it is signed.
    edit: Option<fn(&mut Value)>,
    origin: String,
    destination: String,
    amount: u128,
    usd: u128,
    recipient: String,
    refund_to: String,
    deposit_address: String,
}

impl Trust {
    fn quote(&self, destination: &Contract, amount: u128) -> Quote {
        Quote {
            fee_bps: 20,
            edit: None,
            origin: format!("nep141:{}", self.idx.id()),
            destination: format!("nep141:{}", destination.id()),
            amount,
            usd: amount * 2 * USD / ONE_TOKEN,
            recipient: self.account.to_string(),
            refund_to: self.account.to_string(),
            deposit_address: self.env.venue.id().to_string(),
        }
    }

    async fn ack(&self, enclave: &TestEnclave) -> anyhow::Result<ExecutionFinalResult> {
        self.ack_with(enclave, |_| {}).await
    }

    /// An ack of the trust's own terms, edited before it is signed.
    async fn ack_with(
        &self,
        enclave: &TestEnclave,
        edit: impl Fn(&mut Value),
    ) -> anyhow::Result<ExecutionFinalResult> {
        let trust = self.view().await?;
        let mut ack = json!({
            "type": "trust_ack",
            "trust_id": self.id,
            "commitment": trust["commitment"],
            "envelope": trust["envelope"],
            "beneficiary": trust["beneficiary"],
            "end_ms": trust["end_ms"],
            "trust_account": trust["trust_account"],
            "within_envelope": true,
            "issued_at_ms": self.env.now_ms().await?,
        });
        edit(&mut ack);
        let ack = ack.to_string();
        Ok(self
            .env
            .relayer
            .call(self.contract.id(), "ack_trust")
            .args_json(json!({
                "trust_id": self.id,
                "ack_json": ack,
                "signature": enclave.sign(ACK_DOMAIN, &ack),
                "enclave_key": enclave.public_key(),
            }))
            .transact()
            .await?)
    }

    async fn view(&self) -> anyhow::Result<Value> {
        Ok(self
            .contract
            .view("get_trust")
            .args_json(json!({ "trust_id": self.id }))
            .await?
            .json()?)
    }

    async fn receipts(&self) -> anyhow::Result<Vec<Value>> {
        Ok(self
            .contract
            .view("get_receipts")
            .args_json(json!({ "trust_id": self.id }))
            .await?
            .json()?)
    }

    /// A signed 1Click quote for `q`, in 1Click's format, with a deadline unique to this call.
    async fn signed_quote(&self, q: &Quote, signer: &TestEnclave) -> anyhow::Result<Value> {
        let unique = QUOTES.fetch_add(1, Ordering::Relaxed);
        let terms = QuoteTerms {
            origin_asset: q.origin.clone(),
            destination_asset: q.destination.clone(),
            deposit_address: q.deposit_address.clone(),
            amount: q.amount,
            amount_out: q.amount * 2 / 5,
            min_amount_out: q.amount * 2 / 5 * 99 / 100,
            amount_in_usd_e12: q.usd * USD,
            amount_out_usd_e12: q.usd * USD * (10_000 - q.fee_bps) / 10_000,
            recipient: q.recipient.clone(),
            refund_to: q.refund_to.clone(),
            deadline_ms: self.env.now_ms().await? + 600_000 + unique,
            dry: false,
            swap_type: "EXACT_INPUT".to_string(),
        };
        let mut payload = quote_payload(&terms);
        if let Some(edit) = q.edit {
            edit(&mut payload);
        }
        let payload = stable_stringify(&payload);
        Ok(json!({ "signature": signer.sign_quote(&payload), "payload": payload }))
    }

    async fn request(&self, q: &Quote, seq: u64) -> anyhow::Result<Value> {
        let now = self.env.now_ms().await?;
        Ok(json!({
            "trust_id": self.id,
            "seq": seq,
            "commitment": "11".repeat(32),
            "origin_token": q.origin.trim_start_matches("nep141:"),
            "amount": q.amount.to_string(),
            "settlement": {
                "venue": "1click",
                "correlation_id": "quote-0001",
                "deposit_address": q.deposit_address,
                "quote": self.signed_quote(q, &self.env.quote_signer).await?,
            },
            "attestation": { "within_mandate": true, "not_excluded": true, "within_turnover": true },
            "issued_at_ms": now,
            "expires_at_ms": now + 300_000,
        }))
    }

    async fn relay(
        &self,
        request: &Value,
        enclave: &TestEnclave,
    ) -> anyhow::Result<ExecutionFinalResult> {
        let json = request.to_string();
        self.relay_signed(&json, &enclave.sign(TRADE_DOMAIN, &json), enclave)
            .await
    }

    async fn relay_signed(
        &self,
        json: &str,
        signature: &str,
        enclave: &TestEnclave,
    ) -> anyhow::Result<ExecutionFinalResult> {
        Ok(self
            .env
            .relayer
            .call(self.contract.id(), "trade")
            .args_json(json!({
                "trust_id": self.id,
                "request_json": json,
                "signature": signature,
                "enclave_key": enclave.public_key(),
            }))
            .deposit(TRADE_DEPOSIT)
            .max_gas()
            .transact()
            .await?)
    }

    /// Signs and relays a trade of `q` at the trust's next sequence number.
    async fn trade(&self, q: &Quote) -> anyhow::Result<ExecutionFinalResult> {
        let seq = self.view().await?["next_seq"].as_u64().unwrap_or_default();
        let request = self.request(q, seq).await?;
        self.relay(&request, &self.env.enclave).await
    }

    async fn balance(&self, token: &Contract, account: &AccountId) -> anyhow::Result<u128> {
        self.env.ft_balance(token.id(), account).await
    }
}

fn default_trust(oil: &Contract) -> Value {
    envelope(&[oil.id()], 500, 60_000)
}

#[tokio::test]
async fn a_compliant_trade_sends_to_1click_and_counts_its_turnover() -> anyhow::Result<()> {
    let t = active_trust(default_trust).await?;
    let q = t.quote(&t.bond, 100 * ONE_TOKEN);
    t.trade(&q).await?.into_result()?;

    let receipts = t.receipts().await?;
    assert_eq!(receipts.len(), 1);
    assert_eq!(receipts[0]["status"], "done");
    assert_eq!(receipts[0]["kind"], "trade");
    assert_eq!(
        receipts[0]["destination_asset"],
        json!(format!("nep141:{}", t.bond.id()))
    );
    assert_eq!(
        receipts[0]["turnover_usd_e6"],
        json!((200 * USD).to_string())
    );
    // action_hash is sha256 of the exact ft_transfer arguments the trust account sent.
    let ft_args = format!(
        r#"{{"receiver_id":"{}","amount":"{}","memo":"vsp/trust/{}/0"}}"#,
        t.env.venue.id(),
        100 * ONE_TOKEN,
        t.id
    );
    assert_eq!(
        receipts[0]["action_hash"],
        json!(sha256_hex(ft_args.as_bytes()))
    );
    assert_eq!(t.balance(&t.idx, t.env.venue.id()).await?, 100 * ONE_TOKEN);
    assert_eq!(t.balance(&t.idx, &t.account).await?, 900 * ONE_TOKEN);
    let trust = t.view().await?;
    assert_eq!(
        trust["turnover_in_period_usd_e6"],
        json!((200 * USD).to_string())
    );
    assert_eq!(trust["next_seq"], 1);
    // The bought token is now a holding, so the trust may later sell it or release it.
    assert_eq!(trust["holdings"], json!([t.idx.id(), t.bond.id()]));
    Ok(())
}

#[tokio::test]
async fn a_trade_into_an_excluded_asset_is_refused() -> anyhow::Result<()> {
    let t = active_trust(default_trust).await?;
    let result = t.trade(&t.quote(&t.oil, 10 * ONE_TOKEN)).await?;
    assert_refused(&result, "excluded_asset");
    assert_eq!(t.balance(&t.idx, &t.account).await?, 1_000 * ONE_TOKEN);
    assert!(t.receipts().await?.is_empty());
    Ok(())
}

#[tokio::test]
async fn a_trade_that_pays_or_refunds_anyone_but_the_trust_is_refused() -> anyhow::Result<()> {
    let t = active_trust(default_trust).await?;
    let elsewhere = t.env.owner.id().to_string();
    let mut q = t.quote(&t.bond, 10 * ONE_TOKEN);
    q.recipient = elsewhere.clone();
    assert_refused(&t.trade(&q).await?, "pays_outside_trust");
    let mut q = t.quote(&t.bond, 10 * ONE_TOKEN);
    q.refund_to = elsewhere;
    assert_refused(&t.trade(&q).await?, "pays_outside_trust");
    // A quote for one deposit address cannot be used to send to another.
    let q = t.quote(&t.bond, 10 * ONE_TOKEN);
    let mut request = t.request(&q, 0).await?;
    request["settlement"]["deposit_address"] = json!(t.env.owner.id());
    assert_refused(&t.relay(&request, &t.env.enclave).await?, "quote_mismatch");
    // Only a token the trust holds can leave it.
    let mut q = t.quote(&t.bond, 10 * ONE_TOKEN);
    q.origin = format!("nep141:{}", t.oil.id());
    assert_refused(&t.trade(&q).await?, "origin_not_held");
    assert_eq!(t.balance(&t.idx, &t.account).await?, 1_000 * ONE_TOKEN);
    Ok(())
}

#[tokio::test]
async fn the_turnover_cap_and_the_minimum_gap_hold_per_period() -> anyhow::Result<()> {
    let t =
        active_trust(|oil| envelope_with_period(&[oil.id()], 300, 60_000, SHORT_PERIOD_MS)).await?;
    t.trade(&t.quote(&t.bond, 100 * ONE_TOKEN))
        .await?
        .into_result()?;
    let gap = t.trade(&t.quote(&t.bond, 10 * ONE_TOKEN)).await?;
    assert_refused(&gap, "gap_too_short");
    let now = t.env.now_ms().await?;
    t.env.advance_to(now + 60_000).await?;
    // $200 used of $300: another $200 would pass the cap.
    let over = t.trade(&t.quote(&t.bond, 100 * ONE_TOKEN)).await?;
    assert_refused(&over, "turnover_cap_exceeded");
    t.trade(&t.quote(&t.bond, 50 * ONE_TOKEN))
        .await?
        .into_result()?;
    // A new period starts with the full cap again.
    let start = t.view().await?["start_ms"].as_u64().unwrap_or_default();
    t.env.advance_to(start + SHORT_PERIOD_MS).await?;
    t.trade(&t.quote(&t.bond, 100 * ONE_TOKEN))
        .await?
        .into_result()?;
    let trust = t.view().await?;
    assert_eq!(trust["period_index"], 1);
    assert_eq!(
        trust["turnover_in_period_usd_e6"],
        json!((200 * USD).to_string())
    );
    Ok(())
}

#[tokio::test]
async fn the_official_has_no_way_to_move_or_trade_the_assets() -> anyhow::Result<()> {
    let t = active_trust(default_trust).await?;
    let owner = &t.env.owner;
    // The trust account has no keys and obeys only the trust contract.
    assert!(t.env.worker.view_access_keys(&t.account).await?.is_empty());
    let direct = owner
        .call(&t.account, "send")
        .args_json(json!({
            "token": t.idx.id(), "receiver_id": owner.id(), "amount": "1",
            "memo": null, "register_receiver": false,
        }))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?;
    assert_refused(&direct, "only_registry");
    let release = owner
        .call(&t.account, "release")
        .args_json(json!({ "token": t.idx.id(), "receiver_id": owner.id() }))
        .max_gas()
        .transact()
        .await?;
    assert_refused(&release, "only_registry");
    // The contract releases only after the end, and only to the beneficiary.
    let early = owner
        .call(t.contract.id(), "release")
        .args_json(json!({ "trust_id": t.id, "token": t.idx.id() }))
        .max_gas()
        .transact()
        .await?;
    assert_refused(&early, "not_ended");
    let finalize = owner
        .call(t.contract.id(), "finalize")
        .args_json(json!({ "trust_id": t.id }))
        .transact()
        .await?;
    assert_refused(&finalize, "not_ended");
    // Signing a trade with the official's own key is not an enclave's signature.
    let official = TestEnclave::from_seed([9u8; 32]);
    let request = t.request(&t.quote(&t.bond, 10 * ONE_TOKEN), 0).await?;
    assert_refused(&t.relay(&request, &official).await?, "unknown_enclave");
    // Envelope changes and cancels are owner-only.
    let stranger = t
        .env
        .relayer
        .call(t.contract.id(), "cancel")
        .args_json(json!({ "trust_id": t.id }))
        .transact()
        .await?;
    assert_refused(&stranger, "only_owner");
    assert_eq!(t.balance(&t.idx, &t.account).await?, 1_000 * ONE_TOKEN);
    Ok(())
}

#[tokio::test]
async fn replayed_requests_and_quotes_are_refused() -> anyhow::Result<()> {
    let t = active_trust(default_trust).await?;
    let request = t.request(&t.quote(&t.bond, 10 * ONE_TOKEN), 0).await?;
    t.relay(&request, &t.env.enclave).await?.into_result()?;
    assert_refused(&t.relay(&request, &t.env.enclave).await?, "bad_seq");
    // The same quote under a new sequence number: each quote is usable once.
    let mut again = request.clone();
    again["seq"] = json!(1);
    assert_refused(&t.relay(&again, &t.env.enclave).await?, "quote_used");
    // An expired request.
    let mut stale = t.request(&t.quote(&t.bond, 10 * ONE_TOKEN), 1).await?;
    stale["expires_at_ms"] = json!(t.env.now_ms().await? - 1);
    assert_refused(&t.relay(&stale, &t.env.enclave).await?, "expired");
    assert_eq!(t.receipts().await?.len(), 1);
    Ok(())
}

#[tokio::test]
async fn forged_signatures_are_refused() -> anyhow::Result<()> {
    let t = active_trust(default_trust).await?;
    let request = t.request(&t.quote(&t.bond, 10 * ONE_TOKEN), 0).await?;
    // A registered key's signature over a different request.
    let signed = t.env.enclave.sign(TRADE_DOMAIN, &request.to_string());
    let mut tampered = request.clone();
    tampered["amount"] = json!((20 * ONE_TOKEN).to_string());
    let result = t
        .relay_signed(&tampered.to_string(), &signed, &t.env.enclave)
        .await?;
    assert_refused(&result, "bad_signature");
    // A plan registry signature (another domain) over the same bytes.
    let plan_domain = t.env.enclave.sign("vsp/execute/v1\n", &request.to_string());
    let result = t
        .relay_signed(&request.to_string(), &plan_domain, &t.env.enclave)
        .await?;
    assert_refused(&result, "bad_signature");
    // A quote not signed by the registered 1Click key.
    let mut forged_quote = request.clone();
    forged_quote["settlement"]["quote"] = t
        .signed_quote(
            &t.quote(&t.bond, 10 * ONE_TOKEN),
            &TestEnclave::from_seed([8u8; 32]),
        )
        .await?;
    assert_refused(
        &t.relay(&forged_quote, &t.env.enclave).await?,
        "bad_quote_signature",
    );
    // An ack for a second trust signed by an unregistered key.
    let unknown = TestEnclave::from_seed([7u8; 32]);
    assert_refused(&t.ack(&unknown).await?, "unknown_enclave");
    Ok(())
}

#[tokio::test]
async fn an_envelope_change_waits_out_the_public_cooling_off() -> anyhow::Result<()> {
    let t = active_trust(default_trust).await?;
    let tighter = envelope(&[t.oil.id(), t.bond.id()], 500, 60_000);
    t.env
        .owner
        .call(t.contract.id(), "propose_envelope")
        .args_json(json!({ "trust_id": t.id, "envelope": tighter }))
        .deposit(NearToken::from_millinear(10))
        .transact()
        .await?
        .into_result()?;
    // Until the cooling-off ends the current envelope holds.
    t.trade(&t.quote(&t.bond, 10 * ONE_TOKEN))
        .await?
        .into_result()?;
    let now = t.env.now_ms().await?;
    t.env.advance_to(now + COOLING_OFF_MS).await?;
    assert_eq!(t.view().await?["envelope"], tighter);
    assert_refused(
        &t.trade(&t.quote(&t.bond, 10 * ONE_TOKEN)).await?,
        "excluded_asset",
    );
    Ok(())
}

#[tokio::test]
async fn at_the_end_everything_goes_to_the_beneficiary() -> anyhow::Result<()> {
    let t = active_trust(default_trust).await?;
    t.trade(&t.quote(&t.bond, 100 * ONE_TOKEN))
        .await?
        .into_result()?;
    // 1Click pays the trade's proceeds into the trust account.
    t.env
        .governance
        .call(t.bond.id(), "mint")
        .args_json(json!({ "account_id": t.account, "amount": (40 * ONE_TOKEN).to_string() }))
        .transact()
        .await?
        .into_result()?;
    // A public cancel: trades stop once its cooling-off has passed, and the trust can end.
    t.env
        .owner
        .call(t.contract.id(), "cancel")
        .args_json(json!({ "trust_id": t.id }))
        .transact()
        .await?
        .into_result()?;
    let finalize = |who: &Account| {
        who.call(t.contract.id(), "finalize")
            .args_json(json!({ "trust_id": t.id }))
            .transact()
    };
    assert_refused(&finalize(&t.env.relayer).await?, "not_ended");
    let now = t.env.now_ms().await?;
    t.env.advance_to(now + COOLING_OFF_MS).await?;
    assert_refused(
        &t.trade(&t.quote(&t.bond, 10 * ONE_TOKEN)).await?,
        "cancel_effective",
    );
    finalize(&t.env.relayer).await?.into_result()?;
    assert_eq!(t.view().await?["status"], "ended");
    for token in [&t.idx, &t.bond] {
        t.env
            .relayer
            .call(t.contract.id(), "release")
            .args_json(json!({ "trust_id": t.id, "token": token.id() }))
            .max_gas()
            .transact()
            .await?
            .into_result()?;
    }
    let beneficiary = t.env.beneficiary.id();
    assert_eq!(t.balance(&t.idx, beneficiary).await?, 900 * ONE_TOKEN);
    assert_eq!(t.balance(&t.bond, beneficiary).await?, 40 * ONE_TOKEN);
    assert_eq!(t.balance(&t.idx, &t.account).await?, 0);
    let unheld = t
        .env
        .relayer
        .call(t.contract.id(), "release")
        .args_json(json!({ "trust_id": t.id, "token": t.oil.id() }))
        .max_gas()
        .transact()
        .await?;
    assert_refused(&unheld, "not_held");
    Ok(())
}

#[tokio::test]
async fn the_term_ends_the_trust_without_any_cancel() -> anyhow::Result<()> {
    let env = Env::new().await?;
    let contract = deploy_trust_contract(&env).await?;
    let idx = env
        .deploy_token("idx", 18, vec![(env.owner.id().clone(), ONE_TOKEN)])
        .await?;
    let now = env.now_ms().await?;
    let id: u64 = env
        .owner
        .call(contract.id(), "create_trust")
        .args_json(json!({
            "commitment": "22".repeat(32),
            "envelope": envelope(&[], 100, 60_000),
            "beneficiary": env.beneficiary.id(),
            "cooling_off_ms": COOLING_OFF_MS,
            "end_ms": now + 20_000,
            "holdings": [idx.id()],
            "label": "",
        }))
        .deposit(NearToken::from_millinear(200))
        .max_gas()
        .transact()
        .await?
        .into_result()?
        .json()?;
    let account: AccountId = format!("t{id}.{}", contract.id()).parse()?;
    fund(&env.owner, &idx, &account, ONE_TOKEN).await?;
    env.advance_to(now + 20_000).await?;
    env.relayer
        .call(contract.id(), "finalize")
        .args_json(json!({ "trust_id": id }))
        .transact()
        .await?
        .into_result()?;
    env.relayer
        .call(contract.id(), "release")
        .args_json(json!({ "trust_id": id, "token": idx.id() }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    assert_eq!(
        env.ft_balance(idx.id(), env.beneficiary.id()).await?,
        ONE_TOKEN
    );
    Ok(())
}

#[tokio::test]
async fn a_quote_routed_through_intents_is_refused() -> anyhow::Result<()> {
    let t = active_trust(default_trust).await?;
    for edit in [
        (|q: &mut Value| q["recipientType"] = json!("INTENTS")) as fn(&mut Value),
        |q: &mut Value| q["refundType"] = json!("INTENTS"),
        |q: &mut Value| q["depositType"] = json!("INTENTS"),
    ] {
        let mut q = t.quote(&t.bond, 10 * ONE_TOKEN);
        q.edit = Some(edit);
        assert_refused(&t.trade(&q).await?, "quote_routing");
    }
    Ok(())
}

#[tokio::test]
async fn tiny_trades_and_costly_quotes_are_refused() -> anyhow::Result<()> {
    let t = active_trust(default_trust).await?;
    // $8 of IDX: under the $10 minimum, where near-flat fees would eat the turnover cap.
    assert_refused(
        &t.trade(&t.quote(&t.bond, 4 * ONE_TOKEN)).await?,
        "trade_too_small",
    );
    // 60 bps of fees: over the trust's proportional bound (the registry's flat $1 does not apply).
    let mut q = t.quote(&t.bond, 100 * ONE_TOKEN);
    q.fee_bps = 60;
    assert_refused(&t.trade(&q).await?, "quote_fee_too_high");
    Ok(())
}

#[tokio::test]
async fn a_quote_key_registered_after_the_trust_never_acts_for_it() -> anyhow::Result<()> {
    let t = active_trust(default_trust).await?;
    let late = TestEnclave::from_seed([45u8; 32]);
    t.env
        .governance
        .call(t.contract.id(), "set_quote_signer")
        .args_json(json!({ "public_key": late.public_key() }))
        .transact()
        .await?
        .into_result()?;
    let now = t.env.now_ms().await?;
    // Past the activation delay and the trust's own cooling-off.
    t.env.advance_to(now + COOLING_OFF_MS + 1_000).await?;
    let q = t.quote(&t.bond, 10 * ONE_TOKEN);
    let mut request = t.request(&q, 0).await?;
    request["settlement"]["quote"] = t.signed_quote(&q, &late).await?;
    assert_refused(
        &t.relay(&request, &t.env.enclave).await?,
        "key_too_new_for_trust",
    );
    Ok(())
}

#[tokio::test]
async fn a_failed_send_frees_the_holding_slot_and_the_turnover() -> anyhow::Result<()> {
    let t = active_trust(|oil| envelope(&[oil.id()], 10_000, 60_000)).await?;
    // More IDX than the trust holds: the trust account's ft_transfer fails.
    // The trade itself is accepted; its transfer fails afterwards, inside the trust account.
    let _ = t.trade(&t.quote(&t.bond, 2_000 * ONE_TOKEN)).await?;
    let receipts = t.receipts().await?;
    assert_eq!(receipts[0]["status"], "failed");
    let trust = t.view().await?;
    assert_eq!(trust["holdings"], json!([t.idx.id()]));
    assert_eq!(trust["turnover_in_period_usd_e6"], "0");
    Ok(())
}

#[tokio::test]
async fn the_trust_account_is_registered_on_a_token_before_buying_it() -> anyhow::Result<()> {
    let t = active_trust(default_trust).await?;
    let before: Value = t
        .env
        .worker
        .view(t.bond.id(), "storage_balance_of")
        .args_json(json!({ "account_id": t.account }))
        .await?
        .json()?;
    assert!(before.is_null());
    t.trade(&t.quote(&t.bond, 10 * ONE_TOKEN))
        .await?
        .into_result()?;
    let after: Value = t
        .env
        .worker
        .view(t.bond.id(), "storage_balance_of")
        .args_json(json!({ "account_id": t.account }))
        .await?
        .json()?;
    assert!(!after.is_null(), "registered on the bought token");
    assert_eq!(t.receipts().await?[0]["status"], "done");
    Ok(())
}

#[tokio::test]
async fn an_ack_for_other_terms_never_activates_a_trust() -> anyhow::Result<()> {
    let env = Env::new().await?;
    let contract = deploy_trust_contract(&env).await?;
    let idx = env.deploy_token("idx", 18, vec![]).await?;
    let now = env.now_ms().await?;
    let id: u64 = env
        .owner
        .call(contract.id(), "create_trust")
        .args_json(json!({
            "commitment": "11".repeat(32),
            "envelope": envelope(&[], 100, 60_000),
            "beneficiary": env.beneficiary.id(),
            "cooling_off_ms": COOLING_OFF_MS,
            "end_ms": now + 365 * DAY_MS,
            "holdings": [idx.id()],
            "label": "",
        }))
        .deposit(NearToken::from_millinear(200))
        .max_gas()
        .transact()
        .await?
        .into_result()?
        .json()?;
    let t = Trust {
        account: format!("t{id}.{}", contract.id()).parse()?,
        bond: env.deploy_token("bond", 18, vec![]).await?,
        oil: env.deploy_token("oil", 18, vec![]).await?,
        idx,
        contract,
        id,
        env,
    };
    let owner = t.env.owner.id().clone();
    for edit in [
        Box::new(move |a: &mut Value| a["beneficiary"] = json!(owner)) as Box<dyn Fn(&mut Value)>,
        Box::new(|a: &mut Value| a["end_ms"] = json!(a["end_ms"].as_u64().unwrap_or(0) + 1)),
        Box::new(|a: &mut Value| a["trust_account"] = json!("t99.trust.test.near")),
    ] {
        assert_refused(&t.ack_with(&t.env.enclave, edit).await?, "terms_mismatch");
    }
    t.ack(&t.env.enclave).await?.into_result()?;
    assert_eq!(t.view().await?["status"], "active");
    Ok(())
}
