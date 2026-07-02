import { Prisma } from '../../generated/prisma/client';
import { VoteChoice } from '../../generated/prisma/enums';
import { tallyVotes } from './milestone.util';

const D = (n: string | number) => new Prisma.Decimal(n);
const SUPPLY = D(1000);

describe('tallyVotes', () => {
  it('meets quorum and approval on a clear majority', () => {
    // 500/1000 = 50% ≥ 30% quorum; 400/500 = 80% > 50% approval.
    const t = tallyVotes(
      [
        { weight: D(400), choice: VoteChoice.APPROVE },
        { weight: D(100), choice: VoteChoice.REJECT },
      ],
      SUPPLY,
      3000,
      5000,
    );
    expect(t.quorumMet).toBe(true);
    expect(t.approvalMet).toBe(true);
  });

  it('misses quorum when too little weight votes', () => {
    // 200/1000 = 20% < 30%.
    const t = tallyVotes(
      [{ weight: D(200), choice: VoteChoice.APPROVE }],
      SUPPLY,
      3000,
      5000,
    );
    expect(t.quorumMet).toBe(false);
  });

  it('counts an exact quorum boundary as met (>=)', () => {
    // 300/1000 = exactly 30%.
    const t = tallyVotes(
      [{ weight: D(300), choice: VoteChoice.APPROVE }],
      SUPPLY,
      3000,
      5000,
    );
    expect(t.quorumMet).toBe(true);
  });

  it('fails approval on an exact tie (strict majority)', () => {
    // participation 500 ≥ 300; approve 250/500 = exactly 50%, not > 50%.
    const t = tallyVotes(
      [
        { weight: D(250), choice: VoteChoice.APPROVE },
        { weight: D(250), choice: VoteChoice.REJECT },
      ],
      SUPPLY,
      3000,
      5000,
    );
    expect(t.quorumMet).toBe(true);
    expect(t.approvalMet).toBe(false);
  });

  it('never meets quorum against an absent/zero supply', () => {
    const t = tallyVotes([], null, 3000, 5000);
    expect(t.quorumMet).toBe(false);
    expect(t.approvalMet).toBe(false);
  });
});
