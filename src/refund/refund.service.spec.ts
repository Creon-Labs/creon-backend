import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { RefundClaimStatus, RefundStatus } from '../../generated/prisma/enums';
import { toStroops } from '../campaign/campaign.util';
import { PrismaService } from '../prisma/prisma.service';
import { SorobanService } from '../soroban/soroban.service';
import { RefundService } from './refund.service';

const ALICE = 'GCHPJMNH7WWIHX7CY5CKWR3I35A5DK4X6IU7CJSFUDHTBEWWMI6VEHFJ';

function makeDeps() {
  const prisma = {
    campaign: { findUnique: jest.fn() },
    refund: { findUnique: jest.fn(), update: jest.fn().mockResolvedValue({}) },
    refundClaim: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    user: { findUnique: jest.fn().mockResolvedValue({ walletAddress: ALICE }) },
    $transaction: jest
      .fn()
      .mockResolvedValue([{ id: 'rc-1', status: RefundClaimStatus.CLAIMED }]),
  };
  const soroban = {
    buildInvokeTransaction: jest.fn().mockResolvedValue('XDR'),
    transactionHash: jest.fn().mockReturnValue('txhash'),
    decodeInvokeContract: jest.fn(),
    submitSignedTransaction: jest
      .fn()
      .mockResolvedValue({ txHash: 'txhash', result: {} }),
    u32Arg: jest.fn((x: number) => ({ u32: x })),
    addressArg: jest.fn((a: string) => ({ addr: a })),
    i128Arg: jest.fn((v: bigint) => ({ i128: v })),
    bytesVecArg: jest.fn((b: Buffer[]) => ({ vec: b })),
    readU32: jest.fn().mockReturnValue(0),
    readAddress: jest.fn().mockReturnValue(ALICE),
    readI128: jest.fn().mockReturnValue(toStroops('600')),
  };
  const service = new RefundService(
    prisma as unknown as PrismaService,
    soroban as unknown as SorobanService,
  );
  return { service, prisma, soroban };
}

const claimable = {
  id: 'rc-1',
  amount: new Prisma.Decimal('600'),
  leafIndex: 0,
  merkleProof: ['ab', 'cd'],
  status: RefundClaimStatus.PENDING,
  refund: {
    status: RefundStatus.COMPLETED,
    campaign: { contractAddress: 'CCAMP' },
  },
};

describe('RefundService.claimPrepare', () => {
  it('builds a refund_claim() tx with the leaf index, wallet, amount, and proof', async () => {
    const { service, prisma, soroban } = makeDeps();
    prisma.refundClaim.findUnique.mockResolvedValue(claimable);

    const res = await service.claimPrepare('u-alice', 'ref-1');

    expect(soroban.u32Arg).toHaveBeenCalledWith(0);
    expect(soroban.buildInvokeTransaction).toHaveBeenCalledWith(
      ALICE,
      'CCAMP',
      'refund_claim',
      expect.any(Array),
    );
    expect(res).toEqual({ refundId: 'ref-1', xdr: 'XDR' });
  });

  it('409s when the refund is not COMPLETED yet', async () => {
    const { service, prisma } = makeDeps();
    prisma.refundClaim.findUnique.mockResolvedValue({
      ...claimable,
      refund: { ...claimable.refund, status: RefundStatus.PENDING },
    });
    await expect(service.claimPrepare('u-alice', 'ref-1')).rejects.toThrow(
      ConflictException,
    );
  });

  it('404s when the caller has no entitlement', async () => {
    const { service, prisma } = makeDeps();
    prisma.refundClaim.findUnique.mockResolvedValue(null);
    await expect(service.claimPrepare('u-alice', 'ref-1')).rejects.toThrow(
      NotFoundException,
    );
  });
});

describe('RefundService.claimSubmit', () => {
  it('verifies, submits, marks CLAIMED, and bumps totalClaimed', async () => {
    const { service, prisma, soroban } = makeDeps();
    prisma.refundClaim.findUnique
      .mockResolvedValueOnce(null) // idempotency probe (by claimTxHash)
      .mockResolvedValueOnce(claimable); // loadClaimable (composite key)
    soroban.decodeInvokeContract.mockReturnValue({
      contractAddress: 'CCAMP',
      functionName: 'refund_claim',
      args: ['IDX', 'CLAIMANT', 'AMOUNT'],
    });

    await service.claimSubmit('u-alice', 'ref-1', { signedXdr: 'SX' });

    expect(soroban.submitSignedTransaction).toHaveBeenCalledWith('SX');
    expect(prisma.$transaction).toHaveBeenCalled();
  });

  it('is idempotent: returns the existing claim recorded under the same tx hash', async () => {
    const { service, prisma, soroban } = makeDeps();
    prisma.refundClaim.findUnique.mockResolvedValueOnce({
      id: 'rc-1',
      status: RefundClaimStatus.CLAIMED,
    });

    const res = await service.claimSubmit('u-alice', 'ref-1', {
      signedXdr: 'SX',
    });

    expect(soroban.submitSignedTransaction).not.toHaveBeenCalled();
    expect(res).toEqual(
      expect.objectContaining({ status: RefundClaimStatus.CLAIMED }),
    );
  });

  it('rejects a tx that is not a refund_claim() call', async () => {
    const { service, prisma, soroban } = makeDeps();
    prisma.refundClaim.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(claimable);
    soroban.decodeInvokeContract.mockReturnValue({
      contractAddress: 'CCAMP',
      functionName: 'claim',
      args: [],
    });

    await expect(
      service.claimSubmit('u-alice', 'ref-1', { signedXdr: 'SX' }),
    ).rejects.toThrow(BadRequestException);
    expect(soroban.submitSignedTransaction).not.toHaveBeenCalled();
  });
});

describe('RefundService.getForCampaign', () => {
  it('404s when the campaign does not exist', async () => {
    const { service, prisma } = makeDeps();
    prisma.campaign.findUnique.mockResolvedValue(null);
    await expect(service.getForCampaign('camp-x')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('returns the campaign refund when present', async () => {
    const { service, prisma } = makeDeps();
    prisma.campaign.findUnique.mockResolvedValue({ id: 'camp-1' });
    prisma.refund.findUnique.mockResolvedValue({ id: 'ref-1' });
    await expect(service.getForCampaign('camp-1')).resolves.toEqual({
      id: 'ref-1',
    });
  });
});
