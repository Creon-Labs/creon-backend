#![no_std]
//! Campaign — merged vault + lifecycle + distribution (one instance per campaign).
//!
//! Folds what ARCHITECTURE.md modelled as separate Vault and Distribution
//! contracts into one, to halve per-campaign deploys. Responsibilities:
//!   * **Funding** — `invest()` pulls USDC from a whitelisted investor into
//!     custody and mints them shares 1:1 via the campaign's `ShareToken`.
//!   * **Lifecycle** — `release_to_business()` hands the raised principal to the
//!     business; `unlock()` flips the share token to transferable after the lock.
//!   * **Distribution (bagi hasil)** — `deposit_profit()` adds USDC;
//!     `set_distribution(id, root)` posts a Merkle root; `claim(id, …, proof)`
//!     verifies the proof on-chain and pays the entitled holder. Pull-based and
//!     Merkle-pinned, so the backend cannot forge claim amounts.

mod merkle;

use soroban_sdk::xdr::ToXdr;
use soroban_sdk::{
    contract, contractclient, contracterror, contractevent, contractimpl, contracttype,
    panic_with_error, token, Address, BytesN, Env, Vec,
};
use stellar_access::ownable::{set_owner, Ownable};
use stellar_macros::only_owner;

/// Minimal client for the ComplianceRegistry (whitelist gate on invest).
#[contractclient(name = "RegistryClient")]
pub trait Registry {
    fn is_whitelisted(e: Env, addr: Address) -> bool;
}

/// Minimal client for this campaign's ShareToken (mint shares, toggle the lock).
#[contractclient(name = "ShareClient")]
pub trait Share {
    fn mint(e: Env, to: Address, amount: i128);
    fn set_lock(e: Env, locked: bool);
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum CampaignError {
    NotWhitelisted = 1,
    InvalidAmount = 2,
    DistributionExists = 3,
    DistributionMissing = 4,
    AlreadyClaimed = 5,
    InvalidProof = 6,
    NothingToRelease = 7,
}

#[contracttype]
enum DataKey {
    Token,
    Registry,
    Usdc,
    Business,
    Goal,
    LockPeriod,
    Raised,
    Released,
    Root(u32),         // merkle root per distribution id
    Claimed(u32, u32), // (distribution id, leaf index) -> claimed
}

/// A dividend entitlement leaf. Its SHA-256(XDR) is a Merkle leaf. `index`
/// matches `DistributionClaim.leafIndex`, `amount` is the USDC payout, `address`
/// is the entitled holder.
#[contracttype]
pub struct DistributionLeaf {
    pub index: u32,
    pub address: Address,
    pub amount: i128,
}

#[contractevent(topics = ["campaign", "invest"])]
struct Invested {
    #[topic]
    investor: Address,
    amount: i128,
}

#[contractevent(topics = ["campaign", "profit"])]
struct ProfitDeposited {
    amount: i128,
    ledger: u32,
}

#[contractevent(topics = ["campaign", "claim"])]
struct Claimed {
    #[topic]
    claimant: Address,
    id: u32,
    amount: i128,
}

#[contract]
pub struct Campaign;

#[contractimpl]
impl Campaign {
    /// `owner` (platform key) administers lifecycle; `token` is this campaign's
    /// ShareToken; `registry` the shared whitelist; `usdc` the payment asset SAC;
    /// `business` receives the released principal.
    pub fn __constructor(
        e: &Env,
        owner: Address,
        token: Address,
        registry: Address,
        usdc: Address,
        business: Address,
        goal: i128,
        lock_period: u64,
    ) {
        set_owner(e, &owner);
        let s = e.storage().instance();
        s.set(&DataKey::Token, &token);
        s.set(&DataKey::Registry, &registry);
        s.set(&DataKey::Usdc, &usdc);
        s.set(&DataKey::Business, &business);
        s.set(&DataKey::Goal, &goal);
        s.set(&DataKey::LockPeriod, &lock_period);
        s.set(&DataKey::Raised, &0i128);
        s.set(&DataKey::Released, &0i128);
    }

    /// Invest `amount` USDC. The investor must be whitelisted. Pulls USDC into
    /// custody and mints shares 1:1. `investor` authorizes the call.
    pub fn invest(e: &Env, investor: Address, amount: i128) {
        investor.require_auth();
        if amount <= 0 {
            panic_with_error!(e, CampaignError::InvalidAmount);
        }
        Self::require_whitelisted(e, &investor);

        let usdc = token::TokenClient::new(e, &Self::usdc(e));
        usdc.transfer(&investor, &e.current_contract_address(), &amount);

        // ShareToken.mint re-checks the whitelist on-chain (defense in depth).
        ShareClient::new(e, &Self::token(e)).mint(&investor, &amount);

        let raised = Self::raised(e) + amount;
        e.storage().instance().set(&DataKey::Raised, &raised);
        Invested { investor, amount }.publish(e);
    }

    /// Release all not-yet-released custodied principal to the business. Owner-only.
    #[only_owner]
    pub fn release_to_business(e: &Env) {
        let to_release = Self::raised(e) - Self::released(e);
        if to_release <= 0 {
            panic_with_error!(e, CampaignError::NothingToRelease);
        }
        let usdc = token::TokenClient::new(e, &Self::usdc(e));
        usdc.transfer(
            &e.current_contract_address(),
            &Self::business(e),
            &to_release,
        );
        e.storage()
            .instance()
            .set(&DataKey::Released, &(Self::released(e) + to_release));
    }

    /// Unlock share transfers (after the lock period). Owner-only.
    #[only_owner]
    pub fn unlock(e: &Env) {
        ShareClient::new(e, &Self::token(e)).set_lock(&false);
    }

    /// Deposit profit (USDC) into custody for a future distribution. Anyone may
    /// fund (typically the business); `from` authorizes its own USDC transfer.
    pub fn deposit_profit(e: &Env, from: Address, amount: i128) {
        from.require_auth();
        if amount <= 0 {
            panic_with_error!(e, CampaignError::InvalidAmount);
        }
        token::TokenClient::new(e, &Self::usdc(e)).transfer(
            &from,
            &e.current_contract_address(),
            &amount,
        );
        ProfitDeposited {
            amount,
            ledger: e.ledger().sequence(),
        }
        .publish(e);
    }

    /// Post the Merkle root for distribution `id`. Owner-only. One root per id.
    #[only_owner]
    pub fn set_distribution(e: &Env, id: u32, merkle_root: BytesN<32>) {
        if e.storage().persistent().has(&DataKey::Root(id)) {
            panic_with_error!(e, CampaignError::DistributionExists);
        }
        e.storage().persistent().set(&DataKey::Root(id), &merkle_root);
    }

    /// Claim a dividend for distribution `id` at leaf `index`. Verifies the
    /// Merkle proof against the posted root and pays `amount` USDC to `claimant`.
    /// Each (id, index) is claimable once.
    pub fn claim(
        e: &Env,
        id: u32,
        index: u32,
        claimant: Address,
        amount: i128,
        proof: Vec<BytesN<32>>,
    ) {
        claimant.require_auth();

        let root: BytesN<32> = match e.storage().persistent().get(&DataKey::Root(id)) {
            Some(r) => r,
            None => panic_with_error!(e, CampaignError::DistributionMissing),
        };

        let claimed_key = DataKey::Claimed(id, index);
        if e.storage().persistent().get(&claimed_key).unwrap_or(false) {
            panic_with_error!(e, CampaignError::AlreadyClaimed);
        }

        let leaf = DistributionLeaf {
            index,
            address: claimant.clone(),
            amount,
        };
        let leaf_hash = e.crypto().sha256(&leaf.to_xdr(e)).to_bytes();
        if !merkle::verify_proof(e, &root, leaf_hash, &proof) {
            panic_with_error!(e, CampaignError::InvalidProof);
        }

        e.storage().persistent().set(&claimed_key, &true);
        token::TokenClient::new(e, &Self::usdc(e)).transfer(
            &e.current_contract_address(),
            &claimant,
            &amount,
        );
        Claimed {
            claimant,
            id,
            amount,
        }
        .publish(e);
    }

    // ---- getters (off-chain mirror reads these) ----
    pub fn raised(e: &Env) -> i128 {
        e.storage().instance().get(&DataKey::Raised).unwrap_or(0)
    }
    pub fn released(e: &Env) -> i128 {
        e.storage().instance().get(&DataKey::Released).unwrap_or(0)
    }
    pub fn goal(e: &Env) -> i128 {
        e.storage().instance().get(&DataKey::Goal).unwrap()
    }
    pub fn token(e: &Env) -> Address {
        e.storage().instance().get(&DataKey::Token).unwrap()
    }
    pub fn usdc(e: &Env) -> Address {
        e.storage().instance().get(&DataKey::Usdc).unwrap()
    }
    pub fn registry(e: &Env) -> Address {
        e.storage().instance().get(&DataKey::Registry).unwrap()
    }
    pub fn business(e: &Env) -> Address {
        e.storage().instance().get(&DataKey::Business).unwrap()
    }

    fn require_whitelisted(e: &Env, addr: &Address) {
        if !RegistryClient::new(e, &Self::registry(e)).is_whitelisted(addr) {
            panic_with_error!(e, CampaignError::NotWhitelisted);
        }
    }
}

#[contractimpl(contracttrait)]
impl Ownable for Campaign {}

mod test;
