import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { ProposalStatus, ReviewDecision } from '../../generated/prisma/enums';
import { CampaignService } from '../campaign/campaign.service';
import { CampaignDeployService } from '../campaign/campaign-deploy.service';
import { PrismaService } from '../prisma/prisma.service';
import { AdminProposalService } from './admin-proposal.service';

function makeDeps() {
  const txClient = {
    proposal: { update: jest.fn().mockResolvedValue({}) },
    proposalReview: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    proposal: { findUnique: jest.fn() },
    $transaction: jest.fn((cb: (tx: typeof txClient) => unknown) =>
      cb(txClient),
    ),
  };
  const campaigns = {
    createForProposal: jest.fn().mockResolvedValue({ id: 'camp-1' }),
  };
  const deploy = { enqueue: jest.fn().mockResolvedValue(undefined) };
  const service = new AdminProposalService(
    prisma as unknown as PrismaService,
    campaigns as unknown as CampaignService,
    deploy as unknown as CampaignDeployService,
  );
  return { service, prisma, txClient, campaigns, deploy };
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
