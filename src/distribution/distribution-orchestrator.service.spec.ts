import { Queue } from 'bullmq';
import { Prisma } from '../../generated/prisma/client';
import { DistributionStatus } from '../../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { SorobanService } from '../soroban/soroban.service';
import { DistributionOrchestratorService } from './distribution-orchestrator.service';

const ALICE = 'GCHPJMNH7WWIHX7CY5CKWR3I35A5DK4X6IU7CJSFUDHTBEWWMI6VEHFJ';
const BOB = 'GCUQRLMIYPTNGYQBEN6P6HMTDAETLKYEQORMQWV7SKNTX7XDDNN3OCBY';
const CAROL = 'GDXTJXOSJOEHZ6VLIYB35ON2YM3FYH6AYIFJ7YHFNCANALD35HTXZ6MR';

/** Two holders splitting 1000 USDC 60/40 by share balance. */
const HOLDINGS = [
  {
    holderId: 'u-alice',
    holderAddress: ALICE,
    balance: new Prisma.Decimal('600'),
  },
  { holderId: 'u-bob', holderAddress: BOB, balance: new Prisma.Decimal('400') },
];

function makeDeps() {
  const prisma = {
    profitDistribution: {
      findUnique: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
    },
    distributionClaim: {
      count: jest.fn().mockResolvedValue(0),
      createMany: jest.fn().mockReturnValue('CREATE_MANY_OP'),
    },
    tokenHolding: {
      findMany: jest.fn().mockResolvedValue(HOLDINGS),
    },
    $transaction: jest.fn().mockResolvedValue([]),
  };
  const soroban = {
    u32Arg: jest.fn((x: number) => ({ u32: x })),
    bytesArg: jest.fn((b: Buffer) => ({ bytes: b })),
    invokeContract: jest.fn().mockResolvedValue({ txHash: 'txset' }),
  };
  const queue = {
    add: jest.fn().mockResolvedValue(undefined),
    remove: jest.fn().mockResolvedValue(undefined),
  };
  const service = new DistributionOrchestratorService(
    prisma as unknown as PrismaService,
    soroban as unknown as SorobanService,
    queue as unknown as Queue,
  );
  return { service, prisma, soroban, queue };
}

function makeDistribution(overrides: Record<string, unknown> = {}) {
  return {
    id: 'dist-1',
    campaignId: 'camp-1',
    onchainId: 0,
    totalAmount: new Prisma.Decimal('1000'),
    merkleRoot: null,
    setDistributionTxHash: null,
    status: DistributionStatus.PENDING,
    campaign: { contractAddress: 'CCAMP' },
    ...overrides,
  };
}

describe('DistributionOrchestratorService.drive', () => {
  it('snapshots holdings, builds pro-rata claims, posts the root, marks COMPLETED', async () => {
    const { service, prisma, soroban } = makeDeps();
    prisma.profitDistribution.findUnique.mockResolvedValue(makeDistribution());

    await service.drive('dist-1');

    // Distribution updated with computed totals + a hex root.
    expect(prisma.profitDistribution.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'dist-1' },
        data: expect.objectContaining({
          totalShares: expect.anything() as unknown,
          rewardPerShare: expect.anything() as unknown,
          merkleRoot: expect.stringMatching(/^[0-9a-f]{64}$/) as unknown,
        }) as unknown,
      }) as unknown,
    );
    // One claim per holder, pro-rata (600 / 400 of 1000), with a proof each.
    expect(prisma.distributionClaim.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.arrayContaining([
          expect.objectContaining({
            investorId: 'u-alice',
            leafIndex: 0,
            amount: new Prisma.Decimal('600'),
            merkleProof: expect.any(Array) as unknown,
          }),
          expect.objectContaining({
            investorId: 'u-bob',
            leafIndex: 1,
            amount: new Prisma.Decimal('400'),
          }),
        ]) as unknown,
      }) as unknown,
    );
    // Root posted on-chain via set_distribution(onchainId, root).
    expect(soroban.u32Arg).toHaveBeenCalledWith(0);
    expect(soroban.invokeContract).toHaveBeenCalledWith(
      'CCAMP',
      'set_distribution',
      expect.any(Array),
    );
    expect(prisma.profitDistribution.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: DistributionStatus.COMPLETED,
        }) as unknown,
      }) as unknown,
    );
  });

  it('pro-rata amounts sum to ≤ the deposited total (integer-floor)', async () => {
    const { service, prisma } = makeDeps();
    // 1000 split three ways evenly → floor(333.3333333) each; Σ = 999.9999999 ≤ 1000.
    prisma.tokenHolding.findMany.mockResolvedValue([
      { holderId: 'a', holderAddress: ALICE, balance: new Prisma.Decimal('1') },
      { holderId: 'b', holderAddress: BOB, balance: new Prisma.Decimal('1') },
      { holderId: 'c', holderAddress: CAROL, balance: new Prisma.Decimal('1') },
    ]);
    prisma.profitDistribution.findUnique.mockResolvedValue(makeDistribution());

    let rows: { amount: Prisma.Decimal }[] = [];
    prisma.distributionClaim.createMany.mockImplementation(
      (arg: { data: { amount: Prisma.Decimal }[] }) => {
        rows = arg.data;
        return 'CREATE_MANY_OP';
      },
    );

    await service.drive('dist-1');

    const sum = rows.reduce(
      (acc, r) => acc.plus(r.amount),
      new Prisma.Decimal(0),
    );
    expect(rows).toHaveLength(3);
    expect(sum.equals(new Prisma.Decimal('999.9999999'))).toBe(true); // 3 × 333.3333333
    expect(sum.lessThanOrEqualTo(new Prisma.Decimal('1000'))).toBe(true);
  });

  it('resumes when claims already exist: posts the root without rebuilding', async () => {
    const { service, prisma, soroban } = makeDeps();
    prisma.profitDistribution.findUnique.mockResolvedValue(
      makeDistribution({ merkleRoot: 'a'.repeat(64) }),
    );
    prisma.distributionClaim.count.mockResolvedValue(2);

    await service.drive('dist-1');

    expect(prisma.tokenHolding.findMany).not.toHaveBeenCalled();
    expect(prisma.distributionClaim.createMany).not.toHaveBeenCalled();
    expect(soroban.invokeContract).toHaveBeenCalledWith(
      'CCAMP',
      'set_distribution',
      expect.any(Array),
    );
  });

  it('resumes when the root is already posted: no on-chain call', async () => {
    const { service, prisma, soroban } = makeDeps();
    prisma.profitDistribution.findUnique.mockResolvedValue(
      makeDistribution({
        merkleRoot: 'a'.repeat(64),
        setDistributionTxHash: 'txset',
      }),
    );
    prisma.distributionClaim.count.mockResolvedValue(2);

    await service.drive('dist-1');

    expect(soroban.invokeContract).not.toHaveBeenCalled();
    expect(prisma.profitDistribution.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: DistributionStatus.COMPLETED,
        }) as unknown,
      }) as unknown,
    );
  });

  it('treats a DistributionExists on-chain error as already-posted and completes', async () => {
    const { service, prisma, soroban } = makeDeps();
    prisma.profitDistribution.findUnique.mockResolvedValue(makeDistribution());
    soroban.invokeContract.mockRejectedValue(
      new Error('tx abc123 ended FAILED: HostError: Error(Contract, #3)'),
    );

    await expect(service.drive('dist-1')).resolves.toBeUndefined();

    expect(prisma.profitDistribution.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: DistributionStatus.COMPLETED,
        }) as unknown,
      }) as unknown,
    );
  });

  it('completes with no on-chain post when there are no eligible holders', async () => {
    const { service, prisma, soroban } = makeDeps();
    prisma.profitDistribution.findUnique.mockResolvedValue(makeDistribution());
    prisma.tokenHolding.findMany.mockResolvedValue([]);

    await service.drive('dist-1');

    expect(soroban.invokeContract).not.toHaveBeenCalled();
    expect(prisma.distributionClaim.createMany).not.toHaveBeenCalled();
    expect(prisma.profitDistribution.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: DistributionStatus.COMPLETED,
        }) as unknown,
      }) as unknown,
    );
  });

  it('does nothing when already COMPLETED', async () => {
    const { service, prisma, soroban } = makeDeps();
    prisma.profitDistribution.findUnique.mockResolvedValue(
      makeDistribution({ status: DistributionStatus.COMPLETED }),
    );

    await service.drive('dist-1');

    expect(prisma.distributionClaim.count).not.toHaveBeenCalled();
    expect(soroban.invokeContract).not.toHaveBeenCalled();
  });

  it('marks FAILED with the error and rethrows for BullMQ to retry', async () => {
    const { service, prisma } = makeDeps();
    prisma.profitDistribution.findUnique.mockResolvedValue(makeDistribution());
    prisma.distributionClaim.count.mockRejectedValue(new Error('db down'));

    await expect(service.drive('dist-1')).rejects.toThrow('db down');

    expect(prisma.profitDistribution.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: DistributionStatus.FAILED,
          distributionError: 'db down',
          distributionAttempts: { increment: 1 },
        }) as unknown,
      }) as unknown,
    );
  });
});

describe('DistributionOrchestratorService queueing', () => {
  it('enqueue clears any stale job then adds with jobId = distributionId', async () => {
    const { service, queue } = makeDeps();
    await service.enqueue('dist-1');
    expect(queue.remove).toHaveBeenCalledWith('dist-1');
    expect(queue.add).toHaveBeenCalledWith(
      'distribute',
      { distributionId: 'dist-1' },
      expect.objectContaining({ jobId: 'dist-1' }) as unknown,
    );
  });

  it('reconcile re-enqueues every not-yet-COMPLETED distribution', async () => {
    const { service, prisma, queue } = makeDeps();
    prisma.profitDistribution.findMany.mockResolvedValue([
      { id: 'a' },
      { id: 'b' },
    ]);
    await service.reconcile();
    expect(prisma.profitDistribution.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: { not: DistributionStatus.COMPLETED } },
      }) as unknown,
    );
    expect(queue.add).toHaveBeenCalledTimes(2);
  });
});
