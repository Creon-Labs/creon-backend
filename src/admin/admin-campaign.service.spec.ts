import { ConflictException, NotFoundException } from '@nestjs/common';
import {
  CampaignDeployStatus,
  CampaignStatus,
  RefundStatus,
} from '../../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { RefundOrchestratorService } from '../refund/refund-orchestrator.service';
import { AdminCampaignService } from './admin-campaign.service';

function makeDeps() {
  const txClient = {
    campaign: { update: jest.fn().mockResolvedValue({}) },
    refund: {
      create: jest.fn().mockResolvedValue({
        id: 'ref-1',
        campaignId: 'camp-1',
        reason: 'rug pull',
        status: RefundStatus.PENDING,
        createdAt: new Date(),
      }),
    },
  };
  const prisma = {
    refund: { findUnique: jest.fn().mockResolvedValue(null) },
    campaign: { findUnique: jest.fn() },
    $transaction: jest.fn((cb: (tx: typeof txClient) => unknown) =>
      cb(txClient),
    ),
  };
  const refunds = { enqueue: jest.fn().mockResolvedValue(undefined) };
  const service = new AdminCampaignService(
    prisma as unknown as PrismaService,
    refunds as unknown as RefundOrchestratorService,
  );
  return { service, prisma, txClient, refunds };
}

const liveCampaign = {
  id: 'camp-1',
  status: CampaignStatus.ACTIVE,
  deployStatus: CampaignDeployStatus.LIVE,
  contractAddress: 'CCAMP',
};

describe('AdminCampaignService.cancel', () => {
  it('flips the campaign CANCELLED, opens a refund, and enqueues the orchestrator', async () => {
    const { service, prisma, txClient, refunds } = makeDeps();
    prisma.campaign.findUnique.mockResolvedValue(liveCampaign);

    const res = await service.cancel('camp-1', 'admin-1', 'rug pull');

    expect(txClient.campaign.update).toHaveBeenCalledWith({
      where: { id: 'camp-1' },
      data: { status: CampaignStatus.CANCELLED },
    });
    expect(txClient.refund.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          campaignId: 'camp-1',
          reason: 'rug pull',
          status: RefundStatus.PENDING,
        },
      }) as unknown,
    );
    expect(refunds.enqueue).toHaveBeenCalledWith('ref-1');
    expect(res).toEqual(expect.objectContaining({ id: 'ref-1' }));
  });

  it('is idempotent: returns the existing refund and re-enqueues without re-creating', async () => {
    const { service, prisma, refunds } = makeDeps();
    prisma.refund.findUnique.mockResolvedValue({
      id: 'ref-1',
      campaignId: 'camp-1',
      reason: 'rug pull',
      status: RefundStatus.PENDING,
      createdAt: new Date(),
    });

    const res = await service.cancel('camp-1', 'admin-1', 'again');

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.campaign.findUnique).not.toHaveBeenCalled();
    expect(refunds.enqueue).toHaveBeenCalledWith('ref-1');
    expect(res).toEqual(expect.objectContaining({ id: 'ref-1' }));
  });

  it('404s when the campaign does not exist', async () => {
    const { service, prisma } = makeDeps();
    prisma.campaign.findUnique.mockResolvedValue(null);
    await expect(service.cancel('x', 'admin-1', 'r')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('409s when the campaign is already cancelled', async () => {
    const { service, prisma, refunds } = makeDeps();
    prisma.campaign.findUnique.mockResolvedValue({
      ...liveCampaign,
      status: CampaignStatus.CANCELLED,
    });
    await expect(service.cancel('camp-1', 'admin-1', 'r')).rejects.toThrow(
      ConflictException,
    );
    expect(refunds.enqueue).not.toHaveBeenCalled();
  });

  it('409s when the campaign is not live on-chain', async () => {
    const { service, prisma } = makeDeps();
    prisma.campaign.findUnique.mockResolvedValue({
      ...liveCampaign,
      deployStatus: CampaignDeployStatus.PENDING,
      contractAddress: null,
    });
    await expect(service.cancel('camp-1', 'admin-1', 'r')).rejects.toThrow(
      ConflictException,
    );
  });
});
