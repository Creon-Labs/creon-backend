import { NotFoundException } from '@nestjs/common';
import { Queue } from 'bullmq';
import {
  CampaignDeployStatus,
  CampaignStatus,
  UnlockStatus,
} from '../../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { SorobanService } from '../soroban/soroban.service';
import { CampaignUnlockService } from './campaign-unlock.service';

function makeDeps() {
  const prisma = {
    campaign: {
      findUnique: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({}),
    },
  };
  const soroban = {
    invokeContract: jest.fn(),
  };
  const queue = {
    add: jest.fn().mockResolvedValue(undefined),
    remove: jest.fn().mockResolvedValue(undefined),
  };
  const service = new CampaignUnlockService(
    prisma as unknown as PrismaService,
    soroban as unknown as SorobanService,
    queue as unknown as Queue,
  );
  return { service, prisma, soroban, queue };
}

function makeCampaign(overrides: Record<string, unknown> = {}) {
  return {
    id: 'c1',
    contractAddress: 'CCAMP',
    status: CampaignStatus.ACTIVE,
    unlockStatus: UnlockStatus.PENDING,
    lockEndAt: new Date(Date.now() - 60_000), // 1 minute in the past
    ...overrides,
  };
}

describe('CampaignUnlockService.drive', () => {
  it('invokes unlock, persists the tx hash and marks UNLOCKED for a due campaign', async () => {
    const { service, prisma, soroban } = makeDeps();
    prisma.campaign.findUnique.mockResolvedValue(makeCampaign());
    soroban.invokeContract.mockResolvedValue({ txHash: 'txunlock' });

    await service.drive('c1');

    expect(soroban.invokeContract).toHaveBeenCalledWith('CCAMP', 'unlock', []);
    expect(prisma.campaign.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          unlockStatus: UnlockStatus.UNLOCKED,
          unlockTxHash: 'txunlock',
          unlockError: null,
        }) as unknown,
      }),
    );
  });

  it('skips a campaign whose lock has not yet expired', async () => {
    const { service, prisma, soroban } = makeDeps();
    prisma.campaign.findUnique.mockResolvedValue(
      makeCampaign({ lockEndAt: new Date(Date.now() + 60_000) }),
    );

    await service.drive('c1');

    expect(soroban.invokeContract).not.toHaveBeenCalled();
    expect(prisma.campaign.update).not.toHaveBeenCalled();
  });

  it('skips a cancelled campaign even if due', async () => {
    const { service, prisma, soroban } = makeDeps();
    prisma.campaign.findUnique.mockResolvedValue(
      makeCampaign({ status: CampaignStatus.CANCELLED }),
    );

    await service.drive('c1');

    expect(soroban.invokeContract).not.toHaveBeenCalled();
    expect(prisma.campaign.update).not.toHaveBeenCalled();
  });

  it('no-ops when the campaign is already UNLOCKED', async () => {
    const { service, prisma, soroban } = makeDeps();
    prisma.campaign.findUnique.mockResolvedValue(
      makeCampaign({ unlockStatus: UnlockStatus.UNLOCKED }),
    );

    await service.drive('c1');

    expect(soroban.invokeContract).not.toHaveBeenCalled();
    expect(prisma.campaign.update).not.toHaveBeenCalled();
  });

  it('marks FAILED with the error and rethrows for BullMQ on a real failure', async () => {
    const { service, prisma, soroban } = makeDeps();
    prisma.campaign.findUnique.mockResolvedValue(makeCampaign());
    soroban.invokeContract.mockRejectedValue(new Error('rpc down'));

    await expect(service.drive('c1')).rejects.toThrow('rpc down');

    expect(prisma.campaign.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          unlockStatus: UnlockStatus.FAILED,
          unlockError: 'rpc down',
          unlockAttempts: { increment: 1 },
        }) as unknown,
      }),
    );
  });

  it('404s when the campaign is missing', async () => {
    const { service, prisma } = makeDeps();
    prisma.campaign.findUnique.mockResolvedValue(null);
    await expect(service.drive('c1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('404s when the campaign has no contract address yet', async () => {
    const { service, prisma } = makeDeps();
    prisma.campaign.findUnique.mockResolvedValue(
      makeCampaign({ contractAddress: null }),
    );
    await expect(service.drive('c1')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('CampaignUnlockService queueing', () => {
  it('enqueue clears any stale job then adds with jobId = campaignId', async () => {
    const { service, queue } = makeDeps();
    await service.enqueue('c1');
    expect(queue.remove).toHaveBeenCalledWith('c1');
    expect(queue.add).toHaveBeenCalledWith(
      'unlock',
      { campaignId: 'c1' },
      expect.objectContaining({ jobId: 'c1' }) as unknown,
    );
  });

  it('reconcile queries due, live, non-cancelled, not-yet-unlocked campaigns and enqueues them', async () => {
    const { service, prisma, queue } = makeDeps();
    prisma.campaign.findMany.mockResolvedValue([{ id: 'a' }, { id: 'b' }]);

    await service.reconcile();

    expect(prisma.campaign.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          unlockStatus: { not: UnlockStatus.UNLOCKED },
          lockEndAt: { lte: expect.any(Date) as unknown },
          deployStatus: CampaignDeployStatus.LIVE,
          status: { not: CampaignStatus.CANCELLED },
        }) as unknown,
      }),
    );
    expect(queue.add).toHaveBeenCalledTimes(2);
  });

  it('bootstrap applies the same date filter as the periodic tick (no due rows → no enqueue)', async () => {
    const { service, prisma, queue } = makeDeps();
    prisma.campaign.findMany.mockResolvedValue([]);

    await service.onApplicationBootstrap();

    expect(prisma.campaign.findMany).toHaveBeenCalledTimes(1);
    expect(queue.add).not.toHaveBeenCalled();
  });
});
