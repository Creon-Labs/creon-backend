import { NotFoundException } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import {
  CampaignDeployStatus,
  CampaignStatus,
  MilestoneStatus,
  VaultStatus,
} from '../../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { CampaignService } from './campaign.service';

describe('CampaignService', () => {
  const create = jest.fn().mockResolvedValue({ id: 'camp-1' });
  const updateMany = jest.fn().mockResolvedValue({ count: 2 });
  const tx = {
    campaign: { create },
    milestone: { updateMany },
  } as unknown as Prisma.TransactionClient;
  const service = new CampaignService({} as PrismaService);

  beforeEach(() => {
    create.mockClear();
    updateMany.mockClear();
  });

  const proposal = {
    id: 'prop-1',
    businessName: 'Warung Bu Sri',
    requestedAmount: new Prisma.Decimal('1000'),
    lockPeriodDays: 30,
  };

  it('creates the campaign + token + vault rows in PENDING_DEPLOYMENT', async () => {
    const result = await service.createForProposal(tx, proposal);
    expect(result).toEqual({ id: 'camp-1' });

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        proposalId: 'prop-1',
        goalAmount: proposal.requestedAmount,
        status: CampaignStatus.PENDING_DEPLOYMENT,
        deployStatus: CampaignDeployStatus.PENDING,
        lockEndAt: expect.any(Date) as unknown,
        projectToken: {
          create: expect.objectContaining({
            isTransferable: false,
            assetCode: expect.stringMatching(/^WARUNGBU/) as unknown,
          }) as unknown,
        },
        vault: {
          create: expect.objectContaining({
            status: VaultStatus.PENDING,
          }) as unknown,
        },
      }) as unknown,
      select: { id: true },
    });
  });

  it('sets lockEndAt lockPeriodDays into the future', async () => {
    const before = Date.now();
    await service.createForProposal(tx, proposal);
    const [arg] = create.mock.calls[0] as [{ data: { lockEndAt: Date } }];
    const expected = before + 30 * 86_400 * 1000;
    expect(arg.data.lockEndAt.getTime()).toBeGreaterThanOrEqual(
      expected - 5000,
    );
  });

  it('links the proposal milestones to the new campaign (PENDING)', async () => {
    await service.createForProposal(tx, proposal);
    expect(updateMany).toHaveBeenCalledWith({
      where: { proposalId: 'prop-1' },
      data: { campaignId: 'camp-1', status: MilestoneStatus.PENDING },
    });
  });
});

describe('CampaignService public reads', () => {
  function makeService() {
    const prisma = {
      campaign: {
        findMany: jest.fn().mockResolvedValue([{ id: 'camp-1' }]),
        findUnique: jest.fn(),
      },
    };
    const service = new CampaignService(prisma as unknown as PrismaService);
    return { service, prisma };
  }

  it('listActive returns only LIVE-deployed campaigns', async () => {
    const { service, prisma } = makeService();
    const result = await service.listActive();
    expect(result).toEqual([{ id: 'camp-1' }]);
    expect(prisma.campaign.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { deployStatus: CampaignDeployStatus.LIVE },
      }) as unknown,
    );
  });

  it('getPublic returns the campaign when found', async () => {
    const { service, prisma } = makeService();
    prisma.campaign.findUnique.mockResolvedValue({ id: 'camp-1' });
    await expect(service.getPublic('camp-1')).resolves.toEqual({
      id: 'camp-1',
    });
  });

  it('getPublic 404s an unknown campaign', async () => {
    const { service, prisma } = makeService();
    prisma.campaign.findUnique.mockResolvedValue(null);
    await expect(service.getPublic('nope')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
