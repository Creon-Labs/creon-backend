import { Queue } from 'bullmq';
import { Prisma } from '../../generated/prisma/client';
import { RefundStatus } from '../../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { SorobanService } from '../soroban/soroban.service';
import { RefundOrchestratorService } from './refund-orchestrator.service';

const ALICE = 'GCHPJMNH7WWIHX7CY5CKWR3I35A5DK4X6IU7CJSFUDHTBEWWMI6VEHFJ';
const BOB = 'GCUQRLMIYPTNGYQBEN6P6HMTDAETLKYEQORMQWV7SKNTX7XDDNN3OCBY';
const CAROL = 'GDXTJXOSJOEHZ6VLIYB35ON2YM3FYH6AYIFJ7YHFNCANALD35HTXZ6MR';

/** Two holders splitting 1000 USDC of remaining custody 60/40 by share balance. */
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
    refund: {
      findUnique: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
    },
    refundClaim: {
      count: jest.fn().mockResolvedValue(0),
      createMany: jest.fn().mockReturnValue('CREATE_MANY_OP'),
    },
    tokenHolding: {
      findMany: jest.fn().mockResolvedValue(HOLDINGS),
    },
    $transaction: jest.fn().mockResolvedValue([]),
  };
  const soroban = {
    bytesArg: jest.fn((b: Buffer) => ({ bytes: b })),
    invokeContract: jest.fn().mockResolvedValue({ txHash: 'txchain' }),
    // remaining custody = raised(1000) - released(0), read on-chain.
    simulateRead: jest.fn((_addr: string, func: string) =>
      Promise.resolve({ func }),
    ),
    readI128: jest.fn((v: { func: string }) =>
      v.func === 'raised' ? 10_000_000_000n : 0n,
    ),
    latestLedger: jest.fn().mockResolvedValue(12345),
  };
  const queue = {
    add: jest.fn().mockResolvedValue(undefined),
    remove: jest.fn().mockResolvedValue(undefined),
  };
  const service = new RefundOrchestratorService(
    prisma as unknown as PrismaService,
    soroban as unknown as SorobanService,
    queue as unknown as Queue,
  );
  return { service, prisma, soroban, queue };
}

function makeRefund(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ref-1',
    campaignId: 'camp-1',
    merkleRoot: null,
    cancelTxHash: null,
    setRefundTxHash: null,
    status: RefundStatus.PENDING,
    campaign: { contractAddress: 'CCAMP' },
    ...overrides,
  };
}

describe('RefundOrchestratorService.drive', () => {
  it('cancels on-chain, snapshots holders, builds pro-rata claims, posts the refund root, COMPLETED', async () => {
    const { service, prisma, soroban } = makeDeps();
    prisma.refund.findUnique.mockResolvedValue(makeRefund());

    await service.drive('ref-1');

    // Step 1: freeze the campaign on-chain.
    expect(soroban.invokeContract).toHaveBeenCalledWith('CCAMP', 'cancel', []);
    expect(prisma.refund.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          cancelTxHash: 'txchain',
        }) as unknown,
      }) as unknown,
    );
    // Step 2: refund row updated with totals + a hex root.
    expect(prisma.refund.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          totalAmount: new Prisma.Decimal('1000'),
          totalShares: expect.anything() as unknown,
          merkleRoot: expect.stringMatching(/^[0-9a-f]{64}$/) as unknown,
        }) as unknown,
      }) as unknown,
    );
    // One claim per holder, pro-rata (600 / 400 of the 1000 custody), with a proof each.
    expect(prisma.refundClaim.createMany).toHaveBeenCalledWith(
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
    // Step 3: root posted on-chain via set_refund(root).
    expect(soroban.invokeContract).toHaveBeenCalledWith(
      'CCAMP',
      'set_refund',
      expect.any(Array),
    );
    expect(prisma.refund.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: RefundStatus.COMPLETED,
        }) as unknown,
      }) as unknown,
    );
  });

  it('pro-rata amounts sum to ≤ the remaining custody (integer-floor)', async () => {
    const { service, prisma } = makeDeps();
    // 1000 custody split three ways evenly → floor(333.3333333) each; Σ = 999.9999999.
    prisma.tokenHolding.findMany.mockResolvedValue([
      { holderId: 'a', holderAddress: ALICE, balance: new Prisma.Decimal('1') },
      { holderId: 'b', holderAddress: BOB, balance: new Prisma.Decimal('1') },
      { holderId: 'c', holderAddress: CAROL, balance: new Prisma.Decimal('1') },
    ]);
    prisma.refund.findUnique.mockResolvedValue(makeRefund());

    let rows: { amount: Prisma.Decimal }[] = [];
    prisma.refundClaim.createMany.mockImplementation(
      (arg: { data: { amount: Prisma.Decimal }[] }) => {
        rows = arg.data;
        return 'CREATE_MANY_OP';
      },
    );

    await service.drive('ref-1');

    const sum = rows.reduce(
      (acc, r) => acc.plus(r.amount),
      new Prisma.Decimal(0),
    );
    expect(rows).toHaveLength(3);
    expect(sum.equals(new Prisma.Decimal('999.9999999'))).toBe(true);
    expect(sum.lessThanOrEqualTo(new Prisma.Decimal('1000'))).toBe(true);
  });

  it('skips cancel when already cancelled and resumes claim build + root post', async () => {
    const { service, prisma, soroban } = makeDeps();
    prisma.refund.findUnique.mockResolvedValue(
      makeRefund({ merkleRoot: 'a'.repeat(64), cancelTxHash: 'txcancel' }),
    );
    prisma.refundClaim.count.mockResolvedValue(2);

    await service.drive('ref-1');

    expect(soroban.invokeContract).not.toHaveBeenCalledWith(
      'CCAMP',
      'cancel',
      [],
    );
    expect(prisma.tokenHolding.findMany).not.toHaveBeenCalled();
    expect(prisma.refundClaim.createMany).not.toHaveBeenCalled();
    expect(soroban.invokeContract).toHaveBeenCalledWith(
      'CCAMP',
      'set_refund',
      expect.any(Array),
    );
  });

  it('resumes when the root is already posted: no on-chain call', async () => {
    const { service, prisma, soroban } = makeDeps();
    prisma.refund.findUnique.mockResolvedValue(
      makeRefund({
        merkleRoot: 'a'.repeat(64),
        cancelTxHash: 'txcancel',
        setRefundTxHash: 'txset',
      }),
    );
    prisma.refundClaim.count.mockResolvedValue(2);

    await service.drive('ref-1');

    expect(soroban.invokeContract).not.toHaveBeenCalled();
    expect(prisma.refund.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: RefundStatus.COMPLETED,
        }) as unknown,
      }) as unknown,
    );
  });

  it('treats a RefundExists on-chain error as already-posted and completes', async () => {
    const { service, prisma, soroban } = makeDeps();
    prisma.refund.findUnique.mockResolvedValue(
      makeRefund({ cancelTxHash: 'txcancel' }),
    );
    soroban.invokeContract.mockRejectedValue(
      new Error('tx abc123 ended FAILED: HostError: Error(Contract, #13)'),
    );

    await expect(service.drive('ref-1')).resolves.toBeUndefined();

    expect(prisma.refund.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: RefundStatus.COMPLETED,
        }) as unknown,
      }) as unknown,
    );
  });

  it('completes with no on-chain post when there are no eligible holders', async () => {
    const { service, prisma, soroban } = makeDeps();
    prisma.refund.findUnique.mockResolvedValue(
      makeRefund({ cancelTxHash: 'txcancel' }),
    );
    prisma.tokenHolding.findMany.mockResolvedValue([]);

    await service.drive('ref-1');

    expect(soroban.invokeContract).not.toHaveBeenCalled();
    expect(prisma.refundClaim.createMany).not.toHaveBeenCalled();
    expect(prisma.refund.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: RefundStatus.COMPLETED,
        }) as unknown,
      }) as unknown,
    );
  });

  it('completes without a payout when no custody remains (raised == released)', async () => {
    const { service, prisma, soroban } = makeDeps();
    prisma.refund.findUnique.mockResolvedValue(
      makeRefund({ cancelTxHash: 'txcancel' }),
    );
    soroban.readI128.mockReturnValue(10_000_000_000n); // raised == released → pool 0

    await service.drive('ref-1');

    expect(prisma.refundClaim.createMany).not.toHaveBeenCalled();
    expect(soroban.invokeContract).not.toHaveBeenCalledWith(
      'CCAMP',
      'set_refund',
      expect.any(Array),
    );
    expect(prisma.refund.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: RefundStatus.COMPLETED,
        }) as unknown,
      }) as unknown,
    );
  });

  it('does nothing when already COMPLETED', async () => {
    const { service, prisma, soroban } = makeDeps();
    prisma.refund.findUnique.mockResolvedValue(
      makeRefund({ status: RefundStatus.COMPLETED }),
    );

    await service.drive('ref-1');

    expect(prisma.refundClaim.count).not.toHaveBeenCalled();
    expect(soroban.invokeContract).not.toHaveBeenCalled();
  });

  it('marks FAILED with the error and rethrows for BullMQ to retry', async () => {
    const { service, prisma } = makeDeps();
    prisma.refund.findUnique.mockResolvedValue(
      makeRefund({ cancelTxHash: 'txcancel' }),
    );
    prisma.refundClaim.count.mockRejectedValue(new Error('db down'));

    await expect(service.drive('ref-1')).rejects.toThrow('db down');

    expect(prisma.refund.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: RefundStatus.FAILED,
          refundError: 'db down',
          refundAttempts: { increment: 1 },
        }) as unknown,
      }) as unknown,
    );
  });
});

describe('RefundOrchestratorService queueing', () => {
  it('enqueue clears any stale job then adds with jobId = refundId', async () => {
    const { service, queue } = makeDeps();
    await service.enqueue('ref-1');
    expect(queue.remove).toHaveBeenCalledWith('ref-1');
    expect(queue.add).toHaveBeenCalledWith(
      'refund',
      { refundId: 'ref-1' },
      expect.objectContaining({ jobId: 'ref-1' }) as unknown,
    );
  });

  it('reconcile re-enqueues every not-yet-COMPLETED refund', async () => {
    const { service, prisma, queue } = makeDeps();
    prisma.refund.findMany.mockResolvedValue([{ id: 'a' }, { id: 'b' }]);
    await service.reconcile();
    expect(prisma.refund.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: { not: RefundStatus.COMPLETED } },
      }) as unknown,
    );
    expect(queue.add).toHaveBeenCalledTimes(2);
  });
});
