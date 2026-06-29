//! Commutative (sorted-pair) SHA-256 Merkle proof verification for dividend claims.
//!
//! Hashing each pair in sorted byte order makes the hash commutative, so a proof
//! is just the list of sibling hashes — no left/right position bits — which maps
//! directly to `DistributionClaim.merkleProof` (a `String[]` of hashes).
//!
//! The Phase-6 backend that builds these trees MUST use the identical scheme
//! (SHA-256 leaves of the XDR-encoded `DistributionLeaf`, sorted-pair parents)
//! or on-chain verification will reject otherwise-valid claims.

use soroban_sdk::{Bytes, BytesN, Env, Vec};

/// Verify a commutative SHA-256 Merkle proof: fold `leaf` with each sibling in
/// `proof` and compare the computed root to `root`.
pub(crate) fn verify_proof(
    e: &Env,
    root: &BytesN<32>,
    leaf: BytesN<32>,
    proof: &Vec<BytesN<32>>,
) -> bool {
    let mut computed = leaf;
    for sibling in proof.iter() {
        computed = hash_pair(e, &computed, &sibling);
    }
    computed == *root
}

/// Hash an ordered pair of nodes commutatively (smaller byte array first).
pub(crate) fn hash_pair(e: &Env, a: &BytesN<32>, b: &BytesN<32>) -> BytesN<32> {
    let (lo, hi) = if a.to_array() <= b.to_array() {
        (a, b)
    } else {
        (b, a)
    };
    let mut buf = Bytes::new(e);
    buf.append(&Bytes::from_array(e, &lo.to_array()));
    buf.append(&Bytes::from_array(e, &hi.to_array()));
    e.crypto().sha256(&buf).to_bytes()
}
