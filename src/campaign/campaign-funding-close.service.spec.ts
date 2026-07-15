import { Queue } from 'bullmq';
import { Prisma } from '../../generated/prisma/client';
import { CampaignStatus } from '../../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { RefundOrchestratorService } from '../refund/refund-orchestrator.service';
import { SorobanService } from '../soroban/soroban.service';
import { CampaignFundingCloseService } from './campaign-funding-close.service';

function deps() {
  const tx = {
    campaign: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    refund: { upsert: jest.fn().mockResolvedValue({ id: 'refund-1' }) },
  };
  const prisma = {
    campaign: {
      findUnique: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    $transaction: jest.fn((callback: (client: typeof tx) => unknown) =>
      callback(tx),
    ),
  };
  const soroban = {
    simulateRead: jest.fn().mockResolvedValue({ i128: 10_000_000_000n }),
    readI128: jest.fn((value: { i128: bigint }) => value.i128),
  };
  const refunds = { enqueue: jest.fn().mockResolvedValue(undefined) };
  const queue = {
    remove: jest.fn().mockResolvedValue(undefined),
    add: jest.fn().mockResolvedValue(undefined),
  };
  return {
    service: new CampaignFundingCloseService(
      prisma as unknown as PrismaService,
      soroban as unknown as SorobanService,
      refunds as unknown as RefundOrchestratorService,
      queue as unknown as Queue,
    ),
    prisma,
    soroban,
    refunds,
    tx,
  };
}

const active = (overrides: Record<string, unknown> = {}) => ({
  id: 'camp-1',
  contractAddress: 'CCAMP',
  status: CampaignStatus.ACTIVE,
  endAt: new Date(Date.now() - 1),
  goalAmount: new Prisma.Decimal('1000'),
  ...overrides,
});

describe('CampaignFundingCloseService', () => {
  it('marks a campaign GOAL_REACHED from its on-chain raised amount without refunding', async () => {
    const { service, prisma, refunds } = deps();
    prisma.campaign.findUnique.mockResolvedValue(active());
    await service.drive('camp-1');
    expect(prisma.campaign.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: CampaignStatus.GOAL_REACHED },
      }) as unknown,
    );
    expect(refunds.enqueue).not.toHaveBeenCalled();
  });

  it('cancels an expired underfunded campaign, creates one refund, and enqueues it', async () => {
    const { service, prisma, soroban, refunds, tx } = deps();
    prisma.campaign.findUnique.mockResolvedValue(active());
    soroban.readI128.mockReturnValue(1_000_000_000n);
    await service.drive('camp-1');
    expect(tx.refund.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        // Jest's asymmetric matcher is typed as `any`.
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        create: expect.objectContaining({
          reason: 'Funding goal was not reached before the deadline',
        }),
      }) as unknown,
    );
    expect(refunds.enqueue).toHaveBeenCalledWith('refund-1');
  });

  it('ignores legacy campaigns with no funding deadline', async () => {
    const { service, prisma, soroban } = deps();
    prisma.campaign.findUnique.mockResolvedValue(active({ endAt: null }));
    await service.drive('camp-1');
    expect(soroban.simulateRead).not.toHaveBeenCalled();
  });
});
