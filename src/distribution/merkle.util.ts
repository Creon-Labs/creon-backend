import { createHash } from 'crypto';
import { Address, nativeToScVal, xdr } from '@stellar/stellar-sdk';

/**
 * Commutative (sorted-pair) SHA-256 Merkle tree for dividend claims — the exact
 * off-chain mirror of the on-chain verifier in `contracts/campaign/src/merkle.rs`
 * and the leaf encoding in `contracts/campaign/src/lib.rs` (`DistributionLeaf`).
 *
 * A leaf is `SHA-256( XDR( DistributionLeaf { index: u32, address: Address,
 * amount: i128 } ) )`. A `#[contracttype]` struct serialises to an `ScVal::Map`
 * whose entries are sorted by symbol key (`address` < `amount` < `index`), so the
 * entry order in {@link leafHash} is **load-bearing** — it is pinned against a
 * Rust-emitted test vector in `merkle.util.spec.ts`, because a one-byte mismatch
 * makes every on-chain `claim()` revert with `InvalidProof`.
 *
 * Parents hash their two children in ascending byte order ({@link hashPair}), so a
 * proof is just the list of sibling hashes with no left/right position bits — which
 * maps directly to `DistributionClaim.merkleProof` (a `String[]` of hex hashes).
 * The contract only *verifies* proofs, so the tree-shaping choices here (adjacent
 * pairing, lone-node promotion) need only be self-consistent: every proof this
 * builder emits folds back to the root it returns.
 */

function sha256(data: Buffer): Buffer {
  return createHash('sha256').update(data).digest();
}

/**
 * The 32-byte SHA-256 leaf hash for one dividend entitlement. `amount` is the
 * on-chain `i128` value (stroops). The `ScMapEntry` order (address, amount, index)
 * matches the contract's sorted-key struct encoding — do not reorder.
 */
export function leafHash(
  index: number,
  address: string,
  amount: bigint,
): Buffer {
  const leaf = xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('address'),
      val: Address.fromString(address).toScVal(),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('amount'),
      val: nativeToScVal(amount, { type: 'i128' }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('index'),
      val: xdr.ScVal.scvU32(index),
    }),
  ]);
  return sha256(leaf.toXDR());
}

/** Hash an ordered pair of nodes commutatively (smaller byte array first) —
 *  mirrors `merkle.rs::hash_pair`. */
export function hashPair(a: Buffer, b: Buffer): Buffer {
  const [lo, hi] = Buffer.compare(a, b) <= 0 ? [a, b] : [b, a];
  return sha256(Buffer.concat([lo, hi]));
}

/**
 * Build a commutative Merkle tree over `leaves` (in leaf-index order). Returns the
 * root and, for each leaf, its proof (sibling hashes bottom-up, aligned with the
 * input order so `proofs[i]` is the proof for `leaves[i]`). A lone odd node is
 * promoted unchanged to the next level (no sibling recorded), so the verifier folds
 * only the siblings the proof lists. A single leaf yields root = that leaf, proof [].
 */
export function buildMerkleTree(leaves: Buffer[]): {
  root: Buffer;
  proofs: Buffer[][];
} {
  if (leaves.length === 0) {
    throw new Error('buildMerkleTree requires at least one leaf');
  }
  const proofs: Buffer[][] = leaves.map(() => []);
  // Walk the tree level by level; `owners[i]` tracks which leaf indices sit under
  // node `level[i]`, so when two nodes pair we can append each as the other's
  // sibling to every leaf beneath it.
  let level = leaves;
  let owners: number[][] = leaves.map((_, i) => [i]);

  while (level.length > 1) {
    const nextLevel: Buffer[] = [];
    const nextOwners: number[][] = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 < level.length) {
        for (const leafIdx of owners[i]) proofs[leafIdx].push(level[i + 1]);
        for (const leafIdx of owners[i + 1]) proofs[leafIdx].push(level[i]);
        nextLevel.push(hashPair(level[i], level[i + 1]));
        nextOwners.push([...owners[i], ...owners[i + 1]]);
      } else {
        nextLevel.push(level[i]); // lone odd node promoted unchanged
        nextOwners.push(owners[i]);
      }
    }
    level = nextLevel;
    owners = nextOwners;
  }

  return { root: level[0], proofs };
}
