#![cfg(test)]

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

#[test]
fn release_to_business_moves_principal() {
    let f = setup();
    let alice = Address::generate(&f.e);
    f.registry.add(&alice);
    f.usdc_admin.mint(&alice, &500);
    f.campaign.invest(&alice, &500);

    f.campaign.release_to_business();

    assert_eq!(f.usdc.balance(&f.business), 500);
    assert_eq!(f.usdc.balance(&f.camp_id), 0);
    assert_eq!(f.campaign.released(), 500);
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
