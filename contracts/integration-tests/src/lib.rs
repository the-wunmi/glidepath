//! Shared sandbox harness: deploys the contracts from `res/` (run `build.sh` first), plays the
//! enclave (ed25519) and the MPC responder (secp256k1), and builds signed requests, so each test
//! reads as its scenario.

use anyhow::{anyhow, Context, Result};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use ed25519_dalek::Signer;
use k256::elliptic_curve::sec1::ToEncodedPoint;
use k256::elliptic_curve::PrimeField;
use near_workspaces::network::Sandbox;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, AccountId, Contract, Worker};
use serde_json::{json, Value};
use sha3::{Digest, Keccak256, Sha3_256};
use std::path::PathBuf;
use std::task::Poll;
use std::time::{Duration, Instant};

pub const ENCLAVE_SEED: [u8; 32] = [42u8; 32];
pub const SECOND_ENCLAVE_SEED: [u8; 32] = [43u8; 32];
/// Simulated 1Click quote signing key (test key only; the TS simulator's seed, 0x2c × 32).
pub const QUOTE_SIGNER_SEED: [u8; 32] = [44u8; 32];
/// Decimals of the proceeds asset (USDC) in every test plan.
pub const PROCEEDS_DECIMALS: u32 = 6;
pub const PROCEEDS_ASSET: &str = "nep141:usdc.near";
static QUOTE_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
/// Fixed test root secret of the simulated MPC network (never a real key).
pub const MPC_ROOT_SECRET: [u8; 32] = [7u8; 32];
pub const TOKEN_DECIMALS: u32 = 18;
pub const ONE_TOKEN: u128 = 10u128.pow(TOKEN_DECIMALS);
/// $1.50 floor, in USD × 10^6.
pub const MIN_PRICE_USD_E6: u128 = 1_500_000;
pub const DAY_MS: u64 = 86_400_000;
pub const EXECUTE_DEPOSIT: NearToken = NearToken::from_millinear(100);
pub const ACK_DEPOSIT: NearToken = NearToken::from_millinear(10);
pub const CREATE_DEPOSIT: NearToken = NearToken::from_millinear(200);
pub const EVM_TOKEN: &str = "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238";
pub const EVM_VENUE: &str = "0x2222222222222222222222222222222222222222";
pub const EVM_BENEFICIARY: &str = "0xd8da6bf26964af9d7eed9e03e53415d37aa96045";
pub const EVM_CHAIN_ID: u64 = 11_155_111;

pub fn res_path(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../res")
        .join(name)
}

pub fn wasm(name: &str) -> Result<Vec<u8>> {
    std::fs::read(res_path(name))
        .with_context(|| format!("{name} missing: run contracts/build.sh first"))
}

/// The simulated enclave's ed25519 key.
pub struct TestEnclave {
    key: ed25519_dalek::SigningKey,
}

impl TestEnclave {
    pub fn from_seed(seed: [u8; 32]) -> Self {
        Self {
            key: ed25519_dalek::SigningKey::from_bytes(&seed),
        }
    }

    pub fn public_key(&self) -> String {
        format!(
            "ed25519:{}",
            bs58::encode(self.key.verifying_key().as_bytes()).into_string()
        )
    }

    /// Standard base64 of the signature over `domain || message`.
    pub fn sign(&self, domain: &str, message: &str) -> String {
        let signed = [domain.as_bytes(), message.as_bytes()].concat();
        BASE64.encode(self.key.sign(&signed).to_bytes())
    }

    /// Signs quote `q` as 1Click does: `"ed25519:<base58>"` over the text base58(sha256(q)).
    pub fn sign_quote(&self, q: &str) -> String {
        let signature = self.key.sign(quote_signed_message(q).as_bytes());
        format!(
            "ed25519:{}",
            bs58::encode(signature.to_bytes()).into_string()
        )
    }
}

/// The simulated MPC network: one root secret, derived keys = root + tweak.
pub struct TestMpc {
    root: k256::Scalar,
}

impl Default for TestMpc {
    fn default() -> Self {
        Self {
            root: Option::from(k256::Scalar::from_repr(MPC_ROOT_SECRET.into()))
                .expect("root scalar"),
        }
    }
}

impl TestMpc {
    pub fn root_public_key(&self) -> String {
        let point = (k256::ProjectivePoint::GENERATOR * self.root).to_affine();
        format!(
            "secp256k1:{}",
            bs58::encode(&point.to_encoded_point(false).as_bytes()[1..]).into_string()
        )
    }

    /// EVM address for (predecessor, path), derived here without the contracts.
    pub fn derived_address(&self, predecessor: &str, path: &str) -> Result<String> {
        let tweak =
            Option::<k256::Scalar>::from(k256::Scalar::from_repr(tweak(predecessor, path).into()))
                .ok_or_else(|| anyhow!("tweak"))?;
        let point = (k256::ProjectivePoint::GENERATOR * (self.root + tweak)).to_affine();
        Ok(evm_address(&point.to_encoded_point(false).as_bytes()[1..]))
    }

    /// Signs `payload` (a prehash) with root + tweak, RFC 6979, low s, in the signer's JSON shape.
    pub fn sign(&self, tweak_hex: &str, payload_hex: &str) -> Result<Value> {
        let tweak: [u8; 32] = hex::decode(tweak_hex)?
            .try_into()
            .map_err(|_| anyhow!("tweak"))?;
        let tweak = Option::<k256::Scalar>::from(k256::Scalar::from_repr(tweak.into()))
            .ok_or_else(|| anyhow!("tweak"))?;
        let secret = self.root + tweak;
        let key = k256::ecdsa::SigningKey::from_bytes(&secret.to_bytes())?;
        let payload = hex::decode(payload_hex)?;
        let (signature, recovery_id) = key.sign_prehash_recoverable(&payload)?;
        anyhow::ensure!(
            !recovery_id.is_x_reduced(),
            "x-reduced R is not expected in tests"
        );
        let mut big_r = vec![0x02 | u8::from(recovery_id.is_y_odd())];
        big_r.extend_from_slice(&signature.r().to_bytes());
        Ok(json!({
            "scheme": "Secp256k1",
            "big_r": { "affine_point": hex::encode(big_r) },
            "s": { "scalar": hex::encode(signature.s().to_bytes()) },
            "recovery_id": recovery_id.to_byte(),
        }))
    }
}

pub struct Options {
    pub min_cooling_off_ms: u64,
    /// Must be at least `min_cooling_off_ms` (the registry refuses less).
    pub enclave_activation_delay_ms: u64,
    /// Move block time past the bootstrap enclave's and quote key's activation.
    pub wait_for_activation: bool,
    pub set_quote_signer: bool,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            min_cooling_off_ms: 1_000,
            enclave_activation_delay_ms: 1_000,
            wait_for_activation: true,
            set_quote_signer: true,
        }
    }
}

pub struct Env {
    pub worker: Worker<Sandbox>,
    pub root: Account,
    pub governance: Account,
    pub registry: Contract,
    pub signer: Contract,
    pub responder: Account,
    pub owner: Account,
    pub beneficiary: Account,
    pub relayer: Account,
    pub venue: Account,
    pub enclave: TestEnclave,
    pub quote_signer: TestEnclave,
    pub mpc: TestMpc,
}

pub async fn subaccount(parent: &Account, name: &str, near: u128) -> Result<Account> {
    Ok(parent
        .create_subaccount(name)
        .initial_balance(NearToken::from_near(near))
        .transact()
        .await?
        .into_result()?)
}

impl Env {
    pub async fn new() -> Result<Self> {
        Self::with(Options::default()).await
    }

    pub async fn with(options: Options) -> Result<Self> {
        let worker = near_workspaces::sandbox().await?;
        let root = worker.root_account()?;
        let governance = subaccount(&root, "governance", 50).await?;
        let responder = subaccount(&root, "responder", 10).await?;
        let owner = subaccount(&root, "owner", 50).await?;
        let beneficiary = subaccount(&root, "beneficiary", 10).await?;
        let relayer = subaccount(&root, "relayer", 50).await?;
        let venue = subaccount(&root, "venue", 10).await?;
        let mpc = TestMpc::default();

        let signer = subaccount(&root, "signer", 20)
            .await?
            .deploy(&wasm("mpc_signer_sim.wasm")?)
            .await?
            .into_result()?;
        signer
            .call("new")
            .args_json(
                json!({ "root_public_key": mpc.root_public_key(), "responder": responder.id() }),
            )
            .transact()
            .await?
            .into_result()?;

        let registry = subaccount(&root, "registry", 30)
            .await?
            .deploy(&wasm("plan_registry.wasm")?)
            .await?
            .into_result()?;
        registry
            .call("new")
            .args_json(json!({
                "governance": governance.id(),
                "signer_contract": signer.id(),
                "min_cooling_off_ms": options.min_cooling_off_ms,
                "enclave_activation_delay_ms": options.enclave_activation_delay_ms,
            }))
            .transact()
            .await?
            .into_result()?;
        let code = wasm("plan_account.wasm")?;
        // Global deploys burn 10× storage: 1e20 yocto per byte.
        let burn = NearToken::from_yoctonear(code.len() as u128 * 100_000_000_000_000_000_000);
        governance
            .call(registry.id(), "setup_plan_account_code")
            .args(code)
            .deposit(burn)
            .max_gas()
            .transact()
            .await?
            .into_result()?;

        let env = Self {
            worker,
            root,
            governance,
            registry,
            signer,
            responder,
            owner,
            beneficiary,
            relayer,
            venue,
            enclave: TestEnclave::from_seed(ENCLAVE_SEED),
            quote_signer: TestEnclave::from_seed(QUOTE_SIGNER_SEED),
            mpc,
        };
        env.register_enclave(&env.enclave.public_key())
            .await?
            .into_result()?;
        env.governance
            .call(env.registry.id(), "set_proceeds_asset")
            .args_json(json!({ "asset_id": PROCEEDS_ASSET, "decimals": 6 }))
            .deposit(NearToken::from_millinear(10))
            .transact()
            .await?
            .into_result()?;
        if options.set_quote_signer {
            env.set_quote_signer(&env.quote_signer.public_key())
                .await?
                .into_result()?;
        }
        if options.wait_for_activation {
            let now = env.now_ms().await?;
            env.advance_to(now + options.enclave_activation_delay_ms)
                .await?;
        }
        Ok(env)
    }

    pub async fn set_quote_signer(&self, public_key: &str) -> Result<ExecutionFinalResult> {
        Ok(self
            .governance
            .call(self.registry.id(), "set_quote_signer")
            .args_json(json!({ "public_key": public_key }))
            .transact()
            .await?)
    }

    /// Quote terms 1Click would give for selling `amount` of `plan`'s token to `deposit_address`
    /// for at least `min_amount_out`, paying the beneficiary and refunding to the plan.
    pub async fn quote_terms(
        &self,
        plan: &Value,
        deposit_address: &str,
        amount: u128,
        min_amount_out: u128,
    ) -> Result<QuoteTerms> {
        // The registry refuses a quote payload it has seen, so every quote built here differs
        // (by a millisecond of deadline per call) even when two sales are otherwise identical.
        let unique = QUOTE_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let refund_to = match plan["asset"]["type"].as_str() {
            Some("evm_erc20") => plan["evm_address"].as_str(),
            _ => plan["plan_account"].as_str(),
        };
        Ok(QuoteTerms::sale(
            &origin_asset(plan),
            deposit_address,
            amount,
            min_amount_out,
            self.beneficiary.id().as_str(),
            self.now_ms().await? + 600_000 + unique,
            refund_to.unwrap_or_default(),
        ))
    }

    /// Settlement for a sale of `amount` of `plan`'s token paying `deposit_address`, with a 1Click
    /// quote signed by the test quote key that matches it field for field.
    pub async fn settlement(
        &self,
        plan: &Value,
        deposit_address: &str,
        amount: u128,
        min_amount_out: u128,
    ) -> Result<Value> {
        let terms = self
            .quote_terms(plan, deposit_address, amount, min_amount_out)
            .await?;
        Ok(signed_settlement(&self.quote_signer, &terms))
    }

    pub async fn register_enclave(&self, public_key: &str) -> Result<ExecutionFinalResult> {
        Ok(self
            .governance
            .call(self.registry.id(), "register_enclave")
            .args_json(json!({
                "public_key": public_key,
                "measurements": {
                    "mrtd": "aa".repeat(48), "rtmr0": "bb".repeat(48), "rtmr1": "cc".repeat(48),
                    "rtmr2": "dd".repeat(48), "rtmr3": "ee".repeat(48),
                },
                "quote_hash": "ab".repeat(32),
            }))
            .deposit(NearToken::from_millinear(50))
            .transact()
            .await?)
    }

    /// Deploys a demo NEP-141 token owned by governance, minting `allocations` at launch.
    pub async fn deploy_token(
        &self,
        name: &str,
        decimals: u8,
        allocations: Vec<(AccountId, u128)>,
    ) -> Result<Contract> {
        let token = subaccount(&self.root, name, 20)
            .await?
            .deploy(&wasm("demo_token.wasm")?)
            .await?
            .into_result()?;
        let allocations: Vec<Value> = allocations
            .into_iter()
            .map(|(id, amount)| json!([id, amount.to_string()]))
            .collect();
        token
            .call("new")
            .args_json(json!({
                "owner_id": self.governance.id(),
                "metadata": {
                    "spec": "ft-1.0.0", "name": name, "symbol": name.to_uppercase(),
                    "icon": null, "reference": null, "reference_hash": null, "decimals": decimals,
                },
                "allocations": allocations,
            }))
            .max_gas()
            .transact()
            .await?
            .into_result()?;
        Ok(token)
    }

    pub async fn now_ms(&self) -> Result<u64> {
        Ok(self.worker.view_block().await?.timestamp() / 1_000_000)
    }

    /// Moves block time forward to at least `target_ms`.
    pub async fn advance_to(&self, target_ms: u64) -> Result<()> {
        loop {
            let now = self.now_ms().await?;
            if now >= target_ms {
                return Ok(());
            }
            // Sandbox blocks advance block time by roughly 300 ms each.
            let blocks = ((target_ms - now) / 300 + 1).min(10_000);
            self.worker.fast_forward(blocks).await?;
        }
    }

    pub fn plan_account(&self, plan_id: u64) -> AccountId {
        format!("p{plan_id}.{}", self.registry.id())
            .parse()
            .expect("plan account id")
    }

    /// Default NEP-141 plan: 1-day periods, 100 tokens per tx, 1000 per period, $1.50 floor.
    pub async fn nep141_plan_args(&self, token: &AccountId) -> Result<Value> {
        let now = self.now_ms().await?;
        Ok(json!({
            "commitment": "11".repeat(32),
            "asset": { "type": "nep141", "token_id": token },
            "token_decimals": TOKEN_DECIMALS,
            "quote_decimals": 6,
            "beneficiary": { "near_account": self.beneficiary.id(), "evm_address": null },
            "envelope": default_envelope(),
            "disclosure": { "type": "delayed", "delay_ms": 7 * DAY_MS },
            "cooling_off_ms": 2_000,
            "start_ms": now.saturating_sub(1_000),
            "end_ms": now + 30 * DAY_MS,
            "label": "Founder vesting sales",
            "proceeds_asset": PROCEEDS_ASSET,
        }))
    }

    pub async fn evm_plan_args(&self) -> Result<Value> {
        let now = self.now_ms().await?;
        Ok(json!({
            "commitment": "22".repeat(32),
            "asset": { "type": "evm_erc20", "chain_id": EVM_CHAIN_ID, "token_address": EVM_TOKEN.to_uppercase().replace("0X", "0x") },
            "token_decimals": TOKEN_DECIMALS,
            "quote_decimals": 6,
            "beneficiary": { "near_account": self.beneficiary.id(), "evm_address": EVM_BENEFICIARY },
            "envelope": default_envelope(),
            "disclosure": { "type": "realtime" },
            "cooling_off_ms": 2_000,
            "start_ms": now.saturating_sub(1_000),
            "end_ms": now + 30 * DAY_MS,
            "label": "EVM treasury plan",
            "proceeds_asset": PROCEEDS_ASSET,
        }))
    }

    pub async fn create_plan(
        &self,
        caller: &Account,
        args: &Value,
        deposit: NearToken,
    ) -> Result<ExecutionFinalResult> {
        Ok(caller
            .call(self.registry.id(), "create_plan")
            .args_json(args)
            .deposit(deposit)
            .gas(Gas::from_tgas(200))
            .transact()
            .await?)
    }

    /// Creates a plan as `owner` and acknowledges it with the test enclave; returns its id.
    pub async fn active_plan(&self, args: &Value) -> Result<u64> {
        let plan_id: u64 = self
            .create_plan(&self.owner, args, CREATE_DEPOSIT)
            .await?
            .into_result()?
            .json()?;
        self.ack(plan_id, &args["commitment"], &args["envelope"])
            .await?
            .into_result()?;
        Ok(plan_id)
    }

    /// An active NEP-141 plan whose account received 10,000 tokens at token launch.
    pub async fn funded_nep141_plan(&self, envelope: Option<Value>) -> Result<(Contract, u64)> {
        let token_id: AccountId = format!("token.{}", self.root.id()).parse()?;
        let mut args = self.nep141_plan_args(&token_id).await?;
        if let Some(envelope) = envelope {
            args["envelope"] = envelope;
        }
        let plan_id = self.active_plan(&args).await?;
        let token = self
            .deploy_token(
                "token",
                18,
                vec![(self.plan_account(plan_id), 10_000 * ONE_TOKEN)],
            )
            .await?;
        Ok((token, plan_id))
    }

    pub async fn ack(
        &self,
        plan_id: u64,
        commitment: &Value,
        envelope: &Value,
    ) -> Result<ExecutionFinalResult> {
        let ack = json!({
            "type": "ack",
            "plan_id": plan_id,
            "commitment": commitment,
            "envelope": envelope,
            "within_envelope": true,
            "issued_at_ms": self.now_ms().await?,
        })
        .to_string();
        self.ack_signed(
            plan_id,
            &ack,
            &self.enclave.sign("glidepath/ack/v1\n", &ack),
            &self.enclave.public_key(),
        )
        .await
    }

    pub async fn ack_signed(
        &self,
        plan_id: u64,
        ack_json: &str,
        signature: &str,
        enclave_key: &str,
    ) -> Result<ExecutionFinalResult> {
        Ok(self
            .relayer
            .call(self.registry.id(), "ack_plan")
            .args_json(json!({
                "plan_id": plan_id, "ack_json": ack_json, "signature": signature, "enclave_key": enclave_key,
            }))
            .deposit(ACK_DEPOSIT)
            .transact()
            .await?)
    }

    pub async fn plan(&self, plan_id: u64) -> Result<Value> {
        Ok(self
            .registry
            .view("get_plan")
            .args_json(json!({ "plan_id": plan_id }))
            .await?
            .json()?)
    }

    pub async fn receipts(&self, plan_id: u64) -> Result<Vec<Value>> {
        Ok(self
            .registry
            .view("get_receipts")
            .args_json(json!({ "plan_id": plan_id }))
            .await?
            .json()?)
    }

    /// A NEP-141 sale request at the current plan seq, paying `amount` to the venue at the floor.
    pub async fn nep141_sale(&self, plan_id: u64, amount: u128) -> Result<Value> {
        self.nep141_sale_at(plan_id, amount, floor_min_out(amount))
            .await
    }

    /// Like `nep141_sale` with an explicit minimum output (quoted consistently).
    pub async fn nep141_sale_at(
        &self,
        plan_id: u64,
        amount: u128,
        min_amount_out: u128,
    ) -> Result<Value> {
        let plan = self.plan(plan_id).await?;
        let now = self.now_ms().await?;
        Ok(json!({
            "plan_id": plan_id,
            "seq": plan["next_seq"],
            "commitment": plan["commitment"],
            "action": {
                "type": "nep141_transfer",
                "receiver_id": self.venue.id(),
                "amount": amount.to_string(),
                "register_receiver": true,
            },
            "settlement": self
                .settlement(&plan, self.venue.id().as_str(), amount, min_amount_out)
                .await?,
            "compliance": all_compliant(),
            "issued_at_ms": now,
            "expires_at_ms": now + 600_000,
        }))
    }

    pub async fn evm_sale(&self, plan_id: u64, amount: u128) -> Result<Value> {
        let plan = self.plan(plan_id).await?;
        let now = self.now_ms().await?;
        Ok(json!({
            "plan_id": plan_id,
            "seq": plan["next_seq"],
            "commitment": plan["commitment"],
            "action": evm_action(amount, plan["evm_nonce"].as_u64().unwrap_or_default()),
            "settlement": self
                .settlement(&plan, EVM_VENUE, amount, floor_min_out(amount))
                .await?,
            "compliance": all_compliant(),
            "issued_at_ms": now,
            "expires_at_ms": now + 600_000,
        }))
    }

    /// Signs `request` with the test enclave and relays it.
    pub async fn execute(&self, request: &Value) -> Result<ExecutionFinalResult> {
        let request_json = request.to_string();
        let signature = self.enclave.sign("glidepath/execute/v1\n", &request_json);
        self.execute_signed(
            request["plan_id"].as_u64().unwrap_or_default(),
            &request_json,
            &signature,
            &self.enclave.public_key(),
            EXECUTE_DEPOSIT,
        )
        .await
    }

    pub async fn execute_signed(
        &self,
        plan_id: u64,
        request_json: &str,
        signature: &str,
        enclave_key: &str,
        deposit: NearToken,
    ) -> Result<ExecutionFinalResult> {
        Ok(self
            .relayer
            .call(self.registry.id(), "execute")
            .args_json(json!({
                "plan_id": plan_id, "request_json": request_json, "signature": signature, "enclave_key": enclave_key,
            }))
            .deposit(deposit)
            .gas(Gas::from_tgas(300))
            .transact()
            .await?)
    }

    /// Relays an EVM sale and plays the MPC responder while it waits for its signature.
    pub async fn execute_evm(&self, request: &Value) -> Result<ExecutionFinalResult> {
        let request_json = request.to_string();
        let signature = self.enclave.sign("glidepath/execute/v1\n", &request_json);
        let status = self
            .relayer
            .call(self.registry.id(), "execute")
            .args_json(json!({
                "plan_id": request["plan_id"], "request_json": request_json,
                "signature": signature, "enclave_key": self.enclave.public_key(),
            }))
            .deposit(EXECUTE_DEPOSIT)
            .gas(Gas::from_tgas(300))
            .transact_async()
            .await?;
        self.answer_mpc_until_done(status).await
    }

    /// Answers every pending signature request until the transaction finishes.
    pub async fn answer_mpc_until_done(
        &self,
        status: near_workspaces::operations::TransactionStatus,
    ) -> Result<ExecutionFinalResult> {
        let deadline = Instant::now() + Duration::from_secs(120);
        loop {
            if let Poll::Ready(result) = status.status().await? {
                return Ok(result);
            }
            self.respond_to_pending().await?;
            anyhow::ensure!(Instant::now() < deadline, "transaction did not finish");
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
    }

    pub async fn wait_for(
        &self,
        status: near_workspaces::operations::TransactionStatus,
    ) -> Result<ExecutionFinalResult> {
        let deadline = Instant::now() + Duration::from_secs(600);
        loop {
            if let Poll::Ready(result) = status.status().await? {
                return Ok(result);
            }
            anyhow::ensure!(Instant::now() < deadline, "transaction did not finish");
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
    }

    pub async fn pending_signatures(&self) -> Result<Vec<Value>> {
        Ok(self
            .signer
            .view("pending_requests")
            .args_json(json!({}))
            .await?
            .json()?)
    }

    pub async fn respond_to_pending(&self) -> Result<usize> {
        let pending = self.pending_signatures().await?;
        for entry in &pending {
            let request = &entry["request"];
            let response = self.mpc.sign(
                request["tweak"].as_str().unwrap_or_default(),
                request["payload"].as_str().unwrap_or_default(),
            )?;
            self.responder
                .call(self.signer.id(), "respond")
                .args_json(json!({ "request": request, "response": response }))
                .max_gas()
                .transact()
                .await?
                .into_result()?;
        }
        Ok(pending.len())
    }

    pub async fn ft_balance(&self, token: &AccountId, account: &AccountId) -> Result<u128> {
        let balance: String = self
            .worker
            .view(token, "ft_balance_of")
            .args_json(json!({ "account_id": account }))
            .await?
            .json()?;
        Ok(balance.parse()?)
    }
}

pub fn default_envelope() -> Value {
    json!({
        "period_ms": DAY_MS,
        "max_amount_per_period": (1_000 * ONE_TOKEN).to_string(),
        "max_amount_per_tx": (100 * ONE_TOKEN).to_string(),
        "min_price_usd_e6": MIN_PRICE_USD_E6.to_string(),
        "min_gap_ms": 0,
    })
}

pub fn all_compliant() -> Value {
    json!({
        "within_period_budget": true, "within_tx_cap": true, "above_floor": true,
        "venue_allowed": true, "prices_agree": true, "schedule_ok": true,
    })
}

/// The quote fields the registry binds or the tests vary. Everything else in a quote is fixed
/// the way the TypeScript 1Click simulator fixes it (scripts/oneclick-vectors.ts).
#[derive(Clone, Debug)]
pub struct QuoteTerms {
    pub origin_asset: String,
    pub destination_asset: String,
    pub deposit_address: String,
    pub amount: u128,
    pub amount_out: u128,
    pub min_amount_out: u128,
    /// USD values in units of 1e-12, as 1Click prints them with 12 decimals.
    pub amount_in_usd_e12: u128,
    pub amount_out_usd_e12: u128,
    pub recipient: String,
    pub refund_to: String,
    pub deadline_ms: u64,
    pub dry: bool,
    pub swap_type: String,
}

impl QuoteTerms {
    /// A live exact-input quote with 1% slippage on `amount_out` and a 20 bps cost (1Click's fee
    /// without a partner key), valued at $1 per proceeds unit.
    pub fn sale(
        origin_asset: &str,
        deposit_address: &str,
        amount: u128,
        min_amount_out: u128,
        recipient: &str,
        deadline_ms: u64,
        refund_to: &str,
    ) -> Self {
        let amount_out = min_amount_out * 101 / 100;
        let amount_out_usd_e12 = amount_out * 10u128.pow(12 - PROCEEDS_DECIMALS);
        Self {
            origin_asset: origin_asset.to_string(),
            destination_asset: PROCEEDS_ASSET.to_string(),
            deposit_address: deposit_address.to_string(),
            amount,
            amount_out,
            min_amount_out,
            amount_in_usd_e12: amount_out_usd_e12 * 10_020 / 10_000,
            amount_out_usd_e12,
            recipient: recipient.to_string(),
            refund_to: refund_to.to_string(),
            deadline_ms,
            dry: false,
            swap_type: "EXACT_INPUT".to_string(),
        }
    }
}

/// The quote object Q 1Click signs for `terms`, with the field set the live quote has.
pub fn quote_payload(terms: &QuoteTerms) -> Value {
    let deadline = iso_timestamp(terms.deadline_ms);
    json!({
        "amount": terms.amount.to_string(),
        "amountIn": terms.amount.to_string(),
        "amountInFormatted": format_units(terms.amount, TOKEN_DECIMALS),
        "amountInUsd": format_units_fixed(terms.amount_in_usd_e12, 12),
        "amountOut": terms.amount_out.to_string(),
        "amountOutFormatted": format_units(terms.amount_out, PROCEEDS_DECIMALS),
        "amountOutUsd": format_units_fixed(terms.amount_out_usd_e12, 12),
        "deadline": deadline,
        "depositAddress": terms.deposit_address,
        "depositType": "ORIGIN_CHAIN",
        "destinationAsset": terms.destination_asset,
        "dry": terms.dry,
        "minAmountIn": terms.amount.to_string(),
        "minAmountOut": terms.min_amount_out.to_string(),
        "originAsset": terms.origin_asset,
        "recipient": terms.recipient,
        "recipientType": "DESTINATION_CHAIN",
        "refundFee": "0",
        "refundTo": terms.refund_to,
        "refundType": "ORIGIN_CHAIN",
        "slippageTolerance": 100,
        "swapType": terms.swap_type,
        "timeEstimate": 20,
        "timeWhenInactive": deadline,
        "timestamp": iso_timestamp(terms.deadline_ms.saturating_sub(600_000)),
        "withdrawFee": "0",
    })
}

/// 1Click's asset id for `plan`'s token. Bridged ERC-20s get an omft id from 1Click's token list,
/// which the registry does not bind; this one is only plausible.
pub fn origin_asset(plan: &Value) -> String {
    let asset = &plan["asset"];
    match asset["type"].as_str() {
        Some("evm_erc20") => format!(
            "nep141:sepolia-{}.omft.near",
            asset["token_address"]
                .as_str()
                .unwrap_or_default()
                .to_lowercase()
        ),
        _ => format!("nep141:{}", asset["token_id"].as_str().unwrap_or_default()),
    }
}

/// A settlement whose quote (signed by `quote_signer`) agrees with every field of `terms`.
pub fn signed_settlement(quote_signer: &TestEnclave, terms: &QuoteTerms) -> Value {
    sign_into_settlement(
        quote_signer,
        &terms.deposit_address,
        terms.min_amount_out,
        &quote_payload(terms),
    )
}

/// Wraps an arbitrary quote object, stable-stringified and signed by `quote_signer` in 1Click's
/// format, in a settlement.
pub fn sign_into_settlement(
    quote_signer: &TestEnclave,
    deposit_address: &str,
    min_amount_out: u128,
    payload: &Value,
) -> Value {
    let payload = stable_stringify(payload);
    json!({
        "venue": "1click",
        "correlation_id": "quote-0001",
        "deposit_address": deposit_address,
        "min_amount_out": min_amount_out.to_string(),
        "destination_asset": PROCEEDS_ASSET,
        "quote": { "signature": quote_signer.sign_quote(&payload), "payload": payload },
    })
}

/// The text 1Click signs for quote `q`: base58(sha256(q)).
pub fn quote_signed_message(q: &str) -> String {
    use sha2::Digest as _;
    bs58::encode(sha2::Sha256::digest(q.as_bytes())).into_string()
}

/// JSON with object keys sorted (by UTF-16 code unit, as JavaScript sorts; the same as byte order
/// for the ASCII keys quotes use) and no spaces: 1Click's stable stringify. Explicit because a
/// workspace build turns on serde_json's `preserve_order` (near-sdk needs it), and then
/// `to_string` keeps insertion order.
pub fn stable_stringify(value: &Value) -> String {
    match value {
        Value::Object(map) => {
            let mut entries: Vec<_> = map.iter().collect();
            entries.sort_by(|a, b| a.0.encode_utf16().cmp(b.0.encode_utf16()));
            let body: Vec<String> = entries
                .into_iter()
                .map(|(k, v)| format!("{}:{}", Value::from(k.as_str()), stable_stringify(v)))
                .collect();
            format!("{{{}}}", body.join(","))
        }
        Value::Array(items) => {
            let body: Vec<String> = items.iter().map(stable_stringify).collect();
            format!("[{}]", body.join(","))
        }
        other => other.to_string(),
    }
}

/// `value` base units as a decimal with trailing zeros trimmed but at least one fraction digit
/// ("10.0", "15.15"), as 1Click's `*Formatted` fields read.
pub fn format_units(value: u128, decimals: u32) -> String {
    let fixed = format_units_fixed(value, decimals);
    let trimmed = fixed.trim_end_matches('0');
    if trimmed.ends_with('.') {
        format!("{trimmed}0")
    } else {
        trimmed.to_string()
    }
}

/// `value` base units as a decimal with exactly `decimals` fraction digits.
pub fn format_units_fixed(value: u128, decimals: u32) -> String {
    let unit = 10u128.pow(decimals);
    format!(
        "{}.{:0width$}",
        value / unit,
        value % unit,
        width = decimals as usize
    )
}

/// Unix milliseconds as `YYYY-MM-DDTHH:MM:SS.mmmZ`, the form 1Click writes deadlines in.
pub fn iso_timestamp(ms: u64) -> String {
    // Civil-from-days (Howard Hinnant), valid for every date after 1970.
    let days = (ms / DAY_MS) as i64;
    let z = days + 719_468;
    let era = z / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    let in_day = ms % DAY_MS;
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        in_day / 3_600_000,
        in_day / 60_000 % 60,
        in_day / 1_000 % 60,
        in_day % 1_000
    )
}

pub fn evm_action(amount: u128, nonce: u64) -> Value {
    json!({
        "type": "evm_erc20_transfer",
        "to": EVM_VENUE,
        "amount": amount.to_string(),
        "nonce": nonce,
        "gas_limit": 65_000,
        "max_fee_per_gas": "30000000000",
        "max_priority_fee_per_gas": "1500000000",
    })
}

/// USDC (6 decimals) owed for `amount` (18 decimals) at the $1.50 floor, rounded up.
pub fn floor_min_out(amount: u128) -> u128 {
    (amount * MIN_PRICE_USD_E6).div_ceil(ONE_TOKEN)
}

/// Asserts the transaction failed with exactly `code` as a contract panic message.
pub fn assert_refused(result: &ExecutionFinalResult, code: &str) {
    let text = format!("{:?}", result.failures());
    let needle = format!("panicked: {code}");
    let exact = text.match_indices(&needle).any(|(i, _)| {
        !text[i + needle.len()..]
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphanumeric() || c == '_')
    });
    assert!(
        result.is_failure() && exact,
        "expected `{code}`, got: {text}"
    );
}

/// 0x-address of an uncompressed public key (x || y).
pub fn evm_address(xy: &[u8]) -> String {
    format!("0x{}", hex::encode(&Keccak256::digest(xy)[12..]))
}

/// Address recovered from a stored registry EVM signature over `hash_hex`.
pub fn recover_address(hash_hex: &str, signature: &Value) -> Result<String> {
    let big_r = hex::decode(signature["big_r"].as_str().unwrap_or_default())?;
    let s = hex::decode(signature["s"].as_str().unwrap_or_default())?;
    let mut rs = big_r[1..].to_vec();
    rs.extend_from_slice(&s);
    let sig = k256::ecdsa::Signature::from_slice(&rs)?;
    let recovery_id =
        k256::ecdsa::RecoveryId::from_byte(signature["recovery_id"].as_u64().unwrap_or(9) as u8)
            .ok_or_else(|| anyhow!("recovery id"))?;
    let key = k256::ecdsa::VerifyingKey::recover_from_prehash(
        &hex::decode(hash_hex)?,
        &sig,
        recovery_id,
    )?;
    Ok(evm_address(&key.to_encoded_point(false).as_bytes()[1..]))
}

/// The Chain Signatures tweak, computed independently of the contracts.
pub fn tweak(predecessor: &str, path: &str) -> [u8; 32] {
    Sha3_256::digest(format!(
        "near-mpc-recovery v0.1.0 epsilon derivation:{predecessor},{path}"
    ))
    .into()
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::Digest as _;
    hex::encode(sha2::Sha256::digest(bytes))
}
