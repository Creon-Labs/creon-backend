import { buildMerkleTree, hashPair, leafHash } from './merkle.util';

// Ground-truth vectors emitted by the on-chain contract's own encoding — see
// `print_merkle_test_vector` in `contracts/campaign/src/test.rs`
// (`cargo test -p campaign print_merkle_test_vector -- --nocapture`). If any of
// these fail, the TS leaf encoding has drifted from the contract and every on-chain
// claim() would revert with InvalidProof.
const ALICE = 'GCHPJMNH7WWIHX7CY5CKWR3I35A5DK4X6IU7CJSFUDHTBEWWMI6VEHFJ';
const BOB = 'GCUQRLMIYPTNGYQBEN6P6HMTDAETLKYEQORMQWV7SKNTX7XDDNN3OCBY';
const LEAF_A =
  '421550d087fbc7e45b7177b72e5ab965bc07f02ea0c540f69201354ee23371a3';
const LEAF_B =
  '54591c91b4e81c776741d1a18f96ec9eadb9be2ced76239c11cb051f8835e901';
const ROOT = '96f59c51765006f5861b29aa814a2225a99b3e5bae5ac8e0478231a65313a529';

/** The contract's verifier: fold the leaf with each proof sibling via hashPair. */
function foldProof(leaf: Buffer, proof: Buffer[]): Buffer {
  return proof.reduce((acc, sib) => hashPair(acc, sib), leaf);
}

describe('leafHash (must match the on-chain DistributionLeaf encoding)', () => {
  it('reproduces the Rust-emitted leaf hashes byte-for-byte', () => {
    expect(leafHash(0, ALICE, 600n).toString('hex')).toBe(LEAF_A);
    expect(leafHash(1, BOB, 400n).toString('hex')).toBe(LEAF_B);
  });

  it('is sensitive to index and amount (distinct leaves)', () => {
    expect(leafHash(0, ALICE, 600n).equals(leafHash(1, ALICE, 600n))).toBe(
      false,
    );
    expect(leafHash(0, ALICE, 600n).equals(leafHash(0, ALICE, 601n))).toBe(
      false,
    );
  });
});

describe('hashPair', () => {
  it('is commutative (sorted-pair)', () => {
    const a = leafHash(0, ALICE, 600n);
    const b = leafHash(1, BOB, 400n);
    expect(hashPair(a, b).equals(hashPair(b, a))).toBe(true);
  });
});

describe('buildMerkleTree', () => {
  it('matches the on-chain 2-leaf root and emits the sibling proofs', () => {
    const a = leafHash(0, ALICE, 600n);
    const b = leafHash(1, BOB, 400n);
    const { root, proofs } = buildMerkleTree([a, b]);

    expect(root.toString('hex')).toBe(ROOT);
    // Proof for a is [b], for b is [a] (the other leaf), matching test.rs.
    expect(proofs[0].map((p) => p.toString('hex'))).toEqual([LEAF_B]);
    expect(proofs[1].map((p) => p.toString('hex'))).toEqual([LEAF_A]);
  });

  it('handles a single leaf (root = leaf, empty proof)', () => {
    const a = leafHash(0, ALICE, 1000n);
    const { root, proofs } = buildMerkleTree([a]);
    expect(root.equals(a)).toBe(true);
    expect(proofs).toEqual([[]]);
  });

  it('promotes a lone odd node so every proof folds back to the root', () => {
    // 3 leaves exercise the odd-node promotion path.
    const leaves = [
      leafHash(0, ALICE, 100n),
      leafHash(1, BOB, 200n),
      leafHash(2, ALICE, 300n),
    ];
    const { root, proofs } = buildMerkleTree(leaves);
    leaves.forEach((leaf, i) => {
      expect(foldProof(leaf, proofs[i]).equals(root)).toBe(true);
    });
  });

  it('every proof folds to the root for a larger unbalanced tree (5 leaves)', () => {
    const leaves = Array.from({ length: 5 }, (_, i) =>
      leafHash(i, i % 2 === 0 ? ALICE : BOB, BigInt((i + 1) * 111)),
    );
    const { root, proofs } = buildMerkleTree(leaves);
    leaves.forEach((leaf, i) => {
      expect(foldProof(leaf, proofs[i]).equals(root)).toBe(true);
    });
  });

  it('throws on an empty leaf set', () => {
    expect(() => buildMerkleTree([])).toThrow();
  });
});
