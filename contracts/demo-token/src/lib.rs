//! NEP-141 demo token. Allocations are minted at launch, which is how a team allocation goes straight
//! into a keyless plan account without ever touching an insider's key.

use near_contract_standards::fungible_token::events::FtMint;
use near_contract_standards::fungible_token::metadata::{
    FungibleTokenMetadata, FungibleTokenMetadataProvider, FT_METADATA_SPEC,
};
use near_contract_standards::fungible_token::{
    FungibleToken, FungibleTokenCore, FungibleTokenResolver,
};
use near_contract_standards::storage_management::{
    StorageBalance, StorageBalanceBounds, StorageManagement,
};
use near_sdk::json_types::U128;
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, NearToken, PanicOnDefault, PromiseOrValue,
};

/// Launch allocations are bounded so `new` cannot run out of gas half-way through minting.
const MAX_ALLOCATIONS: usize = 50;

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    FungibleToken,
    Metadata,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct DemoToken {
    owner_id: AccountId,
    token: FungibleToken,
    metadata: near_sdk::store::LazyOption<FungibleTokenMetadata>,
}

#[near]
impl DemoToken {
    #[init]
    pub fn new(
        owner_id: AccountId,
        metadata: FungibleTokenMetadata,
        allocations: Vec<(AccountId, U128)>,
    ) -> Self {
        require!(metadata.spec == FT_METADATA_SPEC, "bad_request");
        metadata.assert_valid();
        require!(allocations.len() <= MAX_ALLOCATIONS, "bad_request");
        let mut this = Self {
            owner_id,
            token: FungibleToken::new(StorageKey::FungibleToken),
            metadata: near_sdk::store::LazyOption::new(StorageKey::Metadata, Some(metadata)),
        };
        for (account_id, amount) in allocations {
            this.mint_to(&account_id, amount.0, "launch allocation");
        }
        this
    }

    /// Owner-only. The contract pays the receiver's storage from its own balance.
    pub fn mint(&mut self, account_id: AccountId, amount: U128) {
        require!(env::predecessor_account_id() == self.owner_id, "only_owner");
        self.mint_to(&account_id, amount.0, "mint");
    }

    pub fn owner_id(&self) -> AccountId {
        self.owner_id.clone()
    }

    fn mint_to(&mut self, account_id: &AccountId, amount: u128, memo: &str) {
        require!(amount > 0, "bad_request");
        if !self.token.accounts.contains_key(account_id) {
            self.token.internal_register_account(account_id);
        }
        self.token.internal_deposit(account_id, amount);
        FtMint {
            owner_id: account_id,
            amount: U128(amount),
            memo: Some(memo),
        }
        .emit();
    }
}

#[near]
impl FungibleTokenCore for DemoToken {
    #[payable]
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        self.token.ft_transfer(receiver_id, amount, memo)
    }

    #[payable]
    fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<U128> {
        self.token.ft_transfer_call(receiver_id, amount, memo, msg)
    }

    fn ft_total_supply(&self) -> U128 {
        self.token.ft_total_supply()
    }

    fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        self.token.ft_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenResolver for DemoToken {
    #[private]
    fn ft_resolve_transfer(
        &mut self,
        sender_id: AccountId,
        receiver_id: AccountId,
        amount: U128,
    ) -> U128 {
        let (used, _burned) =
            self.token
                .internal_ft_resolve_transfer(&sender_id, receiver_id, amount);
        used.into()
    }
}

#[near]
impl StorageManagement for DemoToken {
    #[payable]
    fn storage_deposit(
        &mut self,
        account_id: Option<AccountId>,
        registration_only: Option<bool>,
    ) -> StorageBalance {
        self.token.storage_deposit(account_id, registration_only)
    }

    #[payable]
    fn storage_withdraw(&mut self, amount: Option<NearToken>) -> StorageBalance {
        self.token.storage_withdraw(amount)
    }

    #[payable]
    fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        // Unregistering burns balances; the demo never needs it, so it is refused.
        let _ = force;
        env::panic_str("unsupported")
    }

    fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        self.token.storage_balance_bounds()
    }

    fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.token.storage_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenMetadataProvider for DemoToken {
    fn ft_metadata(&self) -> FungibleTokenMetadata {
        self.metadata.get().clone().expect("metadata")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{accounts, VMContextBuilder};
    use near_sdk::testing_env;

    fn usdc_metadata() -> FungibleTokenMetadata {
        FungibleTokenMetadata {
            spec: FT_METADATA_SPEC.to_string(),
            name: "USD Coin".to_string(),
            symbol: "USDC".to_string(),
            icon: None,
            reference: None,
            reference_hash: None,
            decimals: 6,
        }
    }

    #[test]
    fn launch_allocations_are_minted_to_their_accounts() {
        testing_env!(VMContextBuilder::new().build());
        let token = DemoToken::new(
            accounts(0),
            usdc_metadata(),
            vec![(accounts(1), U128(500)), (accounts(2), U128(7))],
        );
        assert_eq!(token.ft_balance_of(accounts(1)).0, 500);
        assert_eq!(token.ft_balance_of(accounts(2)).0, 7);
        assert_eq!(token.ft_total_supply().0, 507);
    }

    #[test]
    #[should_panic(expected = "only_owner")]
    fn only_the_owner_can_mint() {
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(accounts(3))
            .build());
        let mut token = DemoToken::new(accounts(0), usdc_metadata(), vec![]);
        token.mint(accounts(3), U128(1));
    }
}
