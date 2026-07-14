import { NotFoundException } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import {
  CampaignDeployStatus,
  CampaignStatus,
  MilestoneStatus,
  VaultStatus,
} from '../../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { CampaignService } from './campaign.service';

function makeStorage() {
  return {
    getPublicUrl: jest.fn((key: string) => `https://cdn.example/${key}`),
    getPresignedDownloadUrl: jest
      .fn()
      .mockResolvedValue('https://signed.example/file'),
  } as unknown as StorageService;
}

describe('CampaignService', () => {
  const create = jest.fn().mockResolvedValue({ id: 'camp-1' });
  const milestoneUpdateMany = jest.fn().mockResolvedValue({ count: 2 });
  const mediaUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
  const tx = {
    campaign: { create },
    milestone: { updateMany: milestoneUpdateMany },
    proposalMedia: { updateMany: mediaUpdateMany },
  } as unknown as Prisma.TransactionClient;
  const service = new CampaignService(
    {} as PrismaService,
    makeStorage(),
  );

  beforeEach(() => {
    create.mockClear();
    milestoneUpdateMany.mockClear();
    mediaUpdateMany.mockClear();
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
    expect(milestoneUpdateMany).toHaveBeenCalledWith({
      where: { proposalId: 'prop-1' },
      data: { campaignId: 'camp-1', status: MilestoneStatus.PENDING },
    });
  });

  it('links proposal media to the new campaign (no object copy)', async () => {
    await service.createForProposal(tx, proposal);
    expect(mediaUpdateMany).toHaveBeenCalledWith({
      where: { proposalId: 'prop-1' },
      data: { campaignId: 'camp-1' },
    });
  });
});

describe('CampaignService public reads', () => {
  function makeService() {
    const prisma = {
      campaign: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'camp-1',
            media: [
              {
                id: 'm1',
                kind: 'IMAGE',
                mimeType: 'image/jpeg',
                originalName: 'a.jpg',
                sizeBytes: 10,
                sortOrder: 0,
                objectKey: 'proposals/p1/images/a.jpg',
                createdAt: new Date(),
              },
            ],
          },
        ]),
        findUnique: jest.fn(),
      },
    };
    const storage = makeStorage();
    const service = new CampaignService(
      prisma as unknown as PrismaService,
      storage,
    );
    return { service, prisma, storage };
  }

  it('listActive returns only LIVE-deployed campaigns with media URLs', async () => {
    const { service, prisma } = makeService();
    const result = await service.listActive();
    expect(result).toEqual([
      {
        id: 'camp-1',
        media: [
          expect.objectContaining({
            id: 'm1',
            url: 'https://cdn.example/proposals/p1/images/a.jpg',
          }),
        ],
      },
    ]);
    expect(result[0].media[0]).not.toHaveProperty('objectKey');
    expect(prisma.campaign.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { deployStatus: CampaignDeployStatus.LIVE },
      }) as unknown,
    );
  });

  it('getPublic returns the campaign when found', async () => {
    const { service, prisma } = makeService();
    prisma.campaign.findUnique.mockResolvedValue({
      id: 'camp-1',
      media: [],
    });
    await expect(service.getPublic('camp-1')).resolves.toEqual({
      id: 'camp-1',
      media: [],
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
