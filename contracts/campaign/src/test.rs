#![cfg(test)]

extern crate std;

use super::*;
use soroban_sdk::testutils::Address as _;
use soroban_sdk::xdr::ToXdr;
use soroban_sdk::{Address, BytesN, Env, String, Vec};

use compliance_registry::{ComplianceRegistry, ComplianceRegistryClient};
use share_token::{ShareToken, ShareTokenClient};

const GOAL: i128 = 1_000_000;
const LOCK_PERIOD: u64 = 100;

struct F {
    e: Env,
    owner: Address,
    business: Address,
    camp_id: Address,
    campaign: CampaignClient<'static>,
    token: ShareTokenClient<'static>,
    registry: ComplianceRegistryClient<'static>,
    usdc_admin: token::StellarAssetClient<'static>,
    usdc: token::TokenClient<'static>,
}

fn setup() -> F {
    let e = Env::default();
    e.mock_all_auths();

    let owner = Address::generate(&e);
    let business = Address::generate(&e);

    let reg_id = e.register(ComplianceRegistry, (owner.clone(),));
    let registry = ComplianceRegistryClient::new(&e, &reg_id);

    // Test USDC as a Stellar Asset Contract.
    let sac = e.register_stellar_asset_contract_v2(owner.clone());
    let usdc_addr = sac.address();
    let usdc_admin = token::StellarAssetClient::new(&e, &usdc_addr);
    let usdc = token::TokenClient::new(&e, &usdc_addr);

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

    let camp_id = e.register(
        Campaign,
        (
            owner.clone(),
            token_id.clone(),
            reg_id.clone(),
            usdc_addr.clone(),
            business.clone(),
            GOAL,
            LOCK_PERIOD,
            Vec::from_array(&e, [600_000i128, 400_000i128]), // milestones, sum == GOAL
        ),
    );
    let campaign = CampaignClient::new(&e, &camp_id);

    // Wire the campaign as the token's sole minter.
    token.set_minter(&camp_id);

    F {
        e,
        owner,
        business,
        camp_id,
        campaign,
        token,
        registry,
        usdc_admin,
        usdc,
    }
}

fn leaf_hash(e: &Env, index: u32, address: &Address, amount: i128) -> BytesN<32> {
    let leaf = DistributionLeaf {
        index,
        address: address.clone(),
        amount,
    };
    e.crypto().sha256(&leaf.to_xdr(e)).to_bytes()
}

#[test]
fn invest_happy_path() {
    let f = setup();
    let alice = Address::generate(&f.e);
    f.registry.add(&alice);
    f.usdc_admin.mint(&alice, &500);

    f.campaign.invest(&alice, &500);

    assert_eq!(f.token.balance(&alice), 500); // shares minted 1:1
    assert_eq!(f.campaign.raised(), 500);
    assert_eq!(f.usdc.balance(&f.camp_id), 500); // USDC in custody
}

#[test]
fn invest_non_whitelisted_reverts() {
    let f = setup();
    let mallory = Address::generate(&f.e);
    f.usdc_admin.mint(&mallory, &500);

    assert!(f.campaign.try_invest(&mallory, &500).is_err());
    assert_eq!(f.token.balance(&mallory), 0);
    assert_eq!(f.campaign.raised(), 0);
}

/// Fund the campaign to its goal with one whitelisted investor, so milestone
/// releases (gated on `raised >= goal`, all-or-nothing) are unlocked.
fn fund_to_goal(f: &F) -> Address {
    let alice = Address::generate(&f.e);
    f.registry.add(&alice);
    f.usdc_admin.mint(&alice, &GOAL);
    f.campaign.invest(&alice, &GOAL);
    alice
}

#[test]
fn release_milestone_sequential_pays() {
    let f = setup();
    fund_to_goal(&f);

    // Milestone 0 → 600_000, then milestone 1 → 400_000 (sum == GOAL).
    f.campaign.release_milestone(&0u32);
    assert_eq!(f.usdc.balance(&f.business), 600_000);
    assert_eq!(f.campaign.released(), 600_000);
    assert_eq!(f.campaign.next_milestone(), 1);

    f.campaign.release_milestone(&1u32);
    assert_eq!(f.usdc.balance(&f.business), GOAL);
    assert_eq!(f.usdc.balance(&f.camp_id), 0);
    assert_eq!(f.campaign.released(), GOAL);
    assert_eq!(f.campaign.next_milestone(), 2);
}

#[test]
fn release_out_of_order_reverts() {
    let f = setup();
    fund_to_goal(&f);

    // Cannot skip milestone 0.
    assert!(f.campaign.try_release_milestone(&1u32).is_err());
    assert_eq!(f.campaign.released(), 0);
    assert_eq!(f.campaign.next_milestone(), 0);
}

#[test]
fn release_before_funding_goal_reverts() {
    let f = setup();
    let alice = Address::generate(&f.e);
    f.registry.add(&alice);
    f.usdc_admin.mint(&alice, &500);
    f.campaign.invest(&alice, &500); // raised 500 < GOAL

    assert!(f.campaign.try_release_milestone(&0u32).is_err());
    assert_eq!(f.campaign.released(), 0);
}

#[test]
fn double_release_reverts() {
    let f = setup();
    fund_to_goal(&f);

    f.campaign.release_milestone(&0u32);
    // Re-releasing index 0 now fails (next is 1): the sequential counter is also the
    // once-only gate.
    assert!(f.campaign.try_release_milestone(&0u32).is_err());
    assert_eq!(f.campaign.next_milestone(), 1);
}

#[test]
#[should_panic]
fn constructor_milestone_sum_mismatch_reverts() {
    let e = Env::default();
    e.mock_all_auths();
    let owner = Address::generate(&e);
    let business = Address::generate(&e);
    let reg_id = e.register(ComplianceRegistry, (owner.clone(),));
    let sac = e.register_stellar_asset_contract_v2(owner.clone());
    let usdc_addr = sac.address();
    let token_id = e.register(
        ShareToken,
        (
            owner.clone(),
            reg_id.clone(),
            String::from_str(&e, "Creon Share"),
            String::from_str(&e, "CRS"),
        ),
    );

    // Milestones sum to 900_000 != GOAL (1_000_000) → constructor must reject.
    e.register(
        Campaign,
        (
            owner,
            token_id,
            reg_id,
            usdc_addr,
            business,
            GOAL,
            LOCK_PERIOD,
            Vec::from_array(&e, [600_000i128, 300_000i128]),
        ),
    );
}

#[test]
fn unlock_enables_transfers() {
    let f = setup();
    let alice = Address::generate(&f.e);
    f.registry.add(&alice);
    f.usdc_admin.mint(&alice, &500);
    f.campaign.invest(&alice, &500);

    // locked at construction
    assert!(f.token.is_locked());
    f.campaign.unlock();
    assert!(!f.token.is_locked());
}

#[test]
fn claim_valid_proof_pays_rejects_forged_and_double() {
    let f = setup();

    // Fund the distribution pot.
    f.usdc_admin.mint(&f.owner, &1_000);
    f.campaign.deposit_profit(&f.owner, &1_000);

    let alice = Address::generate(&f.e);
    let bob = Address::generate(&f.e);
    f.registry.add(&alice);
    f.registry.add(&bob);

    // 2-leaf tree: alice idx0 -> 600, bob idx1 -> 400.
    let ha = leaf_hash(&f.e, 0, &alice, 600);
    let hb = leaf_hash(&f.e, 1, &bob, 400);
    let root = crate::merkle::hash_pair(&f.e, &ha, &hb);
    f.campaign.set_distribution(&0u32, &root);

    // Alice claims with the valid proof [hb].
    let proof_a = Vec::from_array(&f.e, [hb.clone()]);
    f.campaign.claim(&0u32, &0u32, &alice, &600i128, &proof_a);
    assert_eq!(f.usdc.balance(&alice), 600);

    // Double-claim is rejected.
    assert!(f
        .campaign
        .try_claim(&0u32, &0u32, &alice, &600i128, &proof_a)
        .is_err());

    // Forged proof (random sibling) is rejected.
    let forged = Vec::from_array(&f.e, [BytesN::from_array(&f.e, &[9u8; 32])]);
    assert!(f
        .campaign
        .try_claim(&0u32, &1u32, &bob, &400i128, &forged)
        .is_err());

    // Tampered amount with an otherwise-structural sibling is rejected (leaf differs).
    let proof_b = Vec::from_array(&f.e, [ha.clone()]);
    assert!(f
        .campaign
        .try_claim(&0u32, &1u32, &bob, &999i128, &proof_b)
        .is_err());

    // Bob's correct claim still succeeds.
    f.campaign.claim(&0u32, &1u32, &bob, &400i128, &proof_b);
    assert_eq!(f.usdc.balance(&bob), 400);
}

#[test]
fn claim_before_distribution_set_reverts() {
    let f = setup();
    let alice = Address::generate(&f.e);
    let proof = Vec::from_array(&f.e, [BytesN::from_array(&f.e, &[1u8; 32])]);
    assert!(f
        .campaign
        .try_claim(&7u32, &0u32, &alice, &1i128, &proof)
        .is_err());
}

/// Prints a reproducible test vector (fixed addresses) so the Phase-6 TypeScript
/// Merkle builder can assert byte-identical leaf hashes + root. Run with
/// `cargo test -p campaign print_merkle_test_vector -- --nocapture`.
#[test]
fn print_merkle_test_vector() {
    let e = Env::default();
    let alice = Address::from_string(&String::from_str(
        &e,
        "GCHPJMNH7WWIHX7CY5CKWR3I35A5DK4X6IU7CJSFUDHTBEWWMI6VEHFJ",
    ));
    let bob = Address::from_string(&String::from_str(
        &e,
        "GCUQRLMIYPTNGYQBEN6P6HMTDAETLKYEQORMQWV7SKNTX7XDDNN3OCBY",
    ));
    let ha = leaf_hash(&e, 0, &alice, 600);
    let hb = leaf_hash(&e, 1, &bob, 400);
    let root = crate::merkle::hash_pair(&e, &ha, &hb);

    let to_hex = |b: &BytesN<32>| -> std::string::String {
        b.to_array()
            .iter()
            .map(|x| std::format!("{:02x}", x))
            .collect()
    };
    std::println!("MERKLE_VECTOR LEAF_A(idx0,600)={}", to_hex(&ha));
    std::println!("MERKLE_VECTOR LEAF_B(idx1,400)={}", to_hex(&hb));
    std::println!("MERKLE_VECTOR ROOT={}", to_hex(&root));
}
