#![cfg(test)]

use super::*;
use soroban_sdk::{testutils::Address as _, Address, Env, MuxedAddress, String};

// Minimal mock ComplianceRegistry (no auth) so these tests focus on the token's
// own gating rather than the registry's owner checks.
mod mock_registry {
    use soroban_sdk::{contract, contractimpl, contracttype, Address, Env};

    #[contracttype]
    pub enum K {
        W(Address),
    }

    #[contract]
    pub struct MockRegistry;

    #[contractimpl]
    impl MockRegistry {
        pub fn add(e: &Env, a: Address) {
            e.storage().persistent().set(&K::W(a), &true);
        }
        pub fn is_whitelisted(e: &Env, a: Address) -> bool {
            e.storage().persistent().has(&K::W(a))
        }
    }
}

use mock_registry::{MockRegistry, MockRegistryClient};

struct F {
    e: Env,
    token: ShareTokenClient<'static>,
    registry: MockRegistryClient<'static>,
}

fn mux(a: &Address) -> MuxedAddress {
    a.clone().into()
}

fn setup() -> F {
    let e = Env::default();
    e.mock_all_auths();
    let owner = Address::generate(&e);

    let reg_id = e.register(MockRegistry, ());
    let registry = MockRegistryClient::new(&e, &reg_id);

    let token_id = e.register(
        ShareToken,
        (
            owner.clone(),
            reg_id.clone(),
            String::from_str(&e, "Creon Share"),
            String::from_str(&e, "CRS"),
        ),
    );
    let token = ShareTokenClient::new(&e, &token_id);
    token.set_minter(&owner); // owner stands in for the Campaign minter in tests

    F { e, token, registry }
}

#[test]
fn mint_requires_whitelisted_recipient() {
    let f = setup();
    let alice = Address::generate(&f.e);

    // not whitelisted -> mint reverts
    assert!(f.token.try_mint(&alice, &1_000).is_err());

    f.registry.add(&alice);
    f.token.mint(&alice, &1_000);
    assert_eq!(f.token.balance(&alice), 1_000);
}

#[test]
fn transfer_blocked_while_locked() {
    let f = setup();
    let alice = Address::generate(&f.e);
    let bob = Address::generate(&f.e);
    f.registry.add(&alice);
    f.registry.add(&bob);
    f.token.mint(&alice, &1_000);

    // token starts locked -> transfer reverts even between whitelisted parties
    assert!(f.token.try_transfer(&alice, &mux(&bob), &100).is_err());
}

#[test]
fn transfer_after_unlock_gated_by_whitelist() {
    let f = setup();
    let alice = Address::generate(&f.e);
    let bob = Address::generate(&f.e);
    let carol = Address::generate(&f.e);
    f.registry.add(&alice);
    f.registry.add(&bob);
    f.token.mint(&alice, &1_000);

    f.token.set_lock(&false);

    // transfer to whitelisted bob succeeds
    f.token.transfer(&alice, &mux(&bob), &100);
    assert_eq!(f.token.balance(&bob), 100);

    // transfer to non-whitelisted carol reverts
    assert!(f.token.try_transfer(&alice, &mux(&carol), &100).is_err());
}
