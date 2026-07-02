import { NotFoundException } from '@nestjs/common';
import { Queue } from 'bullmq';
import { Prisma } from '../../generated/prisma/client';
import { MilestoneStatus } from '../../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { SorobanService } from '../soroban/soroban.service';
import { MilestoneReleaseService } from './milestone-release.service';

const D = (n: string | number) => new Prisma.Decimal(n);
const anyArray = expect.any(Array) as unknown;

function makeDeps() {
  const prisma = {
    milestone: {
      findUnique: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({}),
    },
    campaignVault: { update: jest.fn().mockResolvedValue({}) },
    $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  };
  const soroban = {
    u32Arg: jest.fn((x: number) => ({ u32: x })),
    invokeContract: jest.fn(),
  };
  const queue = {
    add: jest.fn().mockResolvedValue(undefined),
    remove: jest.fn().mockResolvedValue(undefined),
  };
  const service = new MilestoneReleaseService(
    prisma as unknown as PrismaService,
    soroban as unknown as SorobanService,
    queue as unknown as Queue,
  );
  return { service, prisma, soroban, queue };
}

function makeMilestone(overrides: Record<string, unknown> = {}) {
  return {
    id: 'm1',
    campaignId: 'c1',
    onchainIndex: 0,
    amount: D(600),
    status: MilestoneStatus.APPROVED,
    releaseTxHash: null,
    campaign: { contractAddress: 'CCAMP' },
    ...overrides,
  };
}

describe('MilestoneReleaseService.drive', () => {
  it('invokes release_milestone, persists the tx hash, marks RELEASED and bumps the vault', async () => {
    const { service, prisma, soroban } = makeDeps();
    prisma.milestone.findUnique.mockResolvedValue(makeMilestone());
    soroban.invokeContract.mockResolvedValue({ txHash: 'txrel' });

    await service.drive('m1');

    expect(soroban.u32Arg).toHaveBeenCalledWith(0);
    expect(soroban.invokeContract).toHaveBeenCalledWith(
      'CCAMP',
      'release_milestone',
      anyArray,
    );
    expect(prisma.milestone.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ releaseTxHash: 'txrel' }) as unknown,
      }),
    );
    expect(prisma.milestone.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: MilestoneStatus.RELEASED,
        }) as unknown,
      }),
    );
    expect(prisma.campaignVault.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { campaignId: 'c1' } }),
    );
  });

  it('resumes without re-invoking when the tx hash is already persisted', async () => {
    const { service, prisma, soroban } = makeDeps();
    prisma.milestone.findUnique.mockResolvedValue(
      makeMilestone({
        status: MilestoneStatus.RELEASING,
        releaseTxHash: 'txprev',
      }),
    );

    await service.drive('m1');

    expect(soroban.invokeContract).not.toHaveBeenCalled();
    expect(prisma.milestone.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: MilestoneStatus.RELEASED,
        }) as unknown,
      }),
    );
  });

  it('treats an already-released contract error (#10) as success and finalizes', async () => {
    const { service, prisma, soroban } = makeDeps();
    prisma.milestone.findUnique.mockResolvedValue(makeMilestone());
    soroban.invokeContract.mockRejectedValue(
      new Error('HostError: Error(Contract, #10)'),
    );

    await service.drive('m1'); // does not throw

    expect(prisma.milestone.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: MilestoneStatus.RELEASED,
        }) as unknown,
      }),
    );
  });

  it('no-ops when the milestone is already RELEASED', async () => {
    const { service, prisma, soroban } = makeDeps();
    prisma.milestone.findUnique.mockResolvedValue(
      makeMilestone({ status: MilestoneStatus.RELEASED }),
    );

    await service.drive('m1');

    expect(soroban.invokeContract).not.toHaveBeenCalled();
    expect(prisma.milestone.update).not.toHaveBeenCalled();
  });

  it('marks FAILED with the error and rethrows for BullMQ on a real failure', async () => {
    const { service, prisma, soroban } = makeDeps();
    prisma.milestone.findUnique.mockResolvedValue(makeMilestone());
    soroban.invokeContract.mockRejectedValue(new Error('rpc down'));

    await expect(service.drive('m1')).rejects.toThrow('rpc down');

    expect(prisma.milestone.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: MilestoneStatus.FAILED,
          releaseError: 'rpc down',
          releaseAttempts: { increment: 1 },
        }) as unknown,
      }),
    );
  });

  it('404s when the milestone is missing', async () => {
    const { service, prisma } = makeDeps();
    prisma.milestone.findUnique.mockResolvedValue(null);
    await expect(service.drive('m1')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('MilestoneReleaseService queueing', () => {
  it('enqueue clears any stale job then adds with jobId = milestoneId', async () => {
    const { service, queue } = makeDeps();
    await service.enqueue('m1');
    expect(queue.remove).toHaveBeenCalledWith('m1');
    expect(queue.add).toHaveBeenCalledWith(
      'release',
      { milestoneId: 'm1' },
      expect.objectContaining({ jobId: 'm1' }) as unknown,
    );
  });

  it('reconcile re-enqueues every APPROVED/RELEASING milestone', async () => {
    const { service, prisma, queue } = makeDeps();
    prisma.milestone.findMany.mockResolvedValue([{ id: 'a' }, { id: 'b' }]);

    await service.reconcile();

    expect(prisma.milestone.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: {
            in: expect.arrayContaining([
              MilestoneStatus.APPROVED,
              MilestoneStatus.RELEASING,
            ]) as unknown,
          },
        }) as unknown,
      }),
    );
    expect(queue.add).toHaveBeenCalledTimes(2);
  });
});
