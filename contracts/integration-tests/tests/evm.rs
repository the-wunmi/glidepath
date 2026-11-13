//! EVM plans: the registry builds and hashes the ERC-20 transfer, Chain Signatures signs it for the
//! plan's derived address, and failures give back the budget and the nonce.

use integration_tests::*;
use near_workspaces::types::{Gas, NearToken};
use serde_json::{json, Value};
use sha3::{Digest, Keccak256};

fn u128_of(value: &Value) -> u128 {
    value
        .as_str()
        .and_then(|s| s.parse().ok())
        .expect("U128 string")
}

async fn active_evm_plan(env: &Env) -> anyhow::Result<u64> {
    let args = env.evm_plan_args().await?;
    env.active_plan(&args).await
}

#[tokio::test]
async fn an_evm_sale_is_signed_by_the_plans_derived_address() -> anyhow::Result<()> {
    let env = Env::new().await?;
    let plan_id = active_evm_plan(&env).await?;
    let plan = env.plan(plan_id).await?;
    let expected = env
        .mpc
        .derived_address(env.registry.id().as_str(), &format!("plan/{plan_id}"))?;
    assert_eq!(plan["evm_address"], json!(expected));
    assert_eq!(
        plan["asset"]["token_address"],
        json!(EVM_TOKEN),
        "token address is lowercased"
    );

    let request = env.evm_sale(plan_id, 10 * ONE_TOKEN).await?;
    let preview: Value = env
        .registry
        .view("evm_tx_preview")
        .args_json(json!({ "plan_id": plan_id, "action": request["action"] }))
        .await?
        .json()?;
    let result = env.execute_evm(&request).await?;
    println!(
        "gas burnt by an EVM execute (all receipts, incl. MPC yield): {}",
        result.total_gas_burnt
    );
    for outcome in result.outcomes() {
        println!("  {} {}", outcome.executor_id, outcome.gas_burnt);
    }
    result.into_result()?;

    let receipt = &env.receipts(plan_id).await?[0];
    assert_eq!(receipt["status"], json!("done"));
    assert_eq!(receipt["evm_nonce"], json!(0));
    assert_eq!(receipt["evm_unsigned_tx"], preview["unsigned_tx"]);
    let unsigned = hex::decode(preview["unsigned_tx"].as_str().unwrap())?;
    assert_eq!(
        receipt["action_hash"],
        json!(hex::encode(Keccak256::digest(&unsigned)))
    );
    assert_eq!(preview["hash"], receipt["action_hash"]);
    let signer = recover_address(
        receipt["action_hash"].as_str().unwrap(),
        &receipt["evm_signature"],
    )?;
    assert_eq!(json!(signer), plan["evm_address"]);

    let plan = env.plan(plan_id).await?;
    assert_eq!(plan["evm_nonce"], json!(1));
    assert_eq!(plan["evm_sign_pending"], json!(false));
    assert_eq!(u128_of(&plan["sold_total"]), 10 * ONE_TOKEN);
    Ok(())
}

#[tokio::test]
async fn an_mpc_timeout_marks_the_sale_failed_and_returns_its_budget_and_nonce(
) -> anyhow::Result<()> {
    let env = Env::new().await?;
    let plan_id = active_evm_plan(&env).await?;
    let request = env.evm_sale(plan_id, 10 * ONE_TOKEN).await?;
    let request_json = request.to_string();
    let status = env
        .relayer
        .call(env.registry.id(), "execute")
        .args_json(json!({
            "plan_id": plan_id, "request_json": request_json,
            "signature": env.enclave.sign("vsp/execute/v1\n", &request_json),
            "enclave_key": env.enclave.public_key(),
        }))
        .deposit(EXECUTE_DEPOSIT)
        .gas(Gas::from_tgas(300))
        .transact_async()
        .await?;
    while env.pending_signatures().await?.is_empty() {
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }
    // While one signature is in flight, the next sale cannot take a nonce.
    let second = env.evm_sale(plan_id, ONE_TOKEN).await?;
    assert_refused(&env.execute(&second).await?, "sign_pending");

    // Nobody answers; the signer's yield times out after about 200 blocks.
    env.worker.fast_forward(250).await?;
    let result = env.wait_for(status).await?;
    assert!(result
        .logs()
        .iter()
        .any(|l| l.contains(r#""event":"settle_failed""#)));

    let plan = env.plan(plan_id).await?;
    assert_eq!(env.receipts(plan_id).await?[0]["status"], json!("failed"));
    assert_eq!(plan["evm_nonce"], json!(0), "the unused nonce is returned");
    assert_eq!(plan["evm_sign_pending"], json!(false));
    assert_eq!(plan["next_seq"], json!(1));
    assert_eq!(u128_of(&plan["sold_total"]), 0);
    assert!(env.pending_signatures().await?.is_empty());

    // The next request reuses nonce 0 and signs normally.
    let retry = env.evm_sale(plan_id, 10 * ONE_TOKEN).await?;
    assert_eq!(retry["action"]["nonce"], json!(0));
    env.execute_evm(&retry).await?.into_result()?;
    assert_eq!(env.receipts(plan_id).await?[1]["status"], json!("done"));
    Ok(())
}

#[tokio::test]
async fn evm_fee_caps_and_nonce_order_are_enforced() -> anyhow::Result<()> {
    let env = Env::new().await?;
    let plan_id = active_evm_plan(&env).await?;
    let cases: Vec<(&str, Value, &str)> = vec![
        ("/action/nonce", json!(1), "bad_nonce"),
        ("/action/gas_limit", json!(150_001), "gas_too_high"),
        (
            "/action/max_fee_per_gas",
            json!("500000000001"),
            "gas_too_high",
        ),
        (
            "/action/max_priority_fee_per_gas",
            json!("30000000001"),
            "gas_too_high",
        ),
        ("/action/to", json!("0x1234"), "invalid_evm_address"),
    ];
    for (pointer, value, code) in cases {
        let mut request = env.evm_sale(plan_id, ONE_TOKEN).await?;
        *request.pointer_mut(pointer).expect("field") = value;
        assert_refused(&env.execute(&request).await?, code);
    }
    let mut paying_elsewhere = env.evm_sale(plan_id, ONE_TOKEN).await?;
    paying_elsewhere["settlement"]["deposit_address"] = json!(EVM_BENEFICIARY);
    assert_refused(&env.execute(&paying_elsewhere).await?, "receiver_mismatch");
    // Address case does not matter, the bytes do.
    let mut mixed_case = env.evm_sale(plan_id, ONE_TOKEN).await?;
    mixed_case["settlement"]["deposit_address"] =
        json!(EVM_VENUE.to_uppercase().replace("0X", "0x"));
    env.execute_evm(&mixed_case).await?.into_result()?;
    Ok(())
}

#[tokio::test]
async fn an_ended_evm_plan_releases_only_to_the_beneficiary_address() -> anyhow::Result<()> {
    let env = Env::new().await?;
    let plan_id = active_evm_plan(&env).await?;
    let release_args = json!({
        "plan_id": plan_id, "amount": (500 * ONE_TOKEN).to_string(), "nonce": 0, "gas_limit": 65_000,
        "max_fee_per_gas": "30000000000", "max_priority_fee_per_gas": "1500000000",
    });
    let early = env
        .beneficiary
        .call(env.registry.id(), "release_evm")
        .args_json(&release_args)
        .deposit(EXECUTE_DEPOSIT)
        .gas(Gas::from_tgas(300))
        .transact()
        .await?;
    assert_refused(&early, "not_ended");

    env.owner
        .call(env.registry.id(), "request_cancel")
        .args_json(json!({ "plan_id": plan_id }))
        .deposit(NearToken::from_millinear(10))
        .transact()
        .await?
        .into_result()?;
    let effective = env.plan(plan_id).await?["pending_change"]["effective_at_ms"]
        .as_u64()
        .unwrap();
    env.advance_to(effective).await?;
    env.relayer
        .call(env.registry.id(), "finalize")
        .args_json(json!({ "plan_id": plan_id }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;

    let stranger = env
        .relayer
        .call(env.registry.id(), "release_evm")
        .args_json(&release_args)
        .deposit(EXECUTE_DEPOSIT)
        .gas(Gas::from_tgas(300))
        .transact()
        .await?;
    assert_refused(&stranger, "only_owner_or_beneficiary");

    let status = env
        .beneficiary
        .call(env.registry.id(), "release_evm")
        .args_json(&release_args)
        .deposit(EXECUTE_DEPOSIT)
        .gas(Gas::from_tgas(300))
        .transact_async()
        .await?;
    env.answer_mpc_until_done(status).await?.into_result()?;

    let receipt = &env.receipts(plan_id).await?[0];
    assert_eq!(receipt["kind"], json!("release"));
    assert_eq!(receipt["receiver"], json!(EVM_BENEFICIARY));
    assert_eq!(receipt["status"], json!("done"));
    let unsigned = receipt["evm_unsigned_tx"].as_str().unwrap();
    assert!(
        unsigned.contains(&EVM_BENEFICIARY[2..]),
        "the transfer pays the beneficiary"
    );
    let signer = recover_address(
        receipt["action_hash"].as_str().unwrap(),
        &receipt["evm_signature"],
    )?;
    assert_eq!(json!(signer), env.plan(plan_id).await?["evm_address"]);
    Ok(())
}

async fn resign(
    env: &Env,
    plan_id: u64,
    seq: u64,
    max_fee: &str,
    priority: &str,
) -> anyhow::Result<near_workspaces::operations::TransactionStatus> {
    resign_as(env, &env.owner, plan_id, seq, max_fee, priority).await
}

async fn resign_as(
    env: &Env,
    caller: &near_workspaces::Account,
    plan_id: u64,
    seq: u64,
    max_fee: &str,
    priority: &str,
) -> anyhow::Result<near_workspaces::operations::TransactionStatus> {
    Ok(caller
        .call(env.registry.id(), "resign_evm")
        .args_json(json!({
            "plan_id": plan_id, "seq": seq,
            "max_fee_per_gas": max_fee, "max_priority_fee_per_gas": priority,
        }))
        .deposit(EXECUTE_DEPOSIT)
        .gas(Gas::from_tgas(300))
        .transact_async()
        .await?)
}

#[tokio::test]
async fn the_owner_can_resign_the_latest_evm_transaction_with_higher_fees_and_it_keeps_its_nonce(
) -> anyhow::Result<()> {
    let env = Env::new().await?;
    let plan_id = active_evm_plan(&env).await?;
    env.execute_evm(&env.evm_sale(plan_id, 10 * ONE_TOKEN).await?)
        .await?
        .into_result()?;
    let before = env.receipts(plan_id).await?[0].clone();
    env.worker.fast_forward(30).await?;

    let result = env
        .answer_mpc_until_done(resign(&env, plan_id, 0, "60000000000", "3000000000").await?)
        .await?;
    assert!(result
        .logs()
        .iter()
        .any(|l| l.contains(r#""event":"resigned""#)
            && l.contains(&format!(r#""old_action_hash":{}"#, before["action_hash"]))));
    result.into_result()?;

    let after = env.receipts(plan_id).await?[0].clone();
    assert_ne!(after["evm_unsigned_tx"], before["evm_unsigned_tx"]);
    assert_eq!(after["evm_nonce"], json!(0));
    assert_eq!(after["status"], json!("done"));
    let unsigned = hex::decode(after["evm_unsigned_tx"].as_str().unwrap())?;
    assert_eq!(
        after["action_hash"],
        json!(hex::encode(Keccak256::digest(&unsigned)))
    );
    let preview: Value = env
        .registry
        .view("evm_tx_preview")
        .args_json(json!({ "plan_id": plan_id, "action": {
            "type": "evm_erc20_transfer", "to": EVM_VENUE, "amount": (10 * ONE_TOKEN).to_string(),
            "nonce": 0, "gas_limit": 65_000, "max_fee_per_gas": "60000000000",
            "max_priority_fee_per_gas": "3000000000",
        }}))
        .await?
        .json()?;
    assert_eq!(
        after["evm_unsigned_tx"], preview["unsigned_tx"],
        "same recipient, amount, nonce and gas limit"
    );
    let signer = recover_address(
        after["action_hash"].as_str().unwrap(),
        &after["evm_signature"],
    )?;
    assert_eq!(json!(signer), env.plan(plan_id).await?["evm_address"]);
    let plan = env.plan(plan_id).await?;
    assert_eq!(plan["evm_nonce"], json!(1), "no new nonce is used");
    assert_eq!(
        u128_of(&plan["sold_total"]),
        10 * ONE_TOKEN,
        "no new sale is counted"
    );

    // Fee caps still apply, and only the latest transaction can be re-signed.
    env.worker.fast_forward(30).await?;
    let too_high = env
        .wait_for(resign(&env, plan_id, 0, "500000000001", "1").await?)
        .await?;
    assert_refused(&too_high, "gas_too_high");
    env.execute_evm(&env.evm_sale(plan_id, ONE_TOKEN).await?)
        .await?
        .into_result()?;
    let older = env
        .wait_for(resign(&env, plan_id, 0, "60000000000", "3000000000").await?)
        .await?;
    assert_refused(&older, "not_latest");
    Ok(())
}

#[tokio::test]
async fn a_resign_that_times_out_leaves_the_receipt_as_it_was() -> anyhow::Result<()> {
    let env = Env::new().await?;
    let plan_id = active_evm_plan(&env).await?;
    env.execute_evm(&env.evm_sale(plan_id, 10 * ONE_TOKEN).await?)
        .await?
        .into_result()?;
    let before = env.receipts(plan_id).await?[0].clone();
    env.worker.fast_forward(30).await?;

    let status = resign(&env, plan_id, 0, "60000000000", "3000000000").await?;
    while env.pending_signatures().await?.is_empty() {
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }
    let clear = env
        .relayer
        .call(env.registry.id(), "clear_stale_sign")
        .args_json(json!({ "plan_id": plan_id }))
        .transact()
        .await?;
    assert_refused(&clear, "sign_not_stale");
    env.worker.fast_forward(250).await?;
    let result = env.wait_for(status).await?;
    assert!(result
        .logs()
        .iter()
        .any(|l| l.contains(r#""event":"resign_failed""#)));

    let after = env.receipts(plan_id).await?[0].clone();
    assert_eq!(after, before);
    let plan = env.plan(plan_id).await?;
    assert_eq!(plan["evm_sign_pending"], json!(false));
    assert_eq!(plan["evm_pending_sign"], Value::Null);
    let clear = env
        .relayer
        .call(env.registry.id(), "clear_stale_sign")
        .args_json(json!({ "plan_id": plan_id }))
        .transact()
        .await?;
    assert_refused(&clear, "no_sign_pending");
    Ok(())
}

/// An EVM plan with one signed sale (30 gwei max fee, 1.5 gwei tip) whose signature is 30 blocks old.
async fn plan_with_signed_sale(env: &Env) -> anyhow::Result<u64> {
    let plan_id = active_evm_plan(env).await?;
    env.execute_evm(&env.evm_sale(plan_id, 10 * ONE_TOKEN).await?)
        .await?
        .into_result()?;
    env.worker.fast_forward(30).await?;
    Ok(plan_id)
}

#[tokio::test]
async fn only_the_owner_or_the_beneficiary_can_resign() -> anyhow::Result<()> {
    let env = Env::new().await?;
    let plan_id = plan_with_signed_sale(&env).await?;
    let stranger = env
        .wait_for(resign_as(&env, &env.relayer, plan_id, 0, "60000000000", "3000000000").await?)
        .await?;
    assert_refused(&stranger, "only_owner_or_beneficiary");
    env.answer_mpc_until_done(
        resign_as(
            &env,
            &env.beneficiary,
            plan_id,
            0,
            "60000000000",
            "3000000000",
        )
        .await?,
    )
    .await?
    .into_result()?;
    Ok(())
}

#[tokio::test]
async fn a_resign_must_raise_both_fees_by_at_least_an_eighth() -> anyhow::Result<()> {
    let env = Env::new().await?;
    let plan_id = plan_with_signed_sale(&env).await?;
    let before = env.receipts(plan_id).await?[0].clone();
    // 30 gwei -> needs 33.75 gwei; 1.5 gwei tip -> needs 1.6875 gwei.
    for (max_fee, tip) in [
        ("33749999999", "3000000000"),
        ("60000000000", "1687499999"),
        ("1000000000", "1000000000"),
    ] {
        let result = env
            .wait_for(resign(&env, plan_id, 0, max_fee, tip).await?)
            .await?;
        assert_refused(&result, "fee_bump_too_small");
    }
    assert_eq!(env.receipts(plan_id).await?[0], before);
    env.answer_mpc_until_done(resign(&env, plan_id, 0, "33750000000", "1687500000").await?)
        .await?
        .into_result()?;
    let after = env.receipts(plan_id).await?[0].clone();
    assert_eq!(after["evm_max_fee_per_gas"], json!("33750000000"));
    assert_eq!(after["evm_max_priority_fee_per_gas"], json!("1687500000"));
    Ok(())
}

#[tokio::test]
async fn a_signature_cannot_be_replaced_within_30_blocks_of_landing() -> anyhow::Result<()> {
    let env = Env::new().await?;
    let plan_id = active_evm_plan(&env).await?;
    env.execute_evm(&env.evm_sale(plan_id, 10 * ONE_TOKEN).await?)
        .await?
        .into_result()?;
    let early = env
        .wait_for(resign(&env, plan_id, 0, "60000000000", "3000000000").await?)
        .await?;
    assert_refused(&early, "too_soon");
    let signed_at = env.receipts(plan_id).await?[0]["evm_signed_at_block"]
        .as_u64()
        .unwrap();
    let now = env.worker.view_block().await?.height();
    env.worker
        .fast_forward((signed_at + 30).saturating_sub(now))
        .await?;
    env.answer_mpc_until_done(resign(&env, plan_id, 0, "60000000000", "3000000000").await?)
        .await?
        .into_result()?;
    Ok(())
}
