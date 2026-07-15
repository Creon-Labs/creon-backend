import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { ProposalStatus, ReviewDecision } from '../../generated/prisma/enums';
import { CampaignService } from '../campaign/campaign.service';
import { CampaignDeployService } from '../campaign/campaign-deploy.service';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { AdminProposalService } from './admin-proposal.service';

function makeDeps() {
  const txClient = {
    proposal: { update: jest.fn().mockResolvedValue({}) },
    proposalReview: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    proposal: {
      findUnique: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
    },
    $transaction: jest.fn((cb: (tx: typeof txClient) => unknown) =>
      cb(txClient),
    ),
  };
  const campaigns = {
    createForProposal: jest.fn().mockResolvedValue({ id: 'camp-1' }),
  };
  const deploy = { enqueue: jest.fn().mockResolvedValue(undefined) };
  const storage = {
    getPublicUrl: jest.fn((key: string) => `https://cdn.example/${key}`),
    getPresignedDownloadUrl: jest
      .fn()
      .mockResolvedValue('https://signed.example/file'),
  };
  const service = new AdminProposalService(
    prisma as unknown as PrismaService,
    campaigns as unknown as CampaignService,
    deploy as unknown as CampaignDeployService,
    storage as unknown as StorageService,
  );
  return { service, prisma, txClient, campaigns, deploy, storage };
}

const submitted = {
  id: 'prop-1',
  businessName: 'Warung Bu Sri',
  requestedAmount: new Prisma.Decimal('1000'),
  lockPeriodDays: 30,
  status: ProposalStatus.SUBMITTED,
};

describe('AdminProposalService.approve', () => {
  it('writes an APPROVED review, creates the campaign, and enqueues the deploy', async () => {
    const { service, prisma, txClient, campaigns, deploy } = makeDeps();
    prisma.proposal.findUnique.mockResolvedValue(submitted);

    const res = await service.approve('prop-1', 'admin-1');

    expect(txClient.proposal.update).toHaveBeenCalledWith({
      where: { id: 'prop-1' },
      data: { status: ProposalStatus.APPROVED },
    });
    expect(txClient.proposalReview.create).toHaveBeenCalledWith({
      data: {
        proposalId: 'prop-1',
        adminId: 'admin-1',
        decision: ReviewDecision.APPROVED,
      },
    });
    expect(campaigns.createForProposal).toHaveBeenCalledWith(
      txClient,
      expect.objectContaining({ id: 'prop-1' }),
    );
    expect(deploy.enqueue).toHaveBeenCalledWith('camp-1');
    expect(res).toEqual({
      proposalId: 'prop-1',
      status: ProposalStatus.APPROVED,
      campaignId: 'camp-1',
    });
  });

  it('also approves an UNDER_REVIEW proposal', async () => {
    const { service, prisma, deploy } = makeDeps();
    prisma.proposal.findUnique.mockResolvedValue({
      ...submitted,
      status: ProposalStatus.UNDER_REVIEW,
    });
    await service.approve('prop-1', 'admin-1');
    expect(deploy.enqueue).toHaveBeenCalled();
  });

  it('404s when the proposal does not exist', async () => {
    const { service, prisma } = makeDeps();
    prisma.proposal.findUnique.mockResolvedValue(null);
    await expect(service.approve('x', 'admin-1')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('409s when the proposal is already APPROVED', async () => {
    const { service, prisma, deploy } = makeDeps();
    prisma.proposal.findUnique.mockResolvedValue({
      ...submitted,
      status: ProposalStatus.APPROVED,
    });
    await expect(service.approve('prop-1', 'admin-1')).rejects.toThrow(
      ConflictException,
    );
    expect(deploy.enqueue).not.toHaveBeenCalled();
  });
});

describe('AdminProposalService.reject', () => {
  it('writes a REJECTED review with the reason and never deploys', async () => {
    const { service, prisma, txClient, deploy } = makeDeps();
    prisma.proposal.findUnique.mockResolvedValue(submitted);

    const res = await service.reject(
      'prop-1',
      'admin-1',
      'unrealistic numbers',
    );

    expect(txClient.proposal.update).toHaveBeenCalledWith({
      where: { id: 'prop-1' },
      data: { status: ProposalStatus.REJECTED },
    });
    expect(txClient.proposalReview.create).toHaveBeenCalledWith({
      data: {
        proposalId: 'prop-1',
        adminId: 'admin-1',
        decision: ReviewDecision.REJECTED,
        notes: 'unrealistic numbers',
      },
    });
    expect(deploy.enqueue).not.toHaveBeenCalled();
    expect(res).toEqual({
      proposalId: 'prop-1',
      status: ProposalStatus.REJECTED,
    });
  });
});

describe('AdminProposalService.list', () => {
  it('includes media URLs for admin review', async () => {
    const { service, prisma } = makeDeps();
    prisma.proposal.findMany.mockResolvedValue([
      {
        id: 'prop-1',
        businessName: 'Warung',
        category: 'Kuliner',
        location: null,
        requestedAmount: new Prisma.Decimal('1000'),
        lockPeriodDays: 30,
        status: ProposalStatus.SUBMITTED,
        submittedAt: new Date(),
        entrepreneur: { walletAddress: 'GABC', email: null },
        campaign: { id: 'camp-1' },
        media: [
          {
            id: 'm1',
            kind: 'IMAGE',
            mimeType: 'image/jpeg',
            originalName: 'a.jpg',
            sizeBytes: 10,
            sortOrder: 0,
            objectKey: 'proposals/prop-1/images/a.jpg',
            createdAt: new Date(),
          },
        ],
      },
    ]);

    const rows = await service.list(ProposalStatus.SUBMITTED);
    expect(rows[0].media[0]).toEqual(
      expect.objectContaining({
        id: 'm1',
        url: 'https://cdn.example/proposals/prop-1/images/a.jpg',
      }),
    );
    expect(rows[0].media[0]).not.toHaveProperty('objectKey');
    expect(rows[0]).toMatchObject({ campaignId: 'camp-1' });
    expect(prisma.proposal.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          campaign: { select: { id: true } },
        }),
      }),
    );
  });
});
