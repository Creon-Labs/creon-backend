#![no_std]
//! ShareToken — restricted SEP-41 share token (one instance per campaign).
//!
//! Built on the OpenZeppelin `stellar-tokens` fungible `Base`. On top of the
//! standard SEP-41 surface it enforces the platform KYC rule — *every* holder
//! must be whitelisted in the shared [`ComplianceRegistry`] — at two choke points:
//!   * `mint`: the recipient must be whitelisted, and only the configured minter
//!     (the `Campaign` contract) may call it.
//!   * `transfer` / `transfer_from`: the recipient must be whitelisted **and**
//!     the token must be unlocked (transfers are disabled during the lock period).
//!
//! This makes the token a Soroban permissioned security token: a share can never
//! land in a non-KYC'd address, by mint or by transfer.
//!
//! Shares are intentionally **non-burnable** by holders — a share is an ownership
//! record, there is no burn flow in Creon, and the ownership indexer only needs
//! `mint`/`transfer` events.

use soroban_sdk::{
    contract, contractclient, contracterror, contractimpl, contracttype, panic_with_error, Address,
    Env, MuxedAddress, String,
};
use stellar_access::ownable::{set_owner, Ownable};
use stellar_macros::only_owner;
use stellar_tokens::fungible::{Base, ContractOverrides, FungibleToken};

/// Minimal client for the ComplianceRegistry — declared locally so this crate
/// doesn't depend on the registry crate; only `is_whitelisted` is needed.
#[contractclient(name = "ComplianceRegistryClient")]
pub trait ComplianceRegistry {
    fn is_whitelisted(e: Env, addr: Address) -> bool;
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum ShareError {
    NotWhitelisted = 1,
    Locked = 2,
    MinterNotSet = 3,
}

#[contracttype]
enum DataKey {
    Registry,
    Minter,
    Locked,
}

/// Stellar's 7-decimal precision (stroops), matching USDC and the backend's
/// `Decimal(28,7)` money columns.
const SHARE_DECIMALS: u32 = 7;

#[contract]
pub struct ShareToken;

#[contractimpl]
impl ShareToken {
    /// `owner` administers the lock flag + minter; `registry` is the shared
    /// ComplianceRegistry. The token starts **locked** (non-transferable); the
    /// Campaign unlocks it after the lock period.
    pub fn __constructor(e: &Env, owner: Address, registry: Address, name: String, symbol: String) {
        set_owner(e, &owner);
        Base::set_metadata(e, SHARE_DECIMALS, name, symbol);
        e.storage().instance().set(&DataKey::Registry, &registry);
        e.storage().instance().set(&DataKey::Locked, &true);
    }

    /// Mint shares to `to`. Callable only by the configured minter (the Campaign).
    /// Reverts unless `to` is whitelisted.
    pub fn mint(e: &Env, to: Address, amount: i128) {
        Self::minter(e).require_auth();
        Self::require_whitelisted(e, &to);
        Base::mint(e, &to, amount);
    }

    /// Set the address allowed to mint (the Campaign contract). Owner-only.
    #[only_owner]
    pub fn set_minter(e: &Env, minter: Address) {
        e.storage().instance().set(&DataKey::Minter, &minter);
    }

    /// Lock or unlock transfers. Owner-only. Mirrors `ProjectToken.isTransferable`.
    #[only_owner]
    pub fn set_lock(e: &Env, locked: bool) {
        e.storage().instance().set(&DataKey::Locked, &locked);
    }

    pub fn is_locked(e: &Env) -> bool {
        e.storage().instance().get(&DataKey::Locked).unwrap_or(true)
    }

    pub fn registry(e: &Env) -> Address {
        e.storage().instance().get(&DataKey::Registry).unwrap()
    }

    pub fn minter(e: &Env) -> Address {
        match e.storage().instance().get(&DataKey::Minter) {
            Some(m) => m,
            None => panic_with_error!(e, ShareError::MinterNotSet),
        }
    }

    pub(crate) fn require_whitelisted(e: &Env, addr: &Address) {
        let registry = Self::registry(e);
        if !ComplianceRegistryClient::new(e, &registry).is_whitelisted(addr) {
            panic_with_error!(e, ShareError::NotWhitelisted);
        }
    }

    pub(crate) fn require_unlocked(e: &Env) {
        if Self::is_locked(e) {
            panic_with_error!(e, ShareError::Locked);
        }
    }
}

/// Custom override of the SEP-41 transfer surface: every transfer requires the
/// token to be unlocked and the recipient whitelisted, then delegates to the
/// OpenZeppelin `Base` implementation. (Mint gating lives in [`ShareToken::mint`].)
pub struct Restricted;

impl ContractOverrides for Restricted {
    fn transfer(e: &Env, from: &Address, to: &MuxedAddress, amount: i128) {
        ShareToken::require_unlocked(e);
        ShareToken::require_whitelisted(e, &to.address());
        Base::transfer(e, from, to, amount);
    }

    fn transfer_from(e: &Env, spender: &Address, from: &Address, to: &Address, amount: i128) {
        ShareToken::require_unlocked(e);
        ShareToken::require_whitelisted(e, to);
        Base::transfer_from(e, spender, from, to, amount);
    }
}

#[contractimpl(contracttrait)]
impl FungibleToken for ShareToken {
    type ContractType = Restricted;
}

#[contractimpl(contracttrait)]
impl Ownable for ShareToken {}

mod test;
