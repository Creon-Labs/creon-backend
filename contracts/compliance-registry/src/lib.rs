#![no_std]
//! ComplianceRegistry — the platform's singleton KYC whitelist.
//!
//! The backend (the `owner`, i.e. the platform signing key) is the only writer:
//! on KYC approval it calls [`add`], and on expiry/sanction [`remove`]. The
//! per-campaign `ShareToken` and `Campaign` contracts query [`is_whitelisted`]
//! to gate `mint`/`transfer`/`invest`, so a wallet that was never approved
//! through the website can never end up holding a share token.

use soroban_sdk::{contract, contractevent, contractimpl, contracttype, Address, Env};
use stellar_access::ownable::{set_owner, Ownable};
use stellar_macros::only_owner;

#[contracttype]
enum DataKey {
    Whitelisted(Address),
}

/// Emitted when an address is whitelisted. Consumed by the off-chain indexer / audit.
#[contractevent(topics = ["registry", "add"], data_format = "single-value")]
struct AddrAdded {
    addr: Address,
}

/// Emitted when an address is removed from the whitelist.
#[contractevent(topics = ["registry", "remove"], data_format = "single-value")]
struct AddrRemoved {
    addr: Address,
}

#[contract]
pub struct ComplianceRegistry;

#[contractimpl]
impl ComplianceRegistry {
    /// Initialize with `owner` (the backend platform key) as the sole authority
    /// allowed to add/remove addresses.
    pub fn __constructor(e: &Env, owner: Address) {
        set_owner(e, &owner);
    }

    /// Whitelist `addr`. Owner-only. Re-adding an existing address is a no-op so
    /// the backend can safely retry (idempotent reconciliation).
    #[only_owner]
    pub fn add(e: &Env, addr: Address) {
        let key = DataKey::Whitelisted(addr.clone());
        if e.storage().persistent().has(&key) {
            return;
        }
        e.storage().persistent().set(&key, &true);
        AddrAdded { addr }.publish(e);
    }

    /// Remove `addr` from the whitelist (expired KYC / sanction). Owner-only.
    #[only_owner]
    pub fn remove(e: &Env, addr: Address) {
        e.storage()
            .persistent()
            .remove(&DataKey::Whitelisted(addr.clone()));
        AddrRemoved { addr }.publish(e);
    }

    /// Whether `addr` is currently whitelisted.
    pub fn is_whitelisted(e: &Env, addr: Address) -> bool {
        e.storage()
            .persistent()
            .has(&DataKey::Whitelisted(addr))
    }
}

#[contractimpl(contracttrait)]
impl Ownable for ComplianceRegistry {}

mod test;
