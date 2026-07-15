import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import {
  CampaignDeployStatus,
  CampaignStatus,
  InvestmentStatus,
} from '../../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { SorobanService } from '../soroban/soroban.service';
import { InvestmentService } from './investment.service';

const WALLET = 'GINVESTOR';
const CONTRACT = 'CCAMPAIGN';

function makeDeps() {
  const prisma = {
    user: {
      findUnique: jest.fn().mockResolvedValue({ walletAddress: WALLET }),
    },
    campaign: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'camp-1',
        contractAddress: CONTRACT,
        status: CampaignStatus.ACTIVE,
        deployStatus: CampaignDeployStatus.LIVE,
        endAt: null,
        goalAmount: new Prisma.Decimal('1000'),
      }),
      update: jest.fn().mockReturnValue('UPDATE_OP'),
    },
    investment: {
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockReturnValue('CREATE_OP'),
    },
    $transaction: jest
      .fn()
      .mockResolvedValue([{ id: 'inv-1', txHash: 'innerhash' }, {}]),
  };
  const soroban = {
    addressArg: jest.fn((x: string) => ({ address: x })),
    i128Arg: jest.fn((x: bigint) => ({ i128: x })),
    buildInvokeTransaction: jest.fn().mockResolvedValue('UNSIGNED_XDR'),
    submitSignedTransaction: jest
      .fn()
      .mockResolvedValue({ txHash: 'innerhash', result: {} }),
    transactionHash: jest.fn(() => 'innerhash'),
    decodeInvokeContract: jest.fn(() => ({
      contractAddress: CONTRACT,
      functionName: 'invest',
      args: [{ address: WALLET }, { i128: 5_000_000_000n }],
    })),
    readAddress: jest.fn((v: { address: string }) => v.address),
    readI128: jest.fn((v: { i128: bigint }) => v.i128),
    simulateRead: jest.fn().mockResolvedValue({ i128: 5_000_000_000n }),
  };
  const fundingClose = { enqueue: jest.fn().mockResolvedValue(undefined) };
  const service = new InvestmentService(
    prisma as unknown as PrismaService,
    soroban as unknown as SorobanService,
    fundingClose as never,
  );
  return { service, prisma, soroban, fundingClose };
}

describe('InvestmentService.prepare', () => {
  it('builds an invest() tx sourced at the investor and returns the XDR', async () => {
    const { service, soroban } = makeDeps();

    const result = await service.prepare('u1', 'camp-1', { amount: '500' });

    expect(result).toEqual({ campaignId: 'camp-1', xdr: 'UNSIGNED_XDR' });
    expect(soroban.buildInvokeTransaction).toHaveBeenCalledWith(
      WALLET,
      CONTRACT,
      'invest',
      expect.any(Array),
    );
    expect(soroban.i128Arg).toHaveBeenCalledWith(5_000_000_000n); // 500 * 1e7
  });

  it('rejects a non-positive amount', async () => {
    const { service, soroban } = makeDeps();
    await expect(
      service.prepare('u1', 'camp-1', { amount: '0' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(soroban.buildInvokeTransaction).not.toHaveBeenCalled();
  });

  it('rejects a campaign that is not LIVE/ACTIVE', async () => {
    const { service, prisma } = makeDeps();
    prisma.campaign.findUnique.mockResolvedValue({
      id: 'camp-1',
      contractAddress: CONTRACT,
      status: CampaignStatus.PENDING_DEPLOYMENT,
      deployStatus: CampaignDeployStatus.PENDING,
    });
    await expect(
      service.prepare('u1', 'camp-1', { amount: '500' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('404s an unknown campaign', async () => {
    const { service, prisma } = makeDeps();
    prisma.campaign.findUnique.mockResolvedValue(null);
    await expect(
      service.prepare('u1', 'camp-1', { amount: '500' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('InvestmentService.submit', () => {
  const dto = { signedXdr: 'SIGNED_XDR' };

  it('verifies, submits, records CONFIRMED, and bumps raised/vault', async () => {
    const { service, prisma, soroban } = makeDeps();

    const result = await service.submit('u1', 'camp-1', dto);

    expect(soroban.submitSignedTransaction).toHaveBeenCalledWith('SIGNED_XDR');
    expect(prisma.investment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          campaignId: 'camp-1',
          investorId: 'u1',
          txHash: 'innerhash',
          status: InvestmentStatus.CONFIRMED,
        }) as unknown,
      }) as unknown,
    );
    expect(prisma.campaign.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'camp-1' },
        data: expect.objectContaining({
          raisedAmount: expect.anything() as unknown,
          vault: {
            update: {
              totalDeposited: { increment: expect.anything() as unknown },
            },
          },
        }) as unknown,
      }) as unknown,
    );
    expect(result).toEqual({ id: 'inv-1', txHash: 'innerhash' });
  });

  it('is idempotent: returns the existing investment without re-submitting', async () => {
    const { service, prisma, soroban } = makeDeps();
    prisma.investment.findUnique.mockResolvedValue({
      id: 'inv-1',
      txHash: 'innerhash',
    });

    const result = await service.submit('u1', 'camp-1', dto);

    expect(result).toEqual({ id: 'inv-1', txHash: 'innerhash' });
    expect(soroban.submitSignedTransaction).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects a tx that targets a different contract', async () => {
    const { service, soroban } = makeDeps();
    soroban.decodeInvokeContract.mockReturnValue({
      contractAddress: 'COTHER',
      functionName: 'invest',
      args: [{ address: WALLET }, { i128: 5_000_000_000n }],
    });
    await expect(service.submit('u1', 'camp-1', dto)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(soroban.submitSignedTransaction).not.toHaveBeenCalled();
  });

  it('rejects a tx that is not invest()', async () => {
    const { service, soroban } = makeDeps();
    soroban.decodeInvokeContract.mockReturnValue({
      contractAddress: CONTRACT,
      functionName: 'claim',
      args: [{ address: WALLET }, { i128: 5_000_000_000n }],
    });
    await expect(service.submit('u1', 'camp-1', dto)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(soroban.submitSignedTransaction).not.toHaveBeenCalled();
  });

  it('rejects a tx whose investor is not the caller', async () => {
    const { service, soroban } = makeDeps();
    soroban.decodeInvokeContract.mockReturnValue({
      contractAddress: CONTRACT,
      functionName: 'invest',
      args: [{ address: 'GSOMEONEELSE' }, { i128: 5_000_000_000n }],
    });
    await expect(service.submit('u1', 'camp-1', dto)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(soroban.submitSignedTransaction).not.toHaveBeenCalled();
  });

  it('propagates a submission failure (does not record)', async () => {
    const { service, prisma, soroban } = makeDeps();
    soroban.submitSignedTransaction.mockRejectedValue(new Error('tx failed'));
    await expect(service.submit('u1', 'camp-1', dto)).rejects.toThrow(
      'tx failed',
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('returns the existing row on a concurrent duplicate (P2002)', async () => {
    const { service, prisma } = makeDeps();
    const p2002 = new Prisma.PrismaClientKnownRequestError('dup', {
      code: 'P2002',
      clientVersion: 'test',
    });
    prisma.$transaction.mockRejectedValue(p2002);
    prisma.investment.findUnique
      .mockResolvedValueOnce(null) // pre-check miss
      .mockResolvedValueOnce({ id: 'inv-1', txHash: 'innerhash' }); // post-P2002

    const result = await service.submit('u1', 'camp-1', dto);
    expect(result).toEqual({ id: 'inv-1', txHash: 'innerhash' });
  });
});
