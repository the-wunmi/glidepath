//! The coercion-safe Bitcoin vault against the Chain Signatures simulator: the delay, guardian
//! veto and claw-back, the refusals, and signatures checked here against an independent BIP143
//! implementation and the key derived for (vault contract, path).

use anyhow::{anyhow, Result};
use integration_tests::{assert_refused, subaccount, tweak, wasm, TestMpc};
use k256::ecdsa::signature::hazmat::PrehashVerifier;
use k256::elliptic_curve::sec1::ToEncodedPoint;
use k256::elliptic_curve::PrimeField;
use near_workspaces::network::Sandbox;
use near_workspaces::operations::TransactionStatus;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, Contract, Worker};
use ripemd::Ripemd160;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::task::Poll;
use std::time::{Duration, Instant};

const MIN_DELAY_MS: u64 = 60_000;
const PATH: &str = "savings";
/// BIP173 testnet P2WSH vector; any script type works as the recovery address.
const RECOVERY: &str = "tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7";
const RECOVERY_SCRIPT: &str =
    "00201863143c14c5166804bd19203356da136c985678cd4d27a1b8c6329604903262";
/// BIP350 testnet P2TR vector.
const DESTINATION: &str = "tb1pqqqqp399et2xygdj5xreqhjjvcmzhxw4aywxecjdzew6hylgvsesf3hn0c";
const DESTINATION_SCRIPT: &str =
    "5120000000c4a5cad46221b2a187905e5266362b99d5e91c6ce24d165dab93e86433";
const TXID_A: &str = "9f96ade4b41d5433f4eda31e1738ec2b36f6e7d1420d94a6af99801a88f7f7ff";
const TXID_B: &str = "8ac60eb9575db5b2d987e29f301b5b819ea83a5c6579d282d189cc04b8e151ef";
const DEPOSIT: NearToken = NearToken::from_millinear(100);
const SEQUENCE_RBF: u32 = 0xffff_fffd;

struct VaultEnv {
    worker: Worker<Sandbox>,
    signer: Contract,
    responder: Account,
    vault: Contract,
    owner: Account,
    guardian: Account,
    second_guardian: Account,
    stranger: Account,
    mpc: TestMpc,
}

impl VaultEnv {
    async fn new() -> Result<Self> {
        let worker = near_workspaces::sandbox().await?;
        let root = worker.root_account()?;
        let mpc = TestMpc::default();
        let responder = subaccount(&root, "responder", 10).await?;
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
        let vault = subaccount(&root, "vault", 20)
            .await?
            .deploy(&wasm("btc_vault.wasm")?)
            .await?
            .into_result()?;
        vault
            .call("new")
            .args_json(json!({ "signer_contract": signer.id(), "min_delay_ms": MIN_DELAY_MS }))
            .transact()
            .await?
            .into_result()?;
        Ok(Self {
            owner: subaccount(&root, "owner", 20).await?,
            guardian: subaccount(&root, "guardian", 20).await?,
            second_guardian: subaccount(&root, "guardian2", 20).await?,
            stranger: subaccount(&root, "stranger", 20).await?,
            worker,
            signer,
            responder,
            vault,
            mpc,
        })
    }

    async fn create_vault(&self) -> Result<u64> {
        let id: u64 = self
            .owner
            .call(self.vault.id(), "create_vault")
            .args_json(json!({
                "guardians": [self.guardian.id(), self.second_guardian.id()],
                "recovery_address": RECOVERY,
                "delay_ms": MIN_DELAY_MS,
                "path": PATH,
            }))
            .deposit(DEPOSIT)
            .max_gas()
            .transact()
            .await?
            .into_result()?
            .json()?;
        Ok(id)
    }

    /// The vault's compressed key, derived here from the MPC root without the contracts.
    fn derived_key(&self) -> Result<k256::PublicKey> {
        let tweak = Option::<k256::Scalar>::from(k256::Scalar::from_repr(
            tweak(self.vault.id().as_str(), PATH).into(),
        ))
        .ok_or_else(|| anyhow!("tweak"))?;
        let root = k256::PublicKey::from_sec1_bytes(&self.root_sec1()?)?;
        let point = (k256::ProjectivePoint::GENERATOR * tweak + root.to_projective()).to_affine();
        Ok(k256::PublicKey::from_affine(point)?)
    }

    fn root_sec1(&self) -> Result<Vec<u8>> {
        let text = self.mpc.root_public_key();
        let xy = bs58::decode(text.trim_start_matches("secp256k1:")).into_vec()?;
        Ok([&[0x04][..], &xy].concat())
    }

    async fn request(&self, account: &Account, args: Value) -> Result<ExecutionFinalResult> {
        Ok(account
            .call(self.vault.id(), "request_withdrawal")
            .args_json(args)
            .deposit(DEPOSIT)
            .max_gas()
            .transact()
            .await?)
    }

    async fn start(
        &self,
        account: &Account,
        method: &str,
        args: Value,
    ) -> Result<TransactionStatus> {
        Ok(account
            .call(self.vault.id(), method)
            .args_json(args)
            .deposit(DEPOSIT)
            .gas(Gas::from_tgas(300))
            .transact_async()
            .await?)
    }

    /// Plays the MPC network: answers every pending request until the transaction finishes.
    async fn answer_until_done(&self, status: TransactionStatus) -> Result<ExecutionFinalResult> {
        let deadline = Instant::now() + Duration::from_secs(120);
        loop {
            if let Poll::Ready(result) = status.status().await? {
                return Ok(result);
            }
            let pending: Vec<Value> = self
                .signer
                .view("pending_requests")
                .args_json(json!({}))
                .await?
                .json()?;
            for entry in pending {
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
            anyhow::ensure!(Instant::now() < deadline, "transaction did not finish");
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
    }

    async fn execute(&self, vault_id: u64, spend_id: u64) -> Result<ExecutionFinalResult> {
        let status = self
            .start(
                &self.stranger,
                "execute",
                json!({ "vault_id": vault_id, "spend_id": spend_id }),
            )
            .await?;
        self.answer_until_done(status).await
    }

    async fn spend(&self, vault_id: u64, spend_id: u64) -> Result<Value> {
        Ok(self
            .vault
            .view("get_spend")
            .args_json(json!({ "vault_id": vault_id, "spend_id": spend_id }))
            .await?
            .json()?)
    }

    async fn get_vault(&self, vault_id: u64) -> Result<Value> {
        Ok(self
            .vault
            .view("get_vault")
            .args_json(json!({ "vault_id": vault_id }))
            .await?
            .json()?)
    }

    async fn wait_out_delay(&self) -> Result<()> {
        let now = || async {
            Ok::<_, anyhow::Error>(self.worker.view_block().await?.timestamp() / 1_000_000)
        };
        let target = now().await? + MIN_DELAY_MS;
        while now().await? < target {
            // Sandbox blocks advance block time by roughly 300 ms each.
            self.worker.fast_forward(50).await?;
        }
        Ok(())
    }
}

fn withdrawal(vault_id: u64) -> Value {
    json!({
        "vault_id": vault_id,
        "destination": DESTINATION,
        "amount": "150000",
        "inputs": [
            { "txid": TXID_A, "vout": 0, "amount": "120000" },
            { "txid": TXID_B, "vout": 3, "amount": "80000" },
        ],
        "fee": "1130",
    })
}

fn sha256d(data: &[u8]) -> [u8; 32] {
    Sha256::digest(Sha256::digest(data)).into()
}

fn hash160(data: &[u8]) -> Vec<u8> {
    Ripemd160::digest(Sha256::digest(data)).to_vec()
}

struct Input {
    txid: &'static str,
    vout: u32,
    amount: u64,
}

/// BIP143 (SIGHASH_ALL, P2WPKH), written here independently of the contract.
fn bip143(
    inputs: &[Input],
    outputs: &[(u64, Vec<u8>)],
    index: usize,
    pubkey_hash: &[u8],
) -> Vec<u8> {
    let outpoint = |i: &Input| {
        let mut txid = hex::decode(i.txid).expect("txid");
        txid.reverse();
        [txid, i.vout.to_le_bytes().to_vec()].concat()
    };
    let prevouts: Vec<u8> = inputs.iter().flat_map(outpoint).collect();
    let sequences: Vec<u8> = inputs
        .iter()
        .flat_map(|_| SEQUENCE_RBF.to_le_bytes())
        .collect();
    let outs: Vec<u8> = outputs
        .iter()
        .flat_map(|(value, script)| {
            [
                value.to_le_bytes().to_vec(),
                vec![script.len() as u8],
                script.clone(),
            ]
            .concat()
        })
        .collect();
    let input = &inputs[index];
    let preimage = [
        2u32.to_le_bytes().to_vec(),
        sha256d(&prevouts).to_vec(),
        sha256d(&sequences).to_vec(),
        outpoint(input),
        [&[0x19, 0x76, 0xa9, 0x14][..], pubkey_hash, &[0x88, 0xac]].concat(),
        input.amount.to_le_bytes().to_vec(),
        SEQUENCE_RBF.to_le_bytes().to_vec(),
        sha256d(&outs).to_vec(),
        0u32.to_le_bytes().to_vec(),
        1u32.to_le_bytes().to_vec(),
    ]
    .concat();
    sha256d(&preimage).to_vec()
}

/// Outputs (value, script) of an unsigned transaction with empty scriptSigs and small counts.
fn outputs_of(unsigned_hex: &str) -> Vec<(u64, Vec<u8>)> {
    let tx = hex::decode(unsigned_hex).expect("hex");
    let inputs = tx[4] as usize;
    let mut at = 5 + inputs * 41;
    let count = tx[at] as usize;
    at += 1;
    (0..count)
        .map(|_| {
            let value = u64::from_le_bytes(tx[at..at + 8].try_into().expect("value"));
            let len = tx[at + 8] as usize;
            let script = tx[at + 9..at + 9 + len].to_vec();
            at += 9 + len;
            (value, script)
        })
        .collect()
}

/// Testnet bech32 P2WPKH address, encoded here independently of the contract.
fn p2wpkh_address(pubkey_hash: &[u8]) -> String {
    const CHARSET: &[u8] = b"qpzry9x8gf2tvdw0s3jn54khce6mua7l";
    let mut data = vec![0u8];
    let (mut acc, mut bits) = (0u32, 0u32);
    for b in pubkey_hash {
        acc = (acc << 8) | u32::from(*b);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            data.push(((acc >> bits) & 31) as u8);
        }
    }
    if bits > 0 {
        data.push(((acc << (5 - bits)) & 31) as u8);
    }
    let polymod = |values: &[u8]| {
        let gen = [
            0x3b6a57b2u32,
            0x26508e6d,
            0x1ea119fa,
            0x3d4233dd,
            0x2a1462b3,
        ];
        let mut chk = 1u32;
        for v in values {
            let top = chk >> 25;
            chk = ((chk & 0x1ffffff) << 5) ^ u32::from(*v);
            for (i, g) in gen.iter().enumerate() {
                if (top >> i) & 1 == 1 {
                    chk ^= g;
                }
            }
        }
        chk
    };
    let mut values = vec![3, 3, 0, 20, 2];
    values.extend_from_slice(&data);
    values.extend_from_slice(&[0; 6]);
    let checksum = polymod(&values) ^ 1;
    let mut out = String::from("tb1");
    for v in data {
        out.push(CHARSET[v as usize] as char);
    }
    for i in 0..6 {
        out.push(CHARSET[((checksum >> (5 * (5 - i))) & 31) as usize] as char);
    }
    out
}

/// Every stored signature verifies against `key` over the independently computed hash.
fn assert_signatures_verify(
    spend: &Value,
    key: &k256::PublicKey,
    sighashes: &[Vec<u8>],
) -> Result<()> {
    let verifying = k256::ecdsa::VerifyingKey::from(key);
    for (i, input) in spend["inputs"]
        .as_array()
        .ok_or_else(|| anyhow!("inputs"))?
        .iter()
        .enumerate()
    {
        let sig = &input["signature"];
        let r = hex::decode(sig["big_r"].as_str().unwrap_or_default())?;
        let s = hex::decode(sig["s"].as_str().unwrap_or_default())?;
        let signature = k256::ecdsa::Signature::from_slice(&[&r[1..], &s[..]].concat())?;
        verifying.verify_prehash(&sighashes[i], &signature)?;
        let mut tampered = sighashes[i].clone();
        tampered[0] ^= 1;
        assert!(verifying.verify_prehash(&tampered, &signature).is_err());
    }
    Ok(())
}

#[tokio::test]
async fn a_withdrawal_waits_out_the_delay_then_gets_signatures_that_verify_under_bip143(
) -> Result<()> {
    let env = VaultEnv::new().await?;
    let vault_id = env.create_vault().await?;
    let key = env.derived_key()?;
    let compressed = key.to_encoded_point(true).as_bytes().to_vec();
    let pubkey_hash = hash160(&compressed);
    let vault = env.get_vault(vault_id).await?;
    assert_eq!(vault["public_key"], json!(hex::encode(&compressed)));
    assert_eq!(vault["address"], json!(p2wpkh_address(&pubkey_hash)));

    let spend_id: u64 = env
        .request(&env.owner, withdrawal(vault_id))
        .await?
        .into_result()?
        .json()?;
    let spend = env.spend(vault_id, spend_id).await?;
    assert_eq!(spend["status"], json!("pending"));
    assert_eq!(spend["change"], json!("48870"));
    let delay = spend["effective_at_ms"].as_u64().unwrap_or(0)
        - spend["requested_at_ms"].as_u64().unwrap_or(0);
    assert_eq!(delay, MIN_DELAY_MS);

    // Before the delay nobody, not even with the owner's key, can get it signed.
    assert_refused(&env.execute(vault_id, spend_id).await?, "delay_not_over");
    env.wait_out_delay().await?;
    let result = env.execute(vault_id, spend_id).await?;
    assert!(
        result
            .logs()
            .iter()
            .any(|l| l.contains(r#""event":"spend_signed""#)),
        "{:?}",
        result.logs()
    );

    let spend = env.spend(vault_id, spend_id).await?;
    assert_eq!(spend["status"], json!("signed"));
    let inputs = [
        Input {
            txid: TXID_A,
            vout: 0,
            amount: 120_000,
        },
        Input {
            txid: TXID_B,
            vout: 3,
            amount: 80_000,
        },
    ];
    let outputs = vec![
        (150_000, hex::decode(DESTINATION_SCRIPT)?),
        (48_870, [&[0x00, 0x14][..], &pubkey_hash].concat()),
    ];
    assert_eq!(
        outputs_of(spend["unsigned_tx"].as_str().unwrap_or_default()),
        outputs
    );
    let sighashes: Vec<Vec<u8>> = (0..2)
        .map(|i| bip143(&inputs, &outputs, i, &pubkey_hash))
        .collect();
    assert_eq!(
        spend["sighashes"],
        json!(sighashes.iter().map(hex::encode).collect::<Vec<_>>())
    );
    assert_signatures_verify(&spend, &key, &sighashes)?;

    // A signed request is final: it cannot be signed again.
    assert_refused(&env.execute(vault_id, spend_id).await?, "not_pending");
    Ok(())
}

#[tokio::test]
async fn a_guardian_veto_stops_a_withdrawal_for_good() -> Result<()> {
    let env = VaultEnv::new().await?;
    let vault_id = env.create_vault().await?;
    let spend_id: u64 = env
        .request(&env.owner, withdrawal(vault_id))
        .await?
        .into_result()?
        .json()?;
    // One open withdrawal at a time.
    assert_refused(
        &env.request(&env.owner, withdrawal(vault_id)).await?,
        "withdrawal_open",
    );

    let veto = |account: &Account| {
        account
            .call(env.vault.id(), "veto")
            .args_json(json!({ "vault_id": vault_id, "spend_id": spend_id }))
            .deposit(DEPOSIT)
            .transact()
    };
    assert_refused(&veto(&env.stranger).await?, "only_guardian");
    assert_refused(&veto(&env.owner).await?, "only_guardian");
    let vetoed = veto(&env.second_guardian).await?.into_result()?;
    assert!(vetoed
        .logs()
        .iter()
        .any(|l| l.contains(r#""event":"withdrawal_vetoed""#)));
    let spend = env.spend(vault_id, spend_id).await?;
    assert_eq!(spend["status"], json!("vetoed"));
    assert_eq!(spend["vetoed_by"], json!(env.second_guardian.id()));

    env.wait_out_delay().await?;
    assert_refused(&env.execute(vault_id, spend_id).await?, "not_pending");
    assert_refused(&veto(&env.guardian).await?, "not_pending");
    // The owner can ask again, publicly and with the full delay.
    assert_eq!(
        env.get_vault(vault_id).await?["open_withdrawal"],
        Value::Null
    );
    let again: u64 = env
        .request(&env.owner, withdrawal(vault_id))
        .await?
        .into_result()?
        .json()?;
    assert_eq!(
        env.spend(vault_id, again).await?["status"],
        json!("pending")
    );
    Ok(())
}

#[tokio::test]
async fn a_claw_back_signs_at_once_and_pays_only_the_recovery_address() -> Result<()> {
    let env = VaultEnv::new().await?;
    let vault_id = env.create_vault().await?;
    let key = env.derived_key()?;
    let pubkey_hash = hash160(key.to_encoded_point(true).as_bytes());
    let withdrawal_id: u64 = env
        .request(&env.owner, withdrawal(vault_id))
        .await?
        .into_result()?
        .json()?;

    let args = json!({
        "vault_id": vault_id,
        "inputs": [
            { "txid": TXID_A, "vout": 0, "amount": "120000" },
            { "txid": TXID_B, "vout": 3, "amount": "80000" },
        ],
        "fee": "700",
    });
    let refused = env.start(&env.owner, "claw_back", args.clone()).await?;
    assert_refused(&env.answer_until_done(refused).await?, "only_guardian");

    let status = env.start(&env.guardian, "claw_back", args).await?;
    let result = env.answer_until_done(status).await?;
    assert!(result
        .logs()
        .iter()
        .any(|l| l.contains(r#""event":"withdrawal_cancelled""#)));
    assert!(result
        .logs()
        .iter()
        .any(|l| l.contains(r#""event":"spend_signed""#)));
    assert_eq!(
        env.spend(vault_id, withdrawal_id).await?["status"],
        json!("cancelled")
    );

    let clawback = env.spend(vault_id, withdrawal_id + 1).await?;
    assert_eq!(clawback["kind"], json!("clawback"));
    assert_eq!(clawback["status"], json!("signed"));
    assert_eq!(clawback["destination"], json!(RECOVERY));
    let outputs = outputs_of(clawback["unsigned_tx"].as_str().unwrap_or_default());
    assert_eq!(
        outputs,
        vec![(200_000 - 700, hex::decode(RECOVERY_SCRIPT)?)]
    );
    let inputs = [
        Input {
            txid: TXID_A,
            vout: 0,
            amount: 120_000,
        },
        Input {
            txid: TXID_B,
            vout: 3,
            amount: 80_000,
        },
    ];
    let sighashes: Vec<Vec<u8>> = (0..2)
        .map(|i| bip143(&inputs, &outputs, i, &pubkey_hash))
        .collect();
    assert_signatures_verify(&clawback, &key, &sighashes)?;
    Ok(())
}

#[tokio::test]
async fn unsafe_or_malformed_requests_are_refused() -> Result<()> {
    let env = VaultEnv::new().await?;
    let vault_id = env.create_vault().await?;
    let with = |field: &str, value: Value| {
        let mut args = withdrawal(vault_id);
        args[field] = value;
        args
    };
    let input = |txid: &str, vout: u32, amount: &str| json!({ "txid": txid, "vout": vout, "amount": amount });
    let cases = [
        // 221 vB at most 25 sat/vB is 5,525 sats for a withdrawal.
        (with("fee", json!("6000")), "fee_too_high"),
        (with("fee", json!("100")), "fee_below_relay_minimum"),
        (with("amount", json!("198500")), "change_below_dust"),
        (with("amount", json!("199000")), "insufficient_inputs"),
        (with("amount", json!("500")), "amount_below_dust"),
        (
            with(
                "destination",
                json!("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"),
            ),
            "invalid_btc_address",
        ),
        (
            with(
                "destination",
                json!("tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsy"),
            ),
            "invalid_btc_address",
        ),
        (
            with(
                "inputs",
                json!([input(TXID_A, 0, "120000"), input(TXID_A, 0, "80000")]),
            ),
            "duplicate_input",
        ),
        (
            with("inputs", json!([input("abcd", 0, "200000")])),
            "invalid_txid",
        ),
        (with("inputs", json!([])), "bad_inputs"),
        (
            with(
                "inputs",
                json!((0..5)
                    .map(|v| input(TXID_A, v, "50000"))
                    .collect::<Vec<_>>()),
            ),
            "bad_inputs",
        ),
    ];
    for (args, code) in cases {
        assert_refused(&env.request(&env.owner, args).await?, code);
    }
    // Only the owner can ask, and only with a full-access key (1 yocto).
    assert_refused(
        &env.request(&env.stranger, withdrawal(vault_id)).await?,
        "only_owner",
    );
    assert_refused(
        &env.request(&env.guardian, withdrawal(vault_id)).await?,
        "only_owner",
    );
    let no_deposit = env
        .owner
        .call(env.vault.id(), "request_withdrawal")
        .args_json(withdrawal(vault_id))
        .max_gas()
        .transact()
        .await?;
    assert_refused(&no_deposit, "insufficient_deposit");

    // Nobody can feed the vault a signature through its callback.
    let forged = env
        .stranger
        .call(env.vault.id(), "on_signed")
        .args_json(json!({
            "vault_id": vault_id, "spend_id": 1, "round": 1, "indexes": [0],
            "sighashes": ["00".repeat(32)],
        }))
        .max_gas()
        .transact()
        .await?;
    assert!(format!("{:?}", forged.failures()).contains("is private"));

    let create = |guardians: Value, recovery: &str, delay: u64, path: &str| {
        env.owner
            .call(env.vault.id(), "create_vault")
            .args_json(json!({
                "guardians": guardians, "recovery_address": recovery,
                "delay_ms": delay, "path": path,
            }))
            .deposit(DEPOSIT)
            .max_gas()
            .transact()
    };
    let guardian = json!([env.guardian.id()]);
    assert_refused(
        &create(json!([env.owner.id()]), RECOVERY, MIN_DELAY_MS, "b").await?,
        "owner_is_guardian",
    );
    assert_refused(
        &create(json!([]), RECOVERY, MIN_DELAY_MS, "b").await?,
        "bad_guardians",
    );
    assert_refused(
        &create(guardian.clone(), "mainnet", MIN_DELAY_MS, "b").await?,
        "invalid_btc_address",
    );
    assert_refused(
        &create(guardian.clone(), RECOVERY, MIN_DELAY_MS - 1, "b").await?,
        "delay_too_short",
    );
    assert_refused(
        &create(guardian.clone(), RECOVERY, MIN_DELAY_MS, PATH).await?,
        "path_taken",
    );
    assert_refused(
        &create(guardian, RECOVERY, MIN_DELAY_MS, "Bad Path").await?,
        "bad_path",
    );
    Ok(())
}

#[tokio::test]
async fn a_signer_timeout_signs_nothing_and_the_withdrawal_can_be_executed_again() -> Result<()> {
    let env = VaultEnv::new().await?;
    let vault_id = env.create_vault().await?;
    let spend_id: u64 = env
        .request(&env.owner, withdrawal(vault_id))
        .await?
        .into_result()?
        .json()?;
    env.wait_out_delay().await?;
    let status = env
        .start(
            &env.stranger,
            "execute",
            json!({ "vault_id": vault_id, "spend_id": spend_id }),
        )
        .await?;
    loop {
        let pending: Vec<Value> = env
            .signer
            .view("pending_requests")
            .args_json(json!({}))
            .await?
            .json()?;
        if pending.len() == 2 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    assert_eq!(
        env.spend(vault_id, spend_id).await?["status"],
        json!("signing")
    );
    let again = env
        .stranger
        .call(env.vault.id(), "execute")
        .args_json(json!({ "vault_id": vault_id, "spend_id": spend_id }))
        .deposit(DEPOSIT)
        .max_gas()
        .transact()
        .await?;
    assert_refused(&again, "sign_pending");

    // Nobody answers; the signer's yields time out after about 200 blocks.
    env.worker.fast_forward(250).await?;
    let deadline = Instant::now() + Duration::from_secs(120);
    let result = loop {
        if let Poll::Ready(result) = status.status().await? {
            break result;
        }
        anyhow::ensure!(Instant::now() < deadline, "execute did not finish");
        tokio::time::sleep(Duration::from_millis(300)).await;
    };
    assert!(
        result
            .logs()
            .iter()
            .any(|l| l.contains(r#""event":"sign_failed""#)),
        "{:?}",
        result.logs()
    );
    let spend = env.spend(vault_id, spend_id).await?;
    assert_eq!(spend["status"], json!("pending"));
    assert!(spend["inputs"]
        .as_array()
        .into_iter()
        .flatten()
        .all(|i| i["signature"].is_null()));

    assert_eq!(spend["sign_rounds"], json!(1));
    // A failed round may still have published signatures (in the signer's answer), so a veto no
    // longer means anything: the contract refuses it, and only a claw-back can act.
    let veto = env
        .guardian
        .call(env.vault.id(), "veto")
        .args_json(json!({ "vault_id": vault_id, "spend_id": spend_id }))
        .deposit(DEPOSIT)
        .transact()
        .await?;
    assert_refused(&veto, "signing_started");

    env.execute(vault_id, spend_id).await?.into_result()?;
    assert_eq!(
        env.spend(vault_id, spend_id).await?["status"],
        json!("signed")
    );
    Ok(())
}

#[tokio::test]
async fn signatures_bind_to_their_transaction_and_a_wrong_amount_freezes_nothing() -> Result<()> {
    let env = VaultEnv::new().await?;
    let vault_id = env.create_vault().await?;
    let spend_id: u64 = env
        .request(&env.owner, withdrawal(vault_id))
        .await?
        .into_result()?
        .json()?;
    env.wait_out_delay().await?;
    let signing = env
        .start(
            &env.stranger,
            "execute",
            json!({ "vault_id": vault_id, "spend_id": spend_id }),
        )
        .await?;
    loop {
        let pending: Vec<Value> = env
            .signer
            .view("pending_requests")
            .args_json(json!({}))
            .await?
            .json()?;
        if pending.len() == 2 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    let input = |txid: &str, vout: u32, amount: &str| json!({ "txid": txid, "vout": vout, "amount": amount });
    let claw_args =
        |inputs: Value, fee: &str| json!({ "vault_id": vault_id, "inputs": inputs, "fee": fee });
    let claw = |inputs: Value, fee: &str| {
        env.guardian
            .call(env.vault.id(), "claw_back")
            .args_json(claw_args(inputs, fee))
            .deposit(DEPOSIT)
            .gas(Gas::from_tgas(300))
            .transact()
    };
    // While a spend is signing, nothing else may use its coins.
    assert_refused(
        &claw(json!([input(TXID_A, 0, "120000")]), "400").await?,
        "inputs_overlap",
    );
    env.answer_until_done(signing).await?.into_result()?;

    // Same outpoints and outputs as the signed withdrawal, amounts swapped between the inputs:
    // its signatures could be mixed with the first one's, so it is refused.
    let mut swapped = withdrawal(vault_id);
    swapped["inputs"] = json!([input(TXID_A, 0, "121000"), input(TXID_B, 3, "79000")]);
    assert_refused(
        &env.request(&env.owner, swapped).await?,
        "input_amount_mismatch",
    );

    // A claw-back over the signed withdrawal's coins must outbid it (1,130 sats + 1 sat/vB).
    let same_set = json!([input(TXID_A, 0, "120000"), input(TXID_B, 3, "80000")]);
    assert_refused(
        &claw(same_set.clone(), "1200").await?,
        "fee_below_replacement",
    );

    // A claw-back naming a wrong amount signs (Bitcoin would reject those signatures) and freezes
    // nothing: the corrected one has other outputs, so it signs too.
    let wrong = json!([input(TXID_A, 0, "100000"), input(TXID_B, 3, "80000")]);
    for (inputs, id) in [(wrong, spend_id + 1), (same_set, spend_id + 2)] {
        let status = env
            .start(&env.guardian, "claw_back", claw_args(inputs, "2000"))
            .await?;
        env.answer_until_done(status).await?.into_result()?;
        assert_eq!(env.spend(vault_id, id).await?["status"], json!("signed"));
    }
    // The wrong claw-back's outpoints and outputs stay bound to its amounts.
    assert_refused(
        &claw(
            json!([input(TXID_A, 0, "101000"), input(TXID_B, 3, "79000")]),
            "2000",
        )
        .await?,
        "input_amount_mismatch",
    );
    // The owner can still withdraw those coins with other outputs.
    let mut corrected = withdrawal(vault_id);
    corrected["amount"] = json!("140000");
    env.request(&env.owner, corrected).await?.into_result()?;
    Ok(())
}
