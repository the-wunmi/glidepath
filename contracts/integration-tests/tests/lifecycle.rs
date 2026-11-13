//! Plan changes and cancellations wait out the cooling-off; ended plans release to the beneficiary.

use integration_tests::*;
use near_workspaces::types::NearToken;
use near_workspaces::Account;
use serde_json::{json, Value};

async fn request_change(
    env: &Env,
    caller: &Account,
    plan_id: u64,
    commitment: &str,
    envelope: &Value,
) -> anyhow::Result<near_workspaces::result::ExecutionFinalResult> {
    Ok(caller
        .call(env.registry.id(), "request_change")
        .args_json(json!({ "plan_id": plan_id, "commitment": commitment, "envelope": envelope }))
        .deposit(NearToken::from_millinear(10))
        .transact()
        .await?)
}

async fn owner_call(
    env: &Env,
    method: &str,
    plan_id: u64,
) -> anyhow::Result<near_workspaces::result::ExecutionFinalResult> {
    // Methods that add storage take a deposit; the rest refuse one.
    let deposit = if method == "withdraw_change" {
        NearToken::from_yoctonear(0)
    } else {
        NearToken::from_millinear(10)
    };
    Ok(env
        .owner
        .call(env.registry.id(), method)
        .args_json(json!({ "plan_id": plan_id }))
        .deposit(deposit)
        .max_gas()
        .transact()
        .await?)
}

async fn finalize(
    env: &Env,
    plan_id: u64,
) -> anyhow::Result<near_workspaces::result::ExecutionFinalResult> {
    Ok(env
        .relayer
        .call(env.registry.id(), "finalize")
        .args_json(json!({ "plan_id": plan_id }))
        .max_gas()
        .transact()
        .await?)
}

#[tokio::test]
async fn a_plan_change_waits_out_the_cooling_off_and_an_ack_while_the_old_plan_keeps_executing(
) -> anyhow::Result<()> {
    let env = Env::new().await?;
    let (_token, plan_id) = env.funded_nep141_plan(None).await?;
    let old_commitment = env.plan(plan_id).await?["commitment"].clone();
    let new_commitment = "33".repeat(32);
    let mut new_envelope = default_envelope();
    new_envelope["max_amount_per_tx"] = json!((20 * ONE_TOKEN).to_string());

    assert_refused(
        &request_change(&env, &env.relayer, plan_id, &new_commitment, &new_envelope).await?,
        "only_owner",
    );
    let result = request_change(&env, &env.owner, plan_id, &new_commitment, &new_envelope).await?;
    assert!(result
        .logs()
        .iter()
        .any(|l| l.contains(r#""event":"change_requested""#)));
    assert_refused(
        &request_change(&env, &env.owner, plan_id, &new_commitment, &new_envelope).await?,
        "change_pending",
    );
    let pending = env.plan(plan_id).await?["pending_change"].clone();
    assert_eq!(pending["kind"], json!("modify"));

    // Too early: the enclave cannot switch, and the new commitment cannot execute.
    assert_refused(
        &env.ack(plan_id, &json!(new_commitment), &new_envelope)
            .await?,
        "cooling_off",
    );
    let mut early = env.nep141_sale(plan_id, ONE_TOKEN).await?;
    early["commitment"] = json!(new_commitment);
    assert_refused(&env.execute(&early).await?, "commitment_mismatch");
    // The old plan keeps running during the cooling-off.
    env.execute(&env.nep141_sale(plan_id, 50 * ONE_TOKEN).await?)
        .await?
        .into_result()?;

    env.advance_to(pending["effective_at_ms"].as_u64().unwrap())
        .await?;
    // Effective but not yet acknowledged: still only the old commitment executes.
    let mut unacked = env.nep141_sale(plan_id, ONE_TOKEN).await?;
    unacked["commitment"] = json!(new_commitment);
    assert_refused(&env.execute(&unacked).await?, "commitment_mismatch");
    // An ack for a different envelope than the one requested publicly is refused.
    assert_refused(
        &env.ack(plan_id, &json!(new_commitment), &default_envelope())
            .await?,
        "envelope_mismatch",
    );

    let applied = env
        .ack(plan_id, &json!(new_commitment), &new_envelope)
        .await?;
    assert!(applied
        .logs()
        .iter()
        .any(|l| l.contains(r#""event":"change_applied""#)));
    let plan = env.plan(plan_id).await?;
    assert_eq!(plan["commitment"], json!(new_commitment));
    assert_eq!(plan["pending_change"], Value::Null);

    let mut stale = env.nep141_sale(plan_id, ONE_TOKEN).await?;
    stale["commitment"] = old_commitment;
    assert_refused(&env.execute(&stale).await?, "commitment_mismatch");
    // The new envelope's smaller per-tx cap applies at once.
    assert_refused(
        &env.execute(&env.nep141_sale(plan_id, 21 * ONE_TOKEN).await?)
            .await?,
        "tx_cap_exceeded",
    );
    env.execute(&env.nep141_sale(plan_id, 20 * ONE_TOKEN).await?)
        .await?
        .into_result()?;
    Ok(())
}

#[tokio::test]
async fn a_pending_change_can_be_withdrawn_by_the_owner_only() -> anyhow::Result<()> {
    let env = Env::new().await?;
    let (_token, plan_id) = env.funded_nep141_plan(None).await?;
    assert_refused(
        &owner_call(&env, "withdraw_change", plan_id).await?,
        "no_pending_change",
    );
    owner_call(&env, "request_cancel", plan_id)
        .await?
        .into_result()?;

    let by_stranger = env
        .relayer
        .call(env.registry.id(), "withdraw_change")
        .args_json(json!({ "plan_id": plan_id }))
        .transact()
        .await?;
    assert_refused(&by_stranger, "only_owner");
    let withdrawn = owner_call(&env, "withdraw_change", plan_id).await?;
    assert!(withdrawn
        .logs()
        .iter()
        .any(|l| l.contains(r#""event":"change_withdrawn""#)));
    assert_eq!(env.plan(plan_id).await?["pending_change"], Value::Null);
    Ok(())
}

#[tokio::test]
async fn a_cancel_waits_out_the_cooling_off_then_finalize_releases_everything_to_the_beneficiary(
) -> anyhow::Result<()> {
    let env = Env::new().await?;
    let (token, plan_id) = env.funded_nep141_plan(None).await?;
    env.execute(&env.nep141_sale(plan_id, 10 * ONE_TOKEN).await?)
        .await?
        .into_result()?;

    assert_refused(
        &env.relayer
            .call(env.registry.id(), "request_cancel")
            .args_json(json!({ "plan_id": plan_id }))
            .transact()
            .await?,
        "only_owner",
    );
    let requested = owner_call(&env, "request_cancel", plan_id).await?;
    assert!(requested
        .logs()
        .iter()
        .any(|l| l.contains(r#""event":"cancel_requested""#)));
    assert_refused(&finalize(&env, plan_id).await?, "cooling_off");
    // Sales continue under the old plan until the cancel takes effect.
    env.execute(&env.nep141_sale(plan_id, 10 * ONE_TOKEN).await?)
        .await?
        .into_result()?;

    let effective = env.plan(plan_id).await?["pending_change"]["effective_at_ms"]
        .as_u64()
        .unwrap();
    env.advance_to(effective).await?;
    let ended = finalize(&env, plan_id).await?;
    assert!(ended
        .logs()
        .iter()
        .any(|l| l.contains(r#""event":"plan_ended""#)));
    ended.into_result()?;

    assert_eq!(env.plan(plan_id).await?["status"], json!("ended"));
    assert_eq!(
        env.ft_balance(token.id(), env.beneficiary.id()).await?,
        9_980 * ONE_TOKEN
    );
    assert_eq!(
        env.ft_balance(token.id(), &env.plan_account(plan_id))
            .await?,
        0
    );
    assert_refused(
        &env.execute(&env.nep141_sale(plan_id, ONE_TOKEN).await?)
            .await?,
        "not_active",
    );
    // Finalizing again is harmless and only ever pays the beneficiary.
    finalize(&env, plan_id).await?.into_result()?;
    assert_eq!(
        env.ft_balance(token.id(), env.beneficiary.id()).await?,
        9_980 * ONE_TOKEN
    );
    Ok(())
}

#[tokio::test]
async fn a_plan_that_reached_its_end_stops_selling_and_releases_to_the_beneficiary(
) -> anyhow::Result<()> {
    let env = Env::new().await?;
    let token_id = format!("token.{}", env.root.id()).parse()?;
    let mut args = env.nep141_plan_args(&token_id).await?;
    let end_ms = env.now_ms().await? + 20_000;
    args["end_ms"] = json!(end_ms);
    let plan_id = env.active_plan(&args).await?;
    let token = env
        .deploy_token(
            "token",
            18,
            vec![(env.plan_account(plan_id), 500 * ONE_TOKEN)],
        )
        .await?;
    assert_refused(&finalize(&env, plan_id).await?, "not_ended");

    env.advance_to(end_ms).await?;
    assert_refused(
        &env.execute(&env.nep141_sale(plan_id, ONE_TOKEN).await?)
            .await?,
        "plan_ended",
    );
    finalize(&env, plan_id).await?.into_result()?;
    assert_eq!(
        env.ft_balance(token.id(), env.beneficiary.id()).await?,
        500 * ONE_TOKEN
    );
    Ok(())
}

#[tokio::test]
async fn plan_inputs_are_validated_at_creation() -> anyhow::Result<()> {
    let env = Env::new().await?;
    let token_id = format!("token.{}", env.root.id()).parse()?;
    let base = env.nep141_plan_args(&token_id).await?;
    let cases: Vec<(&str, Value, &str)> = vec![
        ("/cooling_off_ms", json!(999), "cooling_off_too_short"),
        ("/commitment", json!("xyz"), "invalid_commitment"),
        (
            "/envelope/max_amount_per_tx",
            json!((1_001 * ONE_TOKEN).to_string()),
            "invalid_envelope",
        ),
        ("/envelope/period_ms", json!(0), "invalid_envelope"),
        ("/token_decimals", json!(25), "invalid_decimals"),
        (
            "/proceeds_asset",
            json!("nep141:other.near"),
            "unknown_proceeds_asset",
        ),
        ("/quote_decimals", json!(0), "quote_decimals_mismatch"),
        ("/end_ms", base["start_ms"].clone(), "invalid_times"),
        ("/label", json!("x".repeat(81)), "label_too_long"),
        (
            "/beneficiary/evm_address",
            json!("0x1234"),
            "invalid_evm_address",
        ),
    ];
    for (pointer, value, code) in cases {
        let mut args = base.clone();
        *args.pointer_mut(pointer).expect("field") = value;
        assert_refused(
            &env.create_plan(&env.owner, &args, CREATE_DEPOSIT).await?,
            code,
        );
    }
    let plan_id: u64 = env
        .create_plan(&env.owner, &base, CREATE_DEPOSIT)
        .await?
        .into_result()?
        .json()?;
    // An ack for anything but the committed plan is refused.
    assert_refused(
        &env.ack(plan_id, &json!("44".repeat(32)), &base["envelope"])
            .await?,
        "commitment_mismatch",
    );
    env.ack(plan_id, &base["commitment"], &base["envelope"])
        .await?
        .into_result()?;
    assert_refused(
        &env.ack(plan_id, &base["commitment"], &base["envelope"])
            .await?,
        "already_acked",
    );
    let plans: Vec<Value> = env
        .registry
        .view("list_plans")
        .args_json(json!({}))
        .await?
        .json()?;
    assert_eq!(plans.len(), 1);
    Ok(())
}

#[tokio::test]
async fn a_sale_is_refused_once_a_cancel_takes_effect_even_before_finalize() -> anyhow::Result<()> {
    let env = Env::new().await?;
    let (_token, plan_id) = env.funded_nep141_plan(None).await?;
    owner_call(&env, "request_cancel", plan_id)
        .await?
        .into_result()?;
    let effective = env.plan(plan_id).await?["pending_change"]["effective_at_ms"]
        .as_u64()
        .unwrap();
    env.advance_to(effective).await?;
    assert_refused(
        &env.execute(&env.nep141_sale(plan_id, ONE_TOKEN).await?)
            .await?,
        "cancel_effective",
    );
    assert_eq!(env.plan(plan_id).await?["status"], json!("active"));
    Ok(())
}

#[tokio::test]
async fn a_pending_change_cannot_be_expired_inside_its_apply_window() -> anyhow::Result<()> {
    let env = Env::new().await?;
    let (_token, plan_id) = env.funded_nep141_plan(None).await?;
    let expire = |env: &Env| {
        env.relayer
            .call(env.registry.id(), "expire_change")
            .args_json(json!({ "plan_id": plan_id }))
            .transact()
    };
    assert_refused(&expire(&env).await?, "no_pending_change");
    request_change(
        &env,
        &env.owner,
        plan_id,
        &"33".repeat(32),
        &default_envelope(),
    )
    .await?
    .into_result()?;
    assert_refused(&expire(&env).await?, "change_not_expired");
    Ok(())
}

#[tokio::test]
async fn a_cancel_cannot_be_withdrawn_once_it_has_taken_effect() -> anyhow::Result<()> {
    let env = Env::new().await?;
    let (token, plan_id) = env.funded_nep141_plan(None).await?;
    owner_call(&env, "request_cancel", plan_id)
        .await?
        .into_result()?;
    let effective = env.plan(plan_id).await?["pending_change"]["effective_at_ms"]
        .as_u64()
        .unwrap();
    env.advance_to(effective).await?;

    assert_refused(
        &owner_call(&env, "withdraw_change", plan_id).await?,
        "cancel_effective",
    );
    assert_refused(
        &env.execute(&env.nep141_sale(plan_id, ONE_TOKEN).await?)
            .await?,
        "cancel_effective",
    );
    // Only finalize applies now, and it releases to the beneficiary.
    finalize(&env, plan_id).await?.into_result()?;
    assert_eq!(
        env.ft_balance(token.id(), env.beneficiary.id()).await?,
        10_000 * ONE_TOKEN
    );
    Ok(())
}

#[tokio::test]
async fn only_governance_lists_proceeds_assets_and_plans_must_use_one() -> anyhow::Result<()> {
    let env = Env::new().await?;
    let assets: Vec<Value> = env
        .registry
        .view("get_proceeds_assets")
        .args_json(json!({}))
        .await?
        .json()?;
    assert_eq!(
        assets,
        vec![json!({ "asset_id": PROCEEDS_ASSET, "decimals": 6 })]
    );
    let by_owner = env
        .owner
        .call(env.registry.id(), "set_proceeds_asset")
        .args_json(json!({ "asset_id": "nep141:fake.near", "decimals": 0 }))
        .deposit(NearToken::from_millinear(10))
        .transact()
        .await?;
    assert_refused(&by_owner, "only_governance");
    let token_id = format!("token.{}", env.root.id()).parse()?;
    let mut args = env.nep141_plan_args(&token_id).await?;
    args["proceeds_asset"] = json!("nep141:fake.near");
    args["quote_decimals"] = json!(0);
    assert_refused(
        &env.create_plan(&env.owner, &args, CREATE_DEPOSIT).await?,
        "unknown_proceeds_asset",
    );
    Ok(())
}

#[tokio::test]
async fn a_plan_can_be_revealed_once_after_it_ends_and_only_against_its_commitment(
) -> anyhow::Result<()> {
    let env = Env::new().await?;
    let token_id = format!("token.{}", env.root.id()).parse()?;
    let plan_json = r#"{"floor_usd_e6":"1500000","max_per_period":"1000","version":1}"#;
    let salt = [9u8; 32];
    let commitment = sha256_hex(&[plan_json.as_bytes(), &salt].concat());
    let mut args = env.nep141_plan_args(&token_id).await?;
    args["commitment"] = json!(commitment);
    let end_ms = env.now_ms().await? + 20_000;
    args["end_ms"] = json!(end_ms);
    let plan_id = env.active_plan(&args).await?;

    let reveal = |salt: [u8; 32]| {
        env.relayer
            .call(env.registry.id(), "reveal_plan")
            .args_json(
                json!({ "plan_id": plan_id, "plan_json": plan_json, "salt": hex::encode(salt) }),
            )
            .deposit(NearToken::from_millinear(50))
            .transact()
    };
    assert_refused(&reveal(salt).await?, "not_ended");

    env.advance_to(end_ms).await?;
    finalize(&env, plan_id).await?.into_result()?;
    assert_refused(&reveal([8u8; 32]).await?, "commitment_mismatch");
    let revealed = reveal(salt).await?;
    assert!(revealed
        .logs()
        .iter()
        .any(|l| l.contains(r#""event":"plan_revealed""#)));
    revealed.into_result()?;

    let stored: Value = env
        .registry
        .view("get_reveal")
        .args_json(json!({ "plan_id": plan_id }))
        .await?
        .json()?;
    assert_eq!(stored["plan_json"], json!(plan_json));
    assert_eq!(stored["salt"], json!(hex::encode(salt)));
    assert_eq!(stored["revealed_by"], json!(env.relayer.id()));
    assert_refused(&reveal(salt).await?, "already_revealed");
    Ok(())
}
