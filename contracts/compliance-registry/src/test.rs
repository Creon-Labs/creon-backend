#![cfg(test)]

use super::*;
use soroban_sdk::{testutils::Address as _, Address, Env};

fn setup() -> (Env, Address, ComplianceRegistryClient<'static>) {
    let e = Env::default();
    let owner = Address::generate(&e);
    let id = e.register(ComplianceRegistry, (owner.clone(),));
    let client = ComplianceRegistryClient::new(&e, &id);
    (e, owner, client)
}

#[test]
fn add_then_is_whitelisted() {
    let (e, _owner, client) = setup();
    e.mock_all_auths();
    let user = Address::generate(&e);

    assert!(!client.is_whitelisted(&user));
    client.add(&user);
    assert!(client.is_whitelisted(&user));
}

#[test]
fn add_is_idempotent() {
    let (e, _owner, client) = setup();
    e.mock_all_auths();
    let user = Address::generate(&e);

    client.add(&user);
    client.add(&user); // no panic on re-add
    assert!(client.is_whitelisted(&user));
}

#[test]
fn remove_revokes() {
    let (e, _owner, client) = setup();
    e.mock_all_auths();
    let user = Address::generate(&e);

    client.add(&user);
    client.remove(&user);
    assert!(!client.is_whitelisted(&user));
}

#[test]
fn non_owner_cannot_add() {
    let (e, _owner, client) = setup();
    // Note: no mock_all_auths — the #[only_owner] auth check must reject.
    let user = Address::generate(&e);
    assert!(client.try_add(&user).is_err());
}
