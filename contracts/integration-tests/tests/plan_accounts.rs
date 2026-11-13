//! Plan accounts are keyless, run the published code, and obey only the registry.

use integration_tests::*;
use near_workspaces::types::{AccessKey, KeyType, NearToken, SecretKey};
use near_workspaces::{Account, AccountId};
use serde_json::{json, Value};

#[tokio::test]
async fn a_plan_account_is_keyless_and_runs_the_published_code() -> anyhow::Result<()> {
    let env = Env::new().await?;
    let token = env.deploy_token("token", 18, vec![]).await?;
    let args = env.nep141_plan_args(token.id()).await?;
    let plan_id: u64 = env
        .create_plan(&env.owner, &args, CREATE_DEPOSIT)
        .await?
        .into_result()?
        .json()?;
    let plan_account = env.plan_account(plan_id);

    let keys = env.worker.view_access_keys(&plan_account).await?;
    assert!(
        keys.is_empty(),
        "plan account has {} access keys",
        keys.len()
    );

    let config: Value = env.registry.view("get_config").await?.json()?;
    let published = bs58::encode(sha2_digest(&wasm("plan_account.wasm")?)).into_string();
    assert_eq!(config["plan_account_code_hash"], json!(published));
    let details = env.worker.view_account(&plan_account).await?;
    assert_eq!(
        format!("{:?}", details.contract_state),
        format!("GlobalHash({published})")
    );

    let registry_of_account: AccountId =
        env.worker.view(&plan_account, "registry").await?.json()?;
    assert_eq!(&registry_of_account, env.registry.id());
    assert_eq!(
        env.plan(plan_id).await?["plan_account"],
        json!(plan_account)
    );
    Ok(())
}

#[tokio::test]
async fn a_team_allocation_minted_at_launch_lands_in_the_plan_account() -> anyhow::Result<()> {
    let env = Env::new().await?;
    // The plan (and its account) exists before the token launches with the allocation.
    let placeholder: AccountId = format!("token.{}", env.root.id()).parse()?;
    let args = env.nep141_plan_args(&placeholder).await?;
    let plan_id: u64 = env
        .create_plan(&env.owner, &args, CREATE_DEPOSIT)
        .await?
        .into_result()?
        .json()?;
    let plan_account = env.plan_account(plan_id);

    let token = env
        .deploy_token(
            "token",
            18,
            vec![
                (plan_account.clone(), 5_000 * ONE_TOKEN),
                (env.owner.id().clone(), ONE_TOKEN),
            ],
        )
        .await?;
    assert_eq!(token.id(), &placeholder);
    assert_eq!(
        env.ft_balance(token.id(), &plan_account).await?,
        5_000 * ONE_TOKEN
    );
    assert_eq!(env.ft_balance(token.id(), env.owner.id()).await?, ONE_TOKEN);
    Ok(())
}

#[tokio::test]
async fn the_owner_cannot_move_tokens_out_of_the_plan_account_directly() -> anyhow::Result<()> {
    let env = Env::new().await?;
    let placeholder: AccountId = format!("token.{}", env.root.id()).parse()?;
    let plan_id: u64 = env
        .create_plan(
            &env.owner,
            &env.nep141_plan_args(&placeholder).await?,
            CREATE_DEPOSIT,
        )
        .await?
        .into_result()?
        .json()?;
    let plan_account = env.plan_account(plan_id);
    let token = env
        .deploy_token("token", 18, vec![(plan_account.clone(), 100 * ONE_TOKEN)])
        .await?;

    for (method, args, deposit) in [
        (
            "send",
            json!({ "token": token.id(), "receiver_id": env.owner.id(), "amount": ONE_TOKEN.to_string(), "memo": null, "register_receiver": true }),
            NearToken::from_millinear(10),
        ),
        (
            "release",
            json!({ "token": token.id(), "receiver_id": env.owner.id() }),
            NearToken::from_yoctonear(0),
        ),
    ] {
        let result = env
            .owner
            .call(&plan_account, method)
            .args_json(args)
            .deposit(deposit)
            .max_gas()
            .transact()
            .await?;
        assert_refused(&result, "only_registry");
    }
    // The registry's own methods are not a back door either: release needs an ended plan.
    let result = env
        .owner
        .call(env.registry.id(), "finalize")
        .args_json(json!({ "plan_id": plan_id }))
        .max_gas()
        .transact()
        .await?;
    assert_refused(&result, "not_ended");
    assert_eq!(
        env.ft_balance(token.id(), &plan_account).await?,
        100 * ONE_TOKEN
    );
    Ok(())
}

#[tokio::test]
async fn nobody_can_add_a_key_to_the_plan_account() -> anyhow::Result<()> {
    let env = Env::new().await?;
    let token = env.deploy_token("token", 18, vec![]).await?;
    let plan_id: u64 = env
        .create_plan(
            &env.owner,
            &env.nep141_plan_args(token.id()).await?,
            CREATE_DEPOSIT,
        )
        .await?
        .into_result()?
        .json()?;
    let plan_account = env.plan_account(plan_id);

    // The owner signs as the plan account with the owner's own key: there is no such access key.
    let impostor = Account::from_secret_key(
        plan_account.clone(),
        env.owner.secret_key().clone(),
        &env.worker,
    );
    let new_key = SecretKey::from_seed(KeyType::ED25519, "attacker");
    let attempt = impostor
        .batch(&plan_account)
        .add_key(new_key.public_key(), AccessKey::full_access())
        .transact()
        .await;
    assert!(attempt.is_err() || attempt.is_ok_and(|r| r.is_failure()));
    // Nor can the registry's owner: the registry has no method that adds keys.
    assert!(env.worker.view_access_keys(&plan_account).await?.is_empty());
    Ok(())
}

fn sha2_digest(bytes: &[u8]) -> Vec<u8> {
    hex::decode(sha256_hex(bytes)).expect("hex")
}

#[tokio::test]
#[ignore = "measurement only: cargo test -- --ignored --nocapture"]
async fn measure_fast_forward_speed() -> anyhow::Result<()> {
    let env = Env::new().await?;
    let before = env.now_ms().await?;
    let started = std::time::Instant::now();
    env.worker.fast_forward(100).await?;
    let after = env.now_ms().await?;
    println!(
        "fast_forward(100): block time +{} ms, wall {:?}",
        after - before,
        started.elapsed()
    );
    Ok(())
}
