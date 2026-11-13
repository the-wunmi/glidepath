//! A Sputnik DAO (the mainnet sputnikdao2 code) can own a plan through a FunctionCall proposal.

use base64::Engine;
use integration_tests::*;
use near_workspaces::types::{Gas, NearToken};
use serde_json::{json, Value};

#[tokio::test]
async fn a_sputnik_dao_can_create_a_plan_through_a_proposal_and_owns_it() -> anyhow::Result<()> {
    let env = Env::new().await?;
    let council = subaccount(&env.root, "council", 20).await?;
    let dao = subaccount(&env.root, "dao", 30)
        .await?
        .deploy(&std::fs::read(res_path("third_party/sputnikdao2.wasm"))?)
        .await?
        .into_result()?;
    dao.call("new")
        .args_json(json!({
            "config": { "name": "founders", "purpose": "Hold the team's sales plans", "metadata": "" },
            "policy": [council.id()],
        }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;

    let token_id = format!("token.{}", env.root.id()).parse()?;
    let plan_args = env.nep141_plan_args(&token_id).await?;
    let kind = json!({
        "FunctionCall": {
            "receiver_id": env.registry.id(),
            "actions": [{
                "method_name": "create_plan",
                "args": base64::engine::general_purpose::STANDARD.encode(plan_args.to_string()),
                "deposit": CREATE_DEPOSIT.as_yoctonear().to_string(),
                "gas": Gas::from_tgas(200).as_gas().to_string(),
            }],
        }
    });
    let proposal_id: u64 = council
        .call(dao.id(), "add_proposal")
        .args_json(json!({ "proposal": { "description": "Adopt the founders' sales plan", "kind": kind } }))
        .deposit(NearToken::from_near(1))
        .max_gas()
        .transact()
        .await?
        .into_result()?
        .json()?;
    // Current sputnikdao2 requires the proposal kind to be repeated in act_proposal.
    council
        .call(dao.id(), "act_proposal")
        .args_json(json!({ "id": proposal_id, "action": "VoteApprove", "proposal": kind }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;

    let proposal: Value = dao
        .view("get_proposal")
        .args_json(json!({ "id": proposal_id }))
        .await?
        .json()?;
    assert_eq!(proposal["status"], json!("Approved"));
    let plan = env.plan(1).await?;
    assert_eq!(plan["owner"], json!(dao.id()));
    assert!(env
        .worker
        .view_access_keys(&env.plan_account(1))
        .await?
        .is_empty());

    // Only the DAO, not its council member acting alone, can request changes.
    let direct = council
        .call(env.registry.id(), "request_cancel")
        .args_json(json!({ "plan_id": 1 }))
        .deposit(NearToken::from_millinear(10))
        .transact()
        .await?;
    assert_refused(&direct, "only_owner");
    Ok(())
}
