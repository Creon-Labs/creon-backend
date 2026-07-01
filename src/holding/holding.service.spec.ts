import { NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { HoldingService } from './holding.service';

const ADDRESS = 'GCUQRLMIYPTNGYQBEN6P6HMTDAETLKYEQORMQWV7SKNTX7XDDNN3OCBY';

function makeDeps() {
  const prisma = {
    campaign: { findUnique: jest.fn().mockResolvedValue({ id: 'camp-1' }) },
    tokenHolding: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const service = new HoldingService(prisma as unknown as PrismaService);
  return { service, prisma };
}

describe('HoldingService', () => {
  describe('listMine', () => {
    it('queries own positive holdings, largest first', async () => {
      const { service, prisma } = makeDeps();
      prisma.tokenHolding.findMany.mockResolvedValue([
        { campaignId: 'camp-1' },
      ]);

      await service.listMine('user-1');

      const arg = (
        prisma.tokenHolding.findMany.mock.calls as unknown[][]
      )[0][0];
      expect(arg).toMatchObject({
        where: { holderId: 'user-1', balance: { gt: 0 } },
        orderBy: { balance: 'desc' },
      });
    });
  });

  describe('listForCampaign', () => {
    it('throws NotFound when the campaign does not exist', async () => {
      const { service, prisma } = makeDeps();
      prisma.campaign.findUnique.mockResolvedValue(null);

      await expect(service.listForCampaign('missing')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.tokenHolding.findMany).not.toHaveBeenCalled();
    });

    it('masks the wallet address and a registered holder name', async () => {
      const { service, prisma } = makeDeps();
      const balance = { toString: () => '50' };
      prisma.tokenHolding.findMany.mockResolvedValue([
        {
          holderAddress: ADDRESS,
          balance,
          updatedLedger: 900n,
          holder: { displayName: 'Budi Santoso' },
        },
      ]);

      const rows = await service.listForCampaign('camp-1');

      expect(rows).toEqual([
        {
          holder: 'B*** S***',
          address: 'GCUQ…OCBY',
          balance,
          updatedLedger: 900n,
        },
      ]);
    });

    it('returns a null holder for an unregistered address', async () => {
      const { service, prisma } = makeDeps();
      prisma.tokenHolding.findMany.mockResolvedValue([
        {
          holderAddress: ADDRESS,
          balance: { toString: () => '10' },
          updatedLedger: 900n,
          holder: null,
        },
      ]);

      const rows = await service.listForCampaign('camp-1');

      expect(rows[0].holder).toBeNull();
      expect(rows[0].address).toBe('GCUQ…OCBY');
    });

    it('filters to current holders (positive balance)', async () => {
      const { service, prisma } = makeDeps();

      await service.listForCampaign('camp-1');

      const arg = (
        prisma.tokenHolding.findMany.mock.calls as unknown[][]
      )[0][0];
      expect(arg).toMatchObject({
        where: { campaignId: 'camp-1', balance: { gt: 0 } },
        orderBy: { balance: 'desc' },
      });
    });
  });
});
