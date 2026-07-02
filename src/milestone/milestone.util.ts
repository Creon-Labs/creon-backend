import { Prisma } from '../../generated/prisma/client';
import { VoteChoice } from '../../generated/prisma/enums';
import { toStroops } from '../campaign/campaign.util';

/** Allowed proof-of-progress upload types → file extension. */
export const PROOF_MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'application/pdf': 'pdf',
};

/** The tally of an off-chain milestone vote, all weights in stroop integers. */
export interface Tally {
  /** Total voting weight (shares) that has been cast. */
  participationStroops: bigint;
  approveStroops: bigint;
  rejectStroops: bigint;
  /** Denominator: total supply snapshotted when voting opened. */
  supplyStroops: bigint;
  /** participation / supply ≥ quorumBps ⁄ 10000. */
  quorumMet: boolean;
  /** approve / participation > approvalBps ⁄ 10000 (strict majority when 5000). */
  approvalMet: boolean;
}

/**
 * Tally votes by share-weight against the frozen supply. All math is BigInt at
 * 7-dp fixed point — no floats — so the quorum/approval comparisons are exact.
 * `quorumBps`/`approvalBps` are basis points (e.g. 3000 = 30%, 5000 = >50%).
 */
export function tallyVotes(
  votes: { weight: Prisma.Decimal; choice: VoteChoice }[],
  snapshotTotalSupply: Prisma.Decimal | null,
  quorumBps: number,
  approvalBps: number,
): Tally {
  const participation = votes.reduce((sum, v) => sum + toStroops(v.weight), 0n);
  const approve = votes
    .filter((v) => v.choice === VoteChoice.APPROVE)
    .reduce((sum, v) => sum + toStroops(v.weight), 0n);
  const supply = snapshotTotalSupply ? toStroops(snapshotTotalSupply) : 0n;

  return {
    participationStroops: participation,
    approveStroops: approve,
    rejectStroops: participation - approve,
    supplyStroops: supply,
    quorumMet:
      supply > 0n && participation * 10000n >= supply * BigInt(quorumBps),
    approvalMet:
      participation > 0n &&
      approve * 10000n > participation * BigInt(approvalBps),
  };
}
