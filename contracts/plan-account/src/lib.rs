//! Keyless plan account. It has no access keys, so this code is the only thing that can act for it,
//! and this code obeys only the registry that created it.

use near_sdk::json_types::U128;
use near_sdk::serde::Serialize;
use near_sdk::serde_json;
use near_sdk::{env, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise};

/// NEP-145 registration cost on wrap.near and usdt.tether-token.near (storage_balance_bounds min).
pub const STORAGE_REGISTRATION_DEPOSIT: NearToken =
    NearToken::from_yoctonear(1_250_000_000_000_000_000_000);
/// NEP-141 requires exactly one yoctoNEAR on ft_transfer, which proves a full-access signature
/// on normal accounts; here it is simply forwarded.
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
const GAS_STORAGE_DEPOSIT: Gas = Gas::from_tgas(5);
const GAS_FT_TRANSFER: Gas = Gas::from_tgas(10);
const GAS_FT_BALANCE_OF: Gas = Gas::from_tgas(5);
const GAS_ON_BALANCE: Gas = Gas::from_tgas(25);

/// Exactly the `ft_transfer` arguments this account sends. The registry serialises the same struct
/// (same field order) to compute a receipt's `action_hash`, so the hash matches the bytes on chain.
#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct FtTransferArgs<'a> {
    pub receiver_id: &'a AccountId,
    pub amount: U128,
    pub memo: Option<&'a str>,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct StorageDepositArgs<'a> {
    account_id: &'a AccountId,
    registration_only: bool,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct PlanAccount {
    registry: AccountId,
    token: Option<AccountId>,
}

#[near]
impl PlanAccount {
    /// Called by the registry in the same batch that creates this account.
    #[init]
    pub fn new(registry: AccountId, token: Option<AccountId>) -> Self {
        require!(env::predecessor_account_id() == registry, "only_registry");
        let suffix = format!(".{registry}");
        require!(
            env::current_account_id().as_str().ends_with(&suffix),
            "only_registry"
        );
        Self { registry, token }
    }

    /// Transfers `amount` of `token` to `receiver_id`. When `register_receiver` is set, registers
    /// the receiver first (paid from the attached deposit). Both run in one batch, so the returned
    /// promise fails if either fails and the registry's callback can roll back.
    #[payable]
    pub fn send(
        &mut self,
        token: AccountId,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        register_receiver: bool,
    ) -> Promise {
        self.only_registry();
        require!(amount.0 > 0, "bad_request");
        let needed = if register_receiver {
            STORAGE_REGISTRATION_DEPOSIT.saturating_add(ONE_YOCTO)
        } else {
            ONE_YOCTO
        };
        require!(env::attached_deposit() >= needed, "insufficient_deposit");
        let mut batch = Promise::new(token);
        if register_receiver {
            batch = batch.function_call(
                "storage_deposit".to_string(),
                json_bytes(&StorageDepositArgs {
                    account_id: &receiver_id,
                    registration_only: true,
                }),
                STORAGE_REGISTRATION_DEPOSIT,
                GAS_STORAGE_DEPOSIT,
            );
        }
        batch.function_call(
            "ft_transfer".to_string(),
            json_bytes(&FtTransferArgs {
                receiver_id: &receiver_id,
                amount,
                memo: memo.as_deref(),
            }),
            ONE_YOCTO,
            GAS_FT_TRANSFER,
        )
    }

    /// Sends this account's whole balance of `token` to `receiver_id` (the plan's beneficiary).
    pub fn release(&mut self, token: AccountId, receiver_id: AccountId) -> Promise {
        self.only_registry();
        Promise::new(token.clone())
            .function_call(
                "ft_balance_of".to_string(),
                json_bytes(
                    &near_sdk::serde_json::json!({ "account_id": env::current_account_id() }),
                ),
                NearToken::from_yoctonear(0),
                GAS_FT_BALANCE_OF,
            )
            .then(Promise::new(env::current_account_id()).function_call(
                "on_balance".to_string(),
                json_bytes(&near_sdk::serde_json::json!({
                    "token": token,
                    "receiver_id": receiver_id,
                })),
                NearToken::from_yoctonear(0),
                GAS_ON_BALANCE,
            ))
    }

    /// Release step two. Registration is paid from this account's own funding because the
    /// beneficiary may never have held the token, and a failed release would strand it.
    #[private]
    pub fn on_balance(
        &mut self,
        token: AccountId,
        receiver_id: AccountId,
        #[callback_result] balance: Result<U128, near_sdk::PromiseError>,
    ) -> Option<Promise> {
        let amount = balance.unwrap_or(U128(0));
        if amount.0 == 0 {
            return None;
        }
        Some(
            Promise::new(token)
                .function_call(
                    "storage_deposit".to_string(),
                    json_bytes(&StorageDepositArgs {
                        account_id: &receiver_id,
                        registration_only: true,
                    }),
                    STORAGE_REGISTRATION_DEPOSIT,
                    GAS_STORAGE_DEPOSIT,
                )
                .function_call(
                    "ft_transfer".to_string(),
                    json_bytes(&FtTransferArgs {
                        receiver_id: &receiver_id,
                        amount,
                        memo: Some("glidepath/release"),
                    }),
                    ONE_YOCTO,
                    GAS_FT_TRANSFER,
                ),
        )
    }

    /// Accepts deposits of the plan's own token and refunds anything else.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> U128 {
        let _ = (sender_id, msg);
        if self.token.as_ref() == Some(&env::predecessor_account_id()) {
            U128(0)
        } else {
            amount
        }
    }

    pub fn registry(&self) -> AccountId {
        self.registry.clone()
    }

    pub fn token(&self) -> Option<AccountId> {
        self.token.clone()
    }

    fn only_registry(&self) {
        require!(
            env::predecessor_account_id() == self.registry,
            "only_registry"
        );
    }
}

fn json_bytes<T: Serialize>(value: &T) -> Vec<u8> {
    serde_json::to_vec(value).unwrap_or_else(|_| env::panic_str("bad_request"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    fn registry() -> AccountId {
        "registry.test.near".parse().unwrap()
    }

    fn token() -> AccountId {
        "token.test.near".parse().unwrap()
    }

    fn context(predecessor: &AccountId) -> VMContextBuilder {
        let mut builder = VMContextBuilder::new();
        builder
            .current_account_id("p1.registry.test.near".parse().unwrap())
            .predecessor_account_id(predecessor.clone());
        builder
    }

    #[test]
    #[should_panic(expected = "only_registry")]
    fn only_the_parent_registry_can_initialise_the_account() {
        testing_env!(context(&"owner.test.near".parse().unwrap()).build());
        PlanAccount::new(registry(), Some(token()));
    }

    #[test]
    #[should_panic(expected = "only_registry")]
    fn the_owner_cannot_send_tokens_directly() {
        testing_env!(context(&registry()).build());
        let mut account = PlanAccount::new(registry(), Some(token()));
        testing_env!(context(&"owner.test.near".parse().unwrap())
            .attached_deposit(ONE_YOCTO)
            .build());
        let _ = account.send(
            token(),
            "owner.test.near".parse().unwrap(),
            U128(1),
            None,
            false,
        );
    }

    #[test]
    fn deposits_of_other_tokens_are_refunded() {
        testing_env!(context(&registry()).build());
        let mut account = PlanAccount::new(registry(), Some(token()));
        testing_env!(context(&"other.test.near".parse().unwrap()).build());
        let refund = account.ft_on_transfer(registry(), U128(9), String::new());
        assert_eq!(refund.0, 9);
        testing_env!(context(&token()).build());
        assert_eq!(
            account.ft_on_transfer(registry(), U128(9), String::new()).0,
            0
        );
    }
}
