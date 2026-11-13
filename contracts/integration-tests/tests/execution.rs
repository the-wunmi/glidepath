//! Only attested enclave requests execute, and the envelope holds even when the enclave signs.

use ed25519_dalek::Verifier;
use integration_tests::*;
use near_workspaces::types::NearToken;
use serde_json::{json, Value};

fn u128_of(value: &Value) -> u128 {
    value
        .as_str()
        .and_then(|s| s.parse().ok())
        .expect("U128 string")
}

#[tokio::test]
async fn an_attested_enclave_request_executes_a_sale_and_leaves_a_verifiable_receipt(
) -> anyhow::Result<()> {
    let env = Env::new().await?;
    let (token, plan_id) = env.funded_nep141_plan(None).await?;
    let request = env.nep141_sale(plan_id, 10 * ONE_TOKEN).await?;

    let result = env.execute(&request).await?;
    println!(
        "gas burnt by a NEP-141 execute (all receipts): {}",
        result.total_gas_burnt
    );
    for outcome in result.outcomes() {
        println!("  {} {}", outcome.executor_id, outcome.gas_burnt);
    }
    let logs: Vec<String> = result.logs().iter().map(|l| l.to_string()).collect();
    assert!(
        result.json::<bool>()?,
        "settlement callback reported failure"
    );

    assert_eq!(
        env.ft_balance(token.id(), env.venue.id()).await?,
        10 * ONE_TOKEN
    );
    assert_eq!(
        env.ft_balance(token.id(), &env.plan_account(plan_id))
            .await?,
        9_990 * ONE_TOKEN
    );
    let plan = env.plan(plan_id).await?;
    assert_eq!(plan["next_seq"], json!(1));
    assert_eq!(u128_of(&plan["sold_total"]), 10 * ONE_TOKEN);
    assert_eq!(u128_of(&plan["sold_in_period"]), 10 * ONE_TOKEN);

    let receipts = env.receipts(plan_id).await?;
    let receipt = &receipts[0];
    assert_eq!(receipt["status"], json!("done"));
    assert_eq!(receipt["kind"], json!("sale"));
    // action_hash is sha256 of the exact ft_transfer arguments the plan account sent.
    let ft_args = format!(
        r#"{{"receiver_id":"{}","amount":"{}","memo":"vsp/{plan_id}/0"}}"#,
        env.venue.id(),
        10 * ONE_TOKEN
    );
    assert_eq!(
        receipt["action_hash"],
        json!(sha256_hex(ft_args.as_bytes()))
    );
    // Anyone can re-verify the enclave signature from the receipt alone.
    let key_bytes: [u8; 32] = bs58::decode(
        receipt["enclave_key"]
            .as_str()
            .unwrap()
            .trim_start_matches("ed25519:"),
    )
    .into_vec()?
    .try_into()
    .unwrap();
    let key = ed25519_dalek::VerifyingKey::from_bytes(&key_bytes)?;
    let signature: [u8; 64] = base64_decode(receipt["signature"].as_str().unwrap())
        .try_into()
        .unwrap();
    let signed = [
        b"vsp/execute/v1\n".as_slice(),
        receipt["request_json"].as_str().unwrap().as_bytes(),
    ]
    .concat();
    key.verify(&signed, &ed25519_dalek::Signature::from_bytes(&signature))?;
    assert!(logs
        .iter()
        .any(|l| l
            .starts_with(r#"EVENT_JSON:{"standard":"vsp","version":"1.0.0","event":"executed""#)));
    assert!(logs.iter().any(|l| l.contains(r#""event":"settled""#)));
    Ok(())
}

#[tokio::test]
async fn requests_signed_by_unregistered_or_revoked_enclaves_are_refused() -> anyhow::Result<()> {
    let env = Env::new().await?;
    let (_token, plan_id) = env.funded_nep141_plan(None).await?;
    let stranger = TestEnclave::from_seed(SECOND_ENCLAVE_SEED);
    let request = env.nep141_sale(plan_id, ONE_TOKEN).await?.to_string();
    let signature = stranger.sign("vsp/execute/v1\n", &request);

    let result = env
        .execute_signed(
            plan_id,
            &request,
            &signature,
            &stranger.public_key(),
            EXECUTE_DEPOSIT,
        )
        .await?;
    assert_refused(&result, "unknown_enclave");

    env.register_enclave(&stranger.public_key())
        .await?
        .into_result()?;
    // A newly registered key waits out the activation delay (one cooling-off) before it acts.
    let refused = env
        .execute_signed(
            plan_id,
            &request,
            &signature,
            &stranger.public_key(),
            EXECUTE_DEPOSIT,
        )
        .await?;
    assert_refused(&refused, "enclave_not_active");
    let now = env.now_ms().await?;
    env.advance_to(now + 1_000).await?;
    // Registered after this plan was created, it also waits the plan's own 2 s cooling-off
    // (asserted with a longer cooling-off in the key-notice test).
    let enclaves: Vec<Value> = env
        .registry
        .view("get_enclaves")
        .args_json(json!({}))
        .await?
        .json()?;
    let registered_at = enclaves[1]["registered_at_ms"].as_u64().unwrap();
    env.advance_to(registered_at + 2_000).await?;
    env.execute_signed(
        plan_id,
        &request,
        &signature,
        &stranger.public_key(),
        EXECUTE_DEPOSIT,
    )
    .await?
    .into_result()?;

    let not_governance = env
        .owner
        .call(env.registry.id(), "revoke_enclave")
        .args_json(json!({ "public_key": stranger.public_key() }))
        .transact()
        .await?;
    assert_refused(&not_governance, "only_governance");
    env.governance
        .call(env.registry.id(), "revoke_enclave")
        .args_json(json!({ "public_key": stranger.public_key() }))
        .transact()
        .await?
        .into_result()?;
    let request = env.nep141_sale(plan_id, ONE_TOKEN).await?.to_string();
    let signature = stranger.sign("vsp/execute/v1\n", &request);
    let result = env
        .execute_signed(
            plan_id,
            &request,
            &signature,
            &stranger.public_key(),
            EXECUTE_DEPOSIT,
        )
        .await?;
    assert_refused(&result, "enclave_revoked");
    Ok(())
}

#[tokio::test]
async fn a_newly_registered_enclave_cannot_act_before_its_activation_delay() -> anyhow::Result<()> {
    let env = Env::with(Options {
        enclave_activation_delay_ms: 60_000,
        wait_for_activation: false,
        ..Options::default()
    })
    .await?;
    let token_id = format!("token.{}", env.root.id()).parse()?;
    let args = env.nep141_plan_args(&token_id).await?;
    let plan_id: u64 = env
        .create_plan(&env.owner, &args, CREATE_DEPOSIT)
        .await?
        .into_result()?
        .json()?;

    let result = env
        .ack(plan_id, &args["commitment"], &args["envelope"])
        .await?;
    assert_refused(&result, "enclave_not_active");

    let enclaves: Vec<Value> = env
        .registry
        .view("get_enclaves")
        .args_json(json!({}))
        .await?
        .json()?;
    env.advance_to(enclaves[0]["active_from_ms"].as_u64().unwrap())
        .await?;
    env.ack(plan_id, &args["commitment"], &args["envelope"])
        .await?
        .into_result()?;
    assert_eq!(env.plan(plan_id).await?["status"], json!("active"));
    Ok(())
}

#[tokio::test]
async fn a_forged_signature_is_refused() -> anyhow::Result<()> {
    let env = Env::new().await?;
    let (_token, plan_id) = env.funded_nep141_plan(None).await?;
    let request = env.nep141_sale(plan_id, ONE_TOKEN).await?.to_string();
    let forger = TestEnclave::from_seed(SECOND_ENCLAVE_SEED);

    for signature in [
        forger.sign("vsp/execute/v1\n", &request),
        // A genuine enclave signature over the same bytes under the ack domain.
        env.enclave.sign("vsp/ack/v1\n", &request),
        "not base64!".to_string(),
        base64_encode(&[0u8; 64]),
    ] {
        let result = env
            .execute_signed(
                plan_id,
                &request,
                &signature,
                &env.enclave.public_key(),
                EXECUTE_DEPOSIT,
            )
            .await?;
        assert_refused(&result, "bad_signature");
    }
    Ok(())
}

#[tokio::test]
async fn a_replayed_request_is_refused() -> anyhow::Result<()> {
    let env = Env::new().await?;
    let (token, plan_id) = env.funded_nep141_plan(None).await?;
    let request = env.nep141_sale(plan_id, ONE_TOKEN).await?;
    env.execute(&request).await?.into_result()?;

    let replay = env.execute(&request).await?;
    assert_refused(&replay, "bad_seq");
    assert_eq!(env.ft_balance(token.id(), env.venue.id()).await?, ONE_TOKEN);
    Ok(())
}

#[tokio::test]
async fn tampering_with_any_request_field_invalidates_the_signature() -> anyhow::Result<()> {
    let env = Env::new().await?;
    let (_token, plan_id) = env.funded_nep141_plan(None).await?;
    let request = env.nep141_sale(plan_id, ONE_TOKEN).await?;
    let signature = env.enclave.sign("vsp/execute/v1\n", &request.to_string());

    let tampered: Vec<(&str, Value)> = vec![
        ("/seq", json!(5)),
        ("/commitment", json!("33".repeat(32))),
        ("/action/amount", json!((100 * ONE_TOKEN).to_string())),
        ("/action/receiver_id", json!(env.owner.id())),
        ("/settlement/deposit_address", json!(env.owner.id())),
        ("/settlement/min_amount_out", json!("1")),
        ("/compliance/above_floor", json!(false)),
        ("/expires_at_ms", json!(u64::MAX)),
    ];
    for (pointer, value) in tampered {
        let mut changed = request.clone();
        *changed.pointer_mut(pointer).expect("field") = value;
        let result = env
            .execute_signed(
                plan_id,
                &changed.to_string(),
                &signature,
                &env.enclave.public_key(),
                EXECUTE_DEPOSIT,
            )
            .await?;
        assert_refused(&result, "bad_signature");
    }
    // Untampered, the same signature is accepted.
    env.execute_signed(
        plan_id,
        &request.to_string(),
        &signature,
        &env.enclave.public_key(),
        EXECUTE_DEPOSIT,
    )
    .await?
    .into_result()?;
    Ok(())
}

#[tokio::test]
async fn envelope_caps_hold_even_with_a_valid_enclave_signature() -> anyhow::Result<()> {
    let env = Env::new().await?;
    let envelope = json!({
        "period_ms": 60_000,
        "max_amount_per_period": (150 * ONE_TOKEN).to_string(),
        "max_amount_per_tx": (100 * ONE_TOKEN).to_string(),
        "min_price_usd_e6": MIN_PRICE_USD_E6.to_string(),
        "min_gap_ms": 0,
    });
    let (_token, plan_id) = env.funded_nep141_plan(Some(envelope)).await?;

    let over_tx_cap = env.nep141_sale(plan_id, 100 * ONE_TOKEN + 1).await?;
    assert_refused(&env.execute(&over_tx_cap).await?, "tx_cap_exceeded");

    let below_floor = env
        .nep141_sale_at(plan_id, 10 * ONE_TOKEN, floor_min_out(10 * ONE_TOKEN) - 1)
        .await?;
    assert_refused(&env.execute(&below_floor).await?, "below_floor");

    env.execute(&env.nep141_sale(plan_id, 100 * ONE_TOKEN).await?)
        .await?
        .into_result()?;
    let over_period = env.nep141_sale(plan_id, 51 * ONE_TOKEN).await?;
    assert_refused(&env.execute(&over_period).await?, "period_cap_exceeded");
    env.execute(&env.nep141_sale(plan_id, 50 * ONE_TOKEN).await?)
        .await?
        .into_result()?;

    // The budget comes back only in the next period.
    let plan = env.plan(plan_id).await?;
    let next_period =
        plan["start_ms"].as_u64().unwrap() + 60_000 * (plan["period_index"].as_u64().unwrap() + 1);
    env.advance_to(next_period).await?;
    env.execute(&env.nep141_sale(plan_id, 100 * ONE_TOKEN).await?)
        .await?
        .into_result()?;
    let plan = env.plan(plan_id).await?;
    assert_eq!(u128_of(&plan["sold_in_period"]), 100 * ONE_TOKEN);
    assert_eq!(u128_of(&plan["sold_total"]), 250 * ONE_TOKEN);
    Ok(())
}

#[tokio::test]
async fn sales_closer_together_than_the_minimum_gap_are_refused() -> anyhow::Result<()> {
    let env = Env::new().await?;
    let mut envelope = default_envelope();
    envelope["min_gap_ms"] = json!(30_000);
    let (_token, plan_id) = env.funded_nep141_plan(Some(envelope)).await?;

    env.execute(&env.nep141_sale(plan_id, ONE_TOKEN).await?)
        .await?
        .into_result()?;
    assert_refused(
        &env.execute(&env.nep141_sale(plan_id, ONE_TOKEN).await?)
            .await?,
        "gap_too_short",
    );

    let last_sale = env.plan(plan_id).await?["last_sale_ms"].as_u64().unwrap();
    env.advance_to(last_sale + 30_000).await?;
    env.execute(&env.nep141_sale(plan_id, ONE_TOKEN).await?)
        .await?
        .into_result()?;
    Ok(())
}

#[tokio::test]
async fn a_request_with_any_compliance_flag_false_is_refused() -> anyhow::Result<()> {
    let env = Env::new().await?;
    let (_token, plan_id) = env.funded_nep141_plan(None).await?;
    for flag in [
        "within_period_budget",
        "within_tx_cap",
        "above_floor",
        "venue_allowed",
        "prices_agree",
        "schedule_ok",
    ] {
        let mut request = env.nep141_sale(plan_id, ONE_TOKEN).await?;
        request["compliance"][flag] = json!(false);
        assert_refused(&env.execute(&request).await?, "not_compliant");
    }
    Ok(())
}

#[tokio::test]
async fn an_expired_or_future_dated_request_is_refused() -> anyhow::Result<()> {
    let env = Env::new().await?;
    let (_token, plan_id) = env.funded_nep141_plan(None).await?;
    let now = env.now_ms().await?;

    let mut expired = env.nep141_sale(plan_id, ONE_TOKEN).await?;
    expired["issued_at_ms"] = json!(now - 120_000);
    expired["expires_at_ms"] = json!(now - 60_000);
    assert_refused(&env.execute(&expired).await?, "expired");

    let mut future = env.nep141_sale(plan_id, ONE_TOKEN).await?;
    future["issued_at_ms"] = json!(now + 3_600_000);
    future["expires_at_ms"] = json!(now + 7_200_000);
    assert_refused(&env.execute(&future).await?, "expired");
    Ok(())
}

#[tokio::test]
async fn a_settlement_that_pays_anyone_but_the_action_receiver_is_refused() -> anyhow::Result<()> {
    let env = Env::new().await?;
    let (_token, plan_id) = env.funded_nep141_plan(None).await?;
    let mut request = env.nep141_sale(plan_id, ONE_TOKEN).await?;
    request["settlement"]["deposit_address"] = json!(env.owner.id());
    assert_refused(&env.execute(&request).await?, "receiver_mismatch");

    let mut wrong_asset = env.nep141_sale(plan_id, ONE_TOKEN).await?;
    wrong_asset["action"] = evm_action(ONE_TOKEN, 0);
    wrong_asset["settlement"]["deposit_address"] = json!(EVM_VENUE);
    assert_refused(&env.execute(&wrong_asset).await?, "wrong_asset");

    let mut unknown_field = env.nep141_sale(plan_id, ONE_TOKEN).await?;
    unknown_field["action"]["skip_checks"] = json!(true);
    assert_refused(&env.execute(&unknown_field).await?, "bad_request");
    Ok(())
}

#[tokio::test]
async fn pausing_stops_execution_and_acknowledgements() -> anyhow::Result<()> {
    let env = Env::new().await?;
    let (_token, plan_id) = env.funded_nep141_plan(None).await?;
    let token_id = format!("token.{}", env.root.id()).parse()?;
    let args = env.nep141_plan_args(&token_id).await?;
    let pending_plan: u64 = env
        .create_plan(&env.owner, &args, CREATE_DEPOSIT)
        .await?
        .into_result()?
        .json()?;

    let by_owner = env
        .owner
        .call(env.registry.id(), "set_paused")
        .args_json(json!({ "paused": true }))
        .transact()
        .await?;
    assert_refused(&by_owner, "only_governance");
    env.governance
        .call(env.registry.id(), "set_paused")
        .args_json(json!({ "paused": true }))
        .transact()
        .await?
        .into_result()?;

    assert_refused(
        &env.execute(&env.nep141_sale(plan_id, ONE_TOKEN).await?)
            .await?,
        "paused",
    );
    assert_refused(
        &env.ack(pending_plan, &args["commitment"], &args["envelope"])
            .await?,
        "paused",
    );
    // Pausing opens no exit: the plan cannot be ended early.
    let finalize = env
        .owner
        .call(env.registry.id(), "finalize")
        .args_json(json!({ "plan_id": plan_id }))
        .max_gas()
        .transact()
        .await?;
    assert_refused(&finalize, "not_ended");

    env.governance
        .call(env.registry.id(), "set_paused")
        .args_json(json!({ "paused": false }))
        .transact()
        .await?
        .into_result()?;
    env.execute(&env.nep141_sale(plan_id, ONE_TOKEN).await?)
        .await?
        .into_result()?;
    Ok(())
}

#[tokio::test]
async fn a_failed_ft_transfer_marks_the_receipt_failed_and_returns_the_budget() -> anyhow::Result<()>
{
    let env = Env::new().await?;
    let (token, plan_id) = env.funded_nep141_plan(None).await?;
    let mut request = env.nep141_sale(plan_id, 10 * ONE_TOKEN).await?;
    // The venue is not registered with the token and the request does not register it.
    request["action"]["register_receiver"] = json!(false);

    let result = env.execute(&request).await?;
    assert!(result
        .logs()
        .iter()
        .any(|l| l.contains(r#""event":"settle_failed""#)));
    assert!(!result.json::<bool>()?);
    let plan = env.plan(plan_id).await?;
    assert_eq!(plan["next_seq"], json!(1), "the seq stays consumed");
    assert_eq!(u128_of(&plan["sold_total"]), 0);
    assert_eq!(u128_of(&plan["sold_in_period"]), 0);
    assert_eq!(env.receipts(plan_id).await?[0]["status"], json!("failed"));
    assert_eq!(
        env.ft_balance(token.id(), &env.plan_account(plan_id))
            .await?,
        10_000 * ONE_TOKEN
    );

    // The next request (seq 1) registers the venue and settles.
    env.execute(&env.nep141_sale(plan_id, 10 * ONE_TOKEN).await?)
        .await?
        .into_result()?;
    assert_eq!(
        env.ft_balance(token.id(), env.venue.id()).await?,
        10 * ONE_TOKEN
    );
    Ok(())
}

#[tokio::test]
async fn callers_pay_for_the_storage_they_add() -> anyhow::Result<()> {
    let env = Env::new().await?;
    let token_id = format!("token.{}", env.root.id()).parse()?;
    let args = env.nep141_plan_args(&token_id).await?;
    // Exactly the plan-account funding leaves nothing for the registry's storage.
    let result = env
        .create_plan(&env.owner, &args, NearToken::from_millinear(100))
        .await?;
    assert_refused(&result, "insufficient_deposit");

    let (_token, plan_id) = env.funded_nep141_plan(None).await?;
    let request = env.nep141_sale(plan_id, ONE_TOKEN).await?;
    let request_json = request.to_string();
    let signature = env.enclave.sign("vsp/execute/v1\n", &request_json);
    let result = env
        .execute_signed(
            plan_id,
            &request_json,
            &signature,
            &env.enclave.public_key(),
            NearToken::from_yoctonear(1),
        )
        .await?;
    assert_refused(&result, "insufficient_deposit");

    let registry_before = env.worker.view_account(env.registry.id()).await?;
    env.execute_signed(
        plan_id,
        &request_json,
        &signature,
        &env.enclave.public_key(),
        NearToken::from_near(1),
    )
    .await?
    .into_result()?;
    let registry_after = env.worker.view_account(env.registry.id()).await?;
    let staked = registry_after
        .storage_usage
        .saturating_sub(registry_before.storage_usage) as u128
        * 10u128.pow(19);
    let kept = registry_after
        .balance
        .as_yoctonear()
        .saturating_sub(registry_before.balance.as_yoctonear());
    // The registry keeps the receipt's storage (plus a small callback reserve), not the whole 1 NEAR.
    assert!(
        kept >= staked && kept < staked + NearToken::from_millinear(5).as_yoctonear(),
        "kept {kept}, staked {staked}"
    );
    Ok(())
}

#[tokio::test]
async fn the_registry_keeps_working_with_its_own_access_key_deleted() -> anyhow::Result<()> {
    let env = Env::new().await?;
    let registry_account = env.registry.as_account();
    registry_account
        .batch(env.registry.id())
        .delete_key(registry_account.secret_key().public_key())
        .transact()
        .await?
        .into_result()?;
    assert!(env
        .worker
        .view_access_keys(env.registry.id())
        .await?
        .is_empty());

    let (token, plan_id) = env.funded_nep141_plan(None).await?;
    env.execute(&env.nep141_sale(plan_id, 5 * ONE_TOKEN).await?)
        .await?
        .into_result()?;
    assert_eq!(
        env.ft_balance(token.id(), env.venue.id()).await?,
        5 * ONE_TOKEN
    );
    Ok(())
}

fn base64_decode(value: &str) -> Vec<u8> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD
        .decode(value)
        .expect("base64")
}

fn base64_encode(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

#[tokio::test]
async fn a_sale_without_a_valid_1click_quote_is_refused() -> anyhow::Result<()> {
    let env = Env::with(Options {
        set_quote_signer: false,
        ..Options::default()
    })
    .await?;
    let (_token, plan_id) = env.funded_nep141_plan(None).await?;
    let request = env.nep141_sale(plan_id, ONE_TOKEN).await?;
    assert_refused(&env.execute(&request).await?, "quote_signer_not_set");

    env.set_quote_signer(&env.quote_signer.public_key())
        .await?
        .into_result()?;
    assert_refused(&env.execute(&request).await?, "quote_signer_not_active");
    let signers: Vec<Value> = env
        .registry
        .view("get_quote_signers")
        .args_json(json!({}))
        .await?
        .json()?;
    // Set after the plan was created, the key also waits the plan's 2 s cooling-off.
    let notice_over = signers[0]["registered_at_ms"].as_u64().unwrap() + 2_000;
    let config: Value = env.registry.view("get_config").await?.json()?;
    assert_eq!(config["quote_signer"], json!(env.quote_signer.public_key()));
    env.advance_to(
        config["quote_signer_active_from_ms"]
            .as_u64()
            .unwrap()
            .max(notice_over),
    )
    .await?;

    // Signed by any other key (here, the enclave's own), the quote is worthless.
    let mut forged = env.nep141_sale(plan_id, ONE_TOKEN).await?;
    let payload = forged["settlement"]["quote"]["payload"]
        .as_str()
        .unwrap()
        .to_string();
    forged["settlement"]["quote"]["signature"] = json!(env.enclave.sign_quote(&payload));
    assert_refused(&env.execute(&forged).await?, "bad_quote_signature");

    // A genuinely signed quote edited afterwards (here, to pay the owner) no longer verifies.
    let mut tampered = env.nep141_sale(plan_id, ONE_TOKEN).await?;
    let beneficiary = format!("\"recipient\":\"{}\"", env.beneficiary.id());
    let edited = payload.replace(
        &beneficiary,
        &format!("\"recipient\":\"{}\"", env.owner.id()),
    );
    assert_ne!(edited, payload);
    tampered["settlement"]["quote"]["payload"] = json!(edited);
    assert_refused(&env.execute(&tampered).await?, "bad_quote_signature");

    // The simulator's old format (base64 over a domain-prefixed payload) is not 1Click's.
    let mut old_format = env.nep141_sale(plan_id, ONE_TOKEN).await?;
    let payload = old_format["settlement"]["quote"]["payload"]
        .as_str()
        .unwrap()
        .to_string();
    old_format["settlement"]["quote"]["signature"] =
        json!(env.quote_signer.sign("1click-quote/v1\n", &payload));
    assert_refused(&env.execute(&old_format).await?, "bad_quote_signature");

    let mut unreadable = env.nep141_sale(plan_id, ONE_TOKEN).await?;
    unreadable["settlement"]["quote"] = json!({
        "payload": "not json",
        "signature": env.quote_signer.sign_quote("not json"),
    });
    assert_refused(&env.execute(&unreadable).await?, "bad_quote");

    env.execute(&env.nep141_sale(plan_id, ONE_TOKEN).await?)
        .await?
        .into_result()?;
    Ok(())
}

#[tokio::test]
async fn a_compromised_enclave_cannot_redirect_a_sale_or_its_proceeds() -> anyhow::Result<()> {
    let env = Env::new().await?;
    let (token, plan_id) = env.funded_nep141_plan(None).await?;
    let amount = 10 * ONE_TOKEN;
    let min_out = floor_min_out(amount);
    let venue = env.venue.id().to_string();
    let plan = env.plan(plan_id).await?;
    let terms = env.quote_terms(&plan, &venue, amount, min_out).await?;
    let genuine = quote_payload(&terms);

    // The enclave names the attacker as receiver and deposit address but holds only a real
    // quote for the venue.
    let mut redirected = env.nep141_sale(plan_id, amount).await?;
    redirected["action"]["receiver_id"] = json!(env.owner.id());
    redirected["settlement"] = sign_into_settlement(
        &env.quote_signer,
        env.owner.id().as_str(),
        min_out,
        &genuine,
    );
    assert_refused(&env.execute(&redirected).await?, "quote_mismatch");

    // Every bound field must agree with the signed quote.
    let mismatches: Vec<(&str, Value)> = vec![
        ("/amount", json!((amount + 1).to_string())),
        ("/amountIn", json!((amount + 1).to_string())),
        ("/minAmountOut", json!((min_out * 1_000).to_string())),
        ("/recipient", json!(env.owner.id())),
        ("/destinationAsset", json!("nep141:attacker.near")),
        ("/originAsset", json!("nep141:wrap.near")),
        ("/dry", json!(true)),
        ("/swapType", json!("EXACT_OUTPUT")),
    ];
    for (pointer, value) in mismatches {
        let mut payload = genuine.clone();
        *payload.pointer_mut(pointer).expect("field") = value;
        let mut request = env.nep141_sale(plan_id, amount).await?;
        request["settlement"] = sign_into_settlement(&env.quote_signer, &venue, min_out, &payload);
        assert_refused(&env.execute(&request).await?, "quote_mismatch");
    }
    // A settlement and quote that agree with each other but not with the plan's proceeds asset.
    let mut other_asset = genuine.clone();
    other_asset["destinationAsset"] = json!("nep141:attacker.near");
    let mut request = env.nep141_sale(plan_id, amount).await?;
    request["settlement"] = sign_into_settlement(&env.quote_signer, &venue, min_out, &other_asset);
    request["settlement"]["destination_asset"] = json!("nep141:attacker.near");
    assert_refused(&env.execute(&request).await?, "quote_mismatch");

    let mut expired = genuine.clone();
    expired["deadline"] = json!(iso_timestamp(terms.deadline_ms - 1_200_000));
    let mut request = env.nep141_sale(plan_id, amount).await?;
    request["settlement"] = sign_into_settlement(&env.quote_signer, &venue, min_out, &expired);
    assert_refused(&env.execute(&request).await?, "quote_expired");

    // A quote whose signed USD values show 1% + $1 going to fees (the bound is 50 bps + $1),
    // e.g. an unsigned `appFees` entry skimming the output.
    let skimmed = QuoteTerms {
        amount_out_usd_e12: terms.amount_in_usd_e12 * 9_900 / 10_000 - 1_000_000_000_000,
        ..terms.clone()
    };
    let mut request = env.nep141_sale(plan_id, amount).await?;
    request["settlement"] = signed_settlement(&env.quote_signer, &skimmed);
    assert_refused(&env.execute(&request).await?, "quote_fee_too_high");

    // Unknown quote fields are ignored, so 1Click can add information. The settlement's
    // correlation id is not signed by 1Click, so it is not bound either.
    let mut extended = genuine.clone();
    extended["solver"] = json!("solver-7");
    let mut request = env.nep141_sale(plan_id, amount).await?;
    request["settlement"] = sign_into_settlement(&env.quote_signer, &venue, min_out, &extended);
    request["settlement"]["correlation_id"] = json!("any-id");
    env.execute(&request).await?.into_result()?;
    assert_eq!(env.ft_balance(token.id(), env.owner.id()).await?, 0);
    assert_eq!(env.ft_balance(token.id(), env.venue.id()).await?, amount);
    Ok(())
}

#[tokio::test]
async fn a_quote_refunding_anywhere_but_the_plan_is_refused() -> anyhow::Result<()> {
    let env = Env::new().await?;
    let (token, plan_id) = env.funded_nep141_plan(None).await?;
    let amount = 10 * ONE_TOKEN;
    let min_out = floor_min_out(amount);
    let venue = env.venue.id().to_string();
    let plan = env.plan(plan_id).await?;
    let terms = env.quote_terms(&plan, &venue, amount, min_out).await?;

    // A genuine quote whose refund goes to the attacker: a failed swap would pay them the principal.
    let attacker = env.owner.id().to_string();
    let to_attacker_terms = QuoteTerms {
        refund_to: attacker.clone(),
        ..terms
    };
    let mut request = env.nep141_sale(plan_id, amount).await?;
    request["settlement"] = signed_settlement(&env.quote_signer, &to_attacker_terms);
    assert_refused(&env.execute(&request).await?, "quote_mismatch");

    // A quote with no refund address at all cannot be read.
    let mut payload = quote_payload(&to_attacker_terms);
    payload.as_object_mut().expect("object").remove("refundTo");
    let mut request = env.nep141_sale(plan_id, amount).await?;
    request["settlement"] = sign_into_settlement(&env.quote_signer, &venue, min_out, &payload);
    assert_refused(&env.execute(&request).await?, "bad_quote");

    // Refunding to the plan account settles.
    env.execute(&env.nep141_sale(plan_id, amount).await?)
        .await?
        .into_result()?;
    assert_eq!(env.ft_balance(token.id(), env.venue.id()).await?, amount);

    // EVM plans must refund to the plan's derived address, in any letter case.
    let evm_plan = env.active_plan(&env.evm_plan_args().await?).await?;
    let evm_address = env.plan(evm_plan).await?["evm_address"]
        .as_str()
        .unwrap()
        .to_string();
    let evm_terms = env
        .quote_terms(&env.plan(evm_plan).await?, EVM_VENUE, amount, min_out)
        .await?;
    let mut to_attacker = env.evm_sale(evm_plan, amount).await?;
    let wrong = QuoteTerms {
        refund_to: EVM_BENEFICIARY.to_string(),
        ..evm_terms.clone()
    };
    to_attacker["settlement"] = signed_settlement(&env.quote_signer, &wrong);
    assert_refused(&env.execute(&to_attacker).await?, "quote_mismatch");
    let mut upper = env.evm_sale(evm_plan, amount).await?;
    let ok = QuoteTerms {
        refund_to: format!("0x{}", evm_address[2..].to_uppercase()),
        ..evm_terms
    };
    upper["settlement"] = signed_settlement(&env.quote_signer, &ok);
    env.execute_evm(&upper).await?.into_result()?;
    assert_eq!(env.receipts(evm_plan).await?[0]["status"], json!("done"));
    Ok(())
}

#[tokio::test]
async fn rotating_the_quote_key_keeps_old_receipts_verifiable() -> anyhow::Result<()> {
    let env = Env::new().await?;
    let (_token, plan_id) = env.funded_nep141_plan(None).await?;
    let old_key = env.quote_signer.public_key();
    env.execute(&env.nep141_sale(plan_id, ONE_TOKEN).await?)
        .await?
        .into_result()?;

    let new_signer = TestEnclave::from_seed([45u8; 32]);
    env.set_quote_signer(&new_signer.public_key())
        .await?
        .into_result()?;
    let signers: Vec<Value> = env
        .registry
        .view("get_quote_signers")
        .args_json(json!({}))
        .await?
        .json()?;
    assert_eq!(signers.len(), 2);
    assert_eq!(signers[0]["public_key"], json!(old_key));
    assert!(signers[0]["replaced_at_ms"].is_u64());
    assert_eq!(signers[1]["public_key"], json!(new_signer.public_key()));
    assert_eq!(signers[1]["replaced_at_ms"], Value::Null);

    // The first receipt names the key its quote was signed with, and that signature still checks.
    let receipt = env.receipts(plan_id).await?[0].clone();
    assert_eq!(receipt["quote_signer"], json!(old_key));
    let quote = &receipt["settlement"]["quote"];
    let key_bytes: [u8; 32] = bs58::decode(old_key.trim_start_matches("ed25519:"))
        .into_vec()?
        .try_into()
        .unwrap();
    let signature: [u8; 64] = bs58::decode(
        quote["signature"]
            .as_str()
            .unwrap()
            .trim_start_matches("ed25519:"),
    )
    .into_vec()?
    .try_into()
    .unwrap();
    let signed = quote_signed_message(quote["payload"].as_str().unwrap());
    ed25519_dalek::VerifyingKey::from_bytes(&key_bytes)?.verify(
        signed.as_bytes(),
        &ed25519_dalek::Signature::from_bytes(&signature),
    )?;

    // The new key waits out the activation delay; the old one stops at once.
    assert_refused(
        &env.execute(&env.nep141_sale(plan_id, ONE_TOKEN).await?)
            .await?,
        "quote_signer_not_active",
    );
    // Registered after the plan, the new key waits the plan's cooling-off (2 s), not just the
    // 1 s activation delay.
    env.advance_to(signers[1]["registered_at_ms"].as_u64().unwrap() + 2_000)
        .await?;
    assert_refused(
        &env.execute(&env.nep141_sale(plan_id, ONE_TOKEN).await?)
            .await?,
        "bad_quote_signature",
    );
    let mut request = env.nep141_sale(plan_id, ONE_TOKEN).await?;
    let payload: Value =
        serde_json::from_str(request["settlement"]["quote"]["payload"].as_str().unwrap())?;
    let venue = env.venue.id().to_string();
    request["settlement"] =
        sign_into_settlement(&new_signer, &venue, floor_min_out(ONE_TOKEN), &payload);
    env.execute(&request).await?.into_result()?;
    assert_eq!(
        env.receipts(plan_id).await?[1]["quote_signer"],
        json!(new_signer.public_key())
    );
    Ok(())
}

#[tokio::test]
async fn a_reused_quote_is_refused() -> anyhow::Result<()> {
    let env = Env::new().await?;
    let (token, plan_id) = env.funded_nep141_plan(None).await?;
    let first = env.nep141_sale(plan_id, ONE_TOKEN).await?;
    env.execute(&first).await?.into_result()?;

    // A fresh, correctly sequenced request that carries the same signed quote again.
    let mut again = env.nep141_sale(plan_id, ONE_TOKEN).await?;
    again["settlement"] = first["settlement"].clone();
    assert_refused(&env.execute(&again).await?, "quote_used");
    assert_eq!(env.ft_balance(token.id(), env.venue.id()).await?, ONE_TOKEN);
    let remembered: u64 = env.registry.view("used_quote_count").await?.json()?;
    assert_eq!(remembered, 1);
    Ok(())
}

#[tokio::test]
async fn a_plan_with_a_long_cooling_off_refuses_new_keys_until_its_notice_has_passed(
) -> anyhow::Result<()> {
    let env = Env::new().await?;
    let token_id: near_workspaces::AccountId = format!("token.{}", env.root.id()).parse()?;
    let mut args = env.nep141_plan_args(&token_id).await?;
    args["cooling_off_ms"] = json!(60_000);
    let plan_id = env.active_plan(&args).await?;
    env.deploy_token(
        "token",
        18,
        vec![(env.plan_account(plan_id), 1_000 * ONE_TOKEN)],
    )
    .await?;

    // A new enclave, active after the global 1 s delay, still waits this plan's 60 s.
    let late_enclave = TestEnclave::from_seed(SECOND_ENCLAVE_SEED);
    env.register_enclave(&late_enclave.public_key())
        .await?
        .into_result()?;
    let registered_at = env.now_ms().await?;
    env.advance_to(registered_at + 1_000).await?;
    let request = env.nep141_sale(plan_id, ONE_TOKEN).await?.to_string();
    let signature = late_enclave.sign("vsp/execute/v1\n", &request);
    let refused = env
        .execute_signed(
            plan_id,
            &request,
            &signature,
            &late_enclave.public_key(),
            EXECUTE_DEPOSIT,
        )
        .await?;
    assert_refused(&refused, "key_too_new_for_plan");
    // The enclave registered before the plan was created works at once.
    env.execute(&env.nep141_sale(plan_id, ONE_TOKEN).await?)
        .await?
        .into_result()?;

    // A new quote key likewise waits the plan's notice period.
    let late_quote = TestEnclave::from_seed([46u8; 32]);
    env.set_quote_signer(&late_quote.public_key())
        .await?
        .into_result()?;
    let signers: Vec<Value> = env
        .registry
        .view("get_quote_signers")
        .args_json(json!({}))
        .await?
        .json()?;
    let quote_registered_at = signers[1]["registered_at_ms"].as_u64().unwrap();
    env.advance_to(signers[1]["active_from_ms"].as_u64().unwrap())
        .await?;
    let quoted_by_new_key = |request: &mut Value, payload: &Value| {
        let venue = env.venue.id().to_string();
        request["settlement"] =
            sign_into_settlement(&late_quote, &venue, floor_min_out(ONE_TOKEN), payload);
    };
    let mut request = env.nep141_sale(plan_id, ONE_TOKEN).await?;
    let payload: Value =
        serde_json::from_str(request["settlement"]["quote"]["payload"].as_str().unwrap())?;
    quoted_by_new_key(&mut request, &payload);
    assert_refused(&env.execute(&request).await?, "key_too_new_for_plan");

    env.advance_to(quote_registered_at.max(registered_at) + 60_000)
        .await?;
    let mut request = env.nep141_sale(plan_id, ONE_TOKEN).await?;
    let payload: Value =
        serde_json::from_str(request["settlement"]["quote"]["payload"].as_str().unwrap())?;
    quoted_by_new_key(&mut request, &payload);
    let request_json = request.to_string();
    let signature = late_enclave.sign("vsp/execute/v1\n", &request_json);
    env.execute_signed(
        plan_id,
        &request_json,
        &signature,
        &late_enclave.public_key(),
        EXECUTE_DEPOSIT,
    )
    .await?
    .into_result()?;
    Ok(())
}
