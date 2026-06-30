import { Prisma } from '../../generated/prisma/client';
import {
  CampaignDeployStatus,
  CampaignStatus,
  VaultStatus,
} from '../../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { CampaignService } from './campaign.service';

describe('CampaignService', () => {
  const create = jest.fn().mockResolvedValue({ id: 'camp-1' });
  const tx = { campaign: { create } } as unknown as Prisma.TransactionClient;
  const service = new CampaignService({} as PrismaService);

  beforeEach(() => create.mockClear());

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
});
