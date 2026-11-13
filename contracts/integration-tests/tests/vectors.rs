//! Writes res/test-vectors.json so the TypeScript side can check its encoders byte-for-byte
//! against what the deployed contracts actually compute.

use integration_tests::*;
use serde_json::{json, Value};

const MAINNET_ROOT: &str = "secp256k1:3tFRbMqmoa6AAALMrEFAYCEoHcqKxeW38YptwowBVBtXK1vo36HDbUWuR6EZmoK4JcH6HDkNMGGqP1ouV7VZUWya";
const MAINNET_DERIVED: &str = "secp256k1:5zL9u9afiFPPrPmnH7rEz2t3szev5eZ7wXCwzYq37GYyCbJq3YNU31N4LTULioaw3chJx674XUncmYKiSCd3AxxT";

#[tokio::test]
async fn the_contracts_reproduce_the_published_cross_language_vectors() -> anyhow::Result<()> {
    let env = Env::new().await?;

    // 1. Chain Signatures derivation, run by the simulator wasm against the live mainnet root.
    let mainnet_sim = subaccount(&env.root, "mainnet-sim", 10)
        .await?
        .deploy(&wasm("mpc_signer_sim.wasm")?)
        .await?
        .into_result()?;
    mainnet_sim
        .call("new")
        .args_json(json!({ "root_public_key": MAINNET_ROOT, "responder": env.responder.id() }))
        .transact()
        .await?
        .into_result()?;
    let derived: String = mainnet_sim
        .view("derived_public_key")
        .args_json(json!({ "path": "ethereum-1", "predecessor": "example.near", "domain_id": 0 }))
        .await?
        .json()?;
    assert_eq!(derived, MAINNET_DERIVED);
    let derived_xy = bs58::decode(derived.trim_start_matches("secp256k1:")).into_vec()?;

    // 2. EIP-1559 preview from the registry, for the same fields as the viem vector in plan-registry/src/evm.rs.
    let mut args = env.evm_plan_args().await?;
    args["asset"]["chain_id"] = json!(11_155_111);
    let plan_id = env.active_plan(&args).await?;
    let action = json!({
        "type": "evm_erc20_transfer",
        "to": "0xd8da6bf26964af9d7eed9e03e53415d37aa96045",
        "amount": "1234567890000000000",
        "nonce": 7,
        "gas_limit": 65_000,
        "max_fee_per_gas": "30000000000",
        "max_priority_fee_per_gas": "1500000000",
    });
    let preview: Value = env
        .registry
        .view("evm_tx_preview")
        .args_json(json!({ "plan_id": plan_id, "action": action }))
        .await?
        .json()?;
    assert_eq!(
        preview["hash"],
        json!("859c3bd8b8d8a23372d8cb8995654256d07893472c22e3b653c4d40cc6067d8f")
    );

    // 3. A quote in 1Click's real format for the standard test sale. Built by the harness, it
    //    must equal the TypeScript simulator's vector byte for byte (Q and signature).
    let shared: Value = serde_json::from_str(&std::fs::read_to_string(res_path(
        "oneclick-quote-vectors.json",
    ))?)?;
    let sim = &shared["sim"];
    assert_eq!(sim["seed_hex"], json!(hex::encode(QUOTE_SIGNER_SEED)));
    assert_eq!(sim["public_key"], json!(env.quote_signer.public_key()));
    let terms = QuoteTerms {
        amount_out: 15_150_000,
        amount_in_usd_e12: 15_200_000_000_000,
        amount_out_usd_e12: 15_150_000_000_000,
        ..QuoteTerms::sale(
            "nep141:token.test.near",
            "venue.test.near",
            10_000_000_000_000_000_000,
            15_000_000,
            "beneficiary.test.near",
            1_789_999_000_000,
            "p1.registry.test.near",
        )
    };
    let settlement = signed_settlement(&env.quote_signer, &terms);
    assert_eq!(settlement["quote"]["payload"], sim["ordinary"]["q"]);
    assert_eq!(
        settlement["quote"]["signature"],
        sim["ordinary"]["signature"]
    );
    assert_eq!(
        json!(quote_signed_message(
            settlement["quote"]["payload"].as_str().unwrap_or_default()
        )),
        sim["ordinary"]["signed_message"]
    );

    // 4. A signed execute request with fixed content carrying that quote, issued at the quote's
    //    timestamp and expiring at its deadline, accepted by signature check on chain.
    let request_json = json!({
        "plan_id": 1,
        "seq": 0,
        "commitment": "11".repeat(32),
        "action": { "type": "nep141_transfer", "receiver_id": "venue.test.near", "amount": "10000000000000000000", "register_receiver": true },
        "settlement": settlement,
        "compliance": all_compliant(),
        "issued_at_ms": 1_789_998_400_000u64,
        "expires_at_ms": 1_789_999_000_000u64,
    })
    .to_string();
    let request_settlement: Value =
        serde_json::from_str::<Value>(&request_json)?["settlement"].clone();
    let signature = env.enclave.sign("vsp/execute/v1\n", &request_json);
    // The registry accepts the signature (the request then fails a later plan check, by design).
    let relayed = env
        .execute_signed(
            plan_id,
            &request_json,
            &signature,
            &env.enclave.public_key(),
            EXECUTE_DEPOSIT,
        )
        .await?;
    let failure = format!("{:?}", relayed.failures());
    assert!(!failure.contains("bad_signature"), "{failure}");

    let ft_args =
        r#"{"receiver_id":"venue.test.near","amount":"10000000000000000000","memo":"vsp/1/0"}"#;
    let vectors = json!({
        "about": "Generated by contracts/integration-tests/tests/vectors.rs from the deployed wasm. Test keys only.",
        "chain_signatures_derivation": {
            "root_public_key": MAINNET_ROOT,
            "predecessor": "example.near",
            "path": "ethereum-1",
            "tweak_sha3_256": hex::encode(tweak("example.near", "ethereum-1")),
            "derived_public_key": derived,
            "evm_address": evm_address(&derived_xy),
        },
        "eip1559_erc20_transfer": {
            "chain_id": 11_155_111,
            "token_address": EVM_TOKEN,
            "action": action,
            "unsigned_tx": preview["unsigned_tx"],
            "keccak256": preview["hash"],
        },
        "signed_execute": {
            "enclave_secret_seed_hex": hex::encode(ENCLAVE_SEED),
            "enclave_public_key": env.enclave.public_key(),
            "domain": "vsp/execute/v1\n",
            "request_json": request_json,
            "signature_base64": signature,
        },
        "quote": {
            "quote_signer_secret_seed_hex": hex::encode(QUOTE_SIGNER_SEED),
            "quote_signer_public_key": env.quote_signer.public_key(),
            "signed_message": quote_signed_message(
                request_settlement["quote"]["payload"].as_str().unwrap_or_default()
            ),
            "settlement": request_settlement,
        },
        "nep141_action_hash": {
            "ft_transfer_args": ft_args,
            "sha256": sha256_hex(ft_args.as_bytes()),
        },
    });
    std::fs::write(
        res_path("test-vectors.json"),
        serde_json::to_string_pretty(&vectors)? + "\n",
    )?;
    Ok(())
}
