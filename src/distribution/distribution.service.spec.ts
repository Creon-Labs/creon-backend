import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import {
  CampaignDeployStatus,
  ClaimStatus,
  DistributionStatus,
} from '../../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { SorobanService } from '../soroban/soroban.service';
import { DistributionOrchestratorService } from './distribution-orchestrator.service';
import { DistributionService } from './distribution.service';

const WALLET = 'GCALLER';
const CONTRACT = 'CCAMP';
const PROOF = ['ab'.repeat(32), 'cd'.repeat(32)];

/** The caller's entitlement, as loadClaimable selects it. */
function makeClaim(overrides: Record<string, unknown> = {}) {
  return {
    id: 'claim-1',
    amount: new Prisma.Decimal('600'),
    leafIndex: 0,
    merkleProof: PROOF,
    status: ClaimStatus.PENDING,
    distribution: {
      onchainId: 0,
      status: DistributionStatus.COMPLETED,
      campaign: { contractAddress: CONTRACT },
    },
    ...overrides,
  };
}

function makeDeps() {
  const prisma = {
    user: {
      findUnique: jest.fn().mockResolvedValue({ walletAddress: WALLET }),
    },
    campaign: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'camp-1',
        contractAddress: CONTRACT,
        deployStatus: CampaignDeployStatus.LIVE,
        proposal: { entrepreneurId: 'u1' },
      }),
    },
    profitDistribution: {
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockResolvedValue({ id: 'dist-1' }),
      update: jest.fn().mockReturnValue('UPD_DIST'),
    },
    distributionClaim: {
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockReturnValue('UPD_CLAIM'),
    },
    $transaction: jest
      .fn()
      .mockResolvedValue([{ id: 'claim-1', status: ClaimStatus.CLAIMED }, {}]),
  };
  const soroban = {
    addressArg: jest.fn((x: string) => ({ address: x })),
    i128Arg: jest.fn((x: bigint) => ({ i128: x })),
    u32Arg: jest.fn((x: number) => ({ u32: x })),
    bytesVecArg: jest.fn((b: Buffer[]) => ({ vec: b })),
    buildInvokeTransaction: jest.fn().mockResolvedValue('UNSIGNED_XDR'),
    submitSignedTransaction: jest
      .fn()
      .mockResolvedValue({ txHash: 'innerhash', result: { ledger: 123 } }),
    transactionHash: jest.fn(() => 'innerhash'),
    decodeInvokeContract: jest.fn(),
    readAddress: jest.fn((v: { address: string }) => v.address),
    readI128: jest.fn((v: { i128: bigint }) => v.i128),
    readU32: jest.fn((v: { u32: number }) => v.u32),
  };
  const orchestrator = {
    enqueue: jest.fn().mockResolvedValue(undefined),
  };
  const service = new DistributionService(
    prisma as unknown as PrismaService,
    soroban as unknown as SorobanService,
    orchestrator as unknown as DistributionOrchestratorService,
  );
  return { service, prisma, soroban, orchestrator };
}

describe('DistributionService.depositPrepare', () => {
  it('builds a deposit_profit() tx sourced at the business and returns the XDR', async () => {
    const { service, soroban } = makeDeps();

    const result = await service.depositPrepare('u1', 'camp-1', {
      amount: '1000',
    });

    expect(result).toEqual({ campaignId: 'camp-1', xdr: 'UNSIGNED_XDR' });
    expect(soroban.buildInvokeTransaction).toHaveBeenCalledWith(
      WALLET,
      CONTRACT,
      'deposit_profit',
      expect.any(Array),
    );
    expect(soroban.i128Arg).toHaveBeenCalledWith(10_000_000_000n); // 1000 * 1e7
  });

  it('rejects a non-positive amount', async () => {
    const { service } = makeDeps();
    await expect(
      service.depositPrepare('u1', 'camp-1', { amount: '0' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('forbids a caller who does not own the campaign', async () => {
    const { service, prisma } = makeDeps();
    prisma.campaign.findUnique.mockResolvedValue({
      id: 'camp-1',
      contractAddress: CONTRACT,
      deployStatus: CampaignDeployStatus.LIVE,
      proposal: { entrepreneurId: 'someone-else' },
    });
    await expect(
      service.depositPrepare('u1', 'camp-1', { amount: '1000' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects a campaign that is not live', async () => {
    const { service, prisma } = makeDeps();
    prisma.campaign.findUnique.mockResolvedValue({
      id: 'camp-1',
      contractAddress: null,
      deployStatus: CampaignDeployStatus.PENDING,
      proposal: { entrepreneurId: 'u1' },
    });
    await expect(
      service.depositPrepare('u1', 'camp-1', { amount: '1000' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('DistributionService.depositSubmit', () => {
  const dto = { signedXdr: 'SIGNED_XDR' };

  function withDeposit(soroban: ReturnType<typeof makeDeps>['soroban']) {
    soroban.decodeInvokeContract.mockReturnValue({
      contractAddress: CONTRACT,
      functionName: 'deposit_profit',
      args: [{ address: WALLET }, { i128: 10_000_000_000n }],
    });
  }

  it('verifies, submits, opens a PENDING distribution, and enqueues it', async () => {
    const { service, prisma, soroban, orchestrator } = makeDeps();
    withDeposit(soroban);

    const result = await service.depositSubmit('u1', 'camp-1', dto);

    expect(soroban.submitSignedTransaction).toHaveBeenCalledWith('SIGNED_XDR');
    expect(prisma.profitDistribution.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          campaignId: 'camp-1',
          onchainId: 0,
          depositTxHash: 'innerhash',
          snapshotLedger: 123n,
          status: DistributionStatus.PENDING,
        }) as unknown,
      }) as unknown,
    );
    expect(orchestrator.enqueue).toHaveBeenCalledWith('dist-1');
    expect(result).toEqual({ id: 'dist-1' });
  });

  it('is idempotent: returns the existing distribution without re-submitting', async () => {
    const { service, prisma, soroban } = makeDeps();
    prisma.profitDistribution.findUnique.mockResolvedValue({ id: 'dist-1' });

    const result = await service.depositSubmit('u1', 'camp-1', dto);

    expect(result).toEqual({ id: 'dist-1' });
    expect(soroban.submitSignedTransaction).not.toHaveBeenCalled();
    expect(prisma.profitDistribution.create).not.toHaveBeenCalled();
  });

  it('rejects a tx that is not deposit_profit()', async () => {
    const { service, soroban } = makeDeps();
    soroban.decodeInvokeContract.mockReturnValue({
      contractAddress: CONTRACT,
      functionName: 'invest',
      args: [{ address: WALLET }, { i128: 10_000_000_000n }],
    });
    await expect(
      service.depositSubmit('u1', 'camp-1', dto),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(soroban.submitSignedTransaction).not.toHaveBeenCalled();
  });

  it('rejects a tx whose depositor is not the caller', async () => {
    const { service, soroban } = makeDeps();
    soroban.decodeInvokeContract.mockReturnValue({
      contractAddress: CONTRACT,
      functionName: 'deposit_profit',
      args: [{ address: 'GSOMEONEELSE' }, { i128: 10_000_000_000n }],
    });
    await expect(
      service.depositSubmit('u1', 'camp-1', dto),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(soroban.submitSignedTransaction).not.toHaveBeenCalled();
  });
});

describe('DistributionService.claimPrepare', () => {
  it('builds a claim() tx with the stored id/index/amount/proof', async () => {
    const { service, prisma, soroban } = makeDeps();
    prisma.distributionClaim.findUnique.mockResolvedValue(makeClaim());

    const result = await service.claimPrepare('u2', 'dist-1');

    expect(result).toEqual({ distributionId: 'dist-1', xdr: 'UNSIGNED_XDR' });
    expect(soroban.buildInvokeTransaction).toHaveBeenCalledWith(
      WALLET,
      CONTRACT,
      'claim',
      expect.any(Array),
    );
    expect(soroban.u32Arg).toHaveBeenCalledWith(0); // onchainId + leafIndex
    expect(soroban.i128Arg).toHaveBeenCalledWith(6_000_000_000n); // 600 * 1e7
    expect(soroban.bytesVecArg).toHaveBeenCalledWith([
      Buffer.from(PROOF[0], 'hex'),
      Buffer.from(PROOF[1], 'hex'),
    ]);
  });

  it('404s when the caller has no entitlement', async () => {
    const { service, prisma } = makeDeps();
    prisma.distributionClaim.findUnique.mockResolvedValue(null);
    await expect(service.claimPrepare('u2', 'dist-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('409s while the distribution is not yet COMPLETED', async () => {
    const { service, prisma } = makeDeps();
    prisma.distributionClaim.findUnique.mockResolvedValue(
      makeClaim({
        distribution: {
          onchainId: 0,
          status: DistributionStatus.PENDING,
          campaign: { contractAddress: CONTRACT },
        },
      }),
    );
    await expect(service.claimPrepare('u2', 'dist-1')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('409s when the entitlement is already claimed', async () => {
    const { service, prisma } = makeDeps();
    prisma.distributionClaim.findUnique.mockResolvedValue(
      makeClaim({ status: ClaimStatus.CLAIMED }),
    );
    await expect(service.claimPrepare('u2', 'dist-1')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});

describe('DistributionService.claimSubmit', () => {
  const dto = { signedXdr: 'SIGNED_XDR' };

  function withClaim(soroban: ReturnType<typeof makeDeps>['soroban']) {
    soroban.decodeInvokeContract.mockReturnValue({
      contractAddress: CONTRACT,
      functionName: 'claim',
      args: [
        { u32: 0 },
        { u32: 0 },
        { address: WALLET },
        { i128: 6_000_000_000n },
        { vec: [] },
      ],
    });
  }

  it('verifies, submits, marks CLAIMED, and bumps totalClaimed', async () => {
    const { service, prisma, soroban } = makeDeps();
    withClaim(soroban);
    prisma.distributionClaim.findUnique
      .mockResolvedValueOnce(null) // pre-check on claimTxHash
      .mockResolvedValueOnce(makeClaim()); // loadClaimable

    const result = await service.claimSubmit('u2', 'dist-1', dto);

    expect(soroban.submitSignedTransaction).toHaveBeenCalledWith('SIGNED_XDR');
    expect(prisma.distributionClaim.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'claim-1' },
        data: expect.objectContaining({
          status: ClaimStatus.CLAIMED,
          claimTxHash: 'innerhash',
        }) as unknown,
      }) as unknown,
    );
    expect(prisma.profitDistribution.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'dist-1' },
        data: { totalClaimed: { increment: new Prisma.Decimal('600') } },
      }) as unknown,
    );
    expect(result).toEqual({ id: 'claim-1', status: ClaimStatus.CLAIMED });
  });

  it('is idempotent: returns the existing claim without re-submitting', async () => {
    const { service, prisma, soroban } = makeDeps();
    prisma.distributionClaim.findUnique.mockResolvedValue({
      id: 'claim-1',
      status: ClaimStatus.CLAIMED,
    });

    const result = await service.claimSubmit('u2', 'dist-1', dto);

    expect(result).toEqual({ id: 'claim-1', status: ClaimStatus.CLAIMED });
    expect(soroban.submitSignedTransaction).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects a tx whose amount does not match the entitlement', async () => {
    const { service, prisma, soroban } = makeDeps();
    soroban.decodeInvokeContract.mockReturnValue({
      contractAddress: CONTRACT,
      functionName: 'claim',
      args: [
        { u32: 0 },
        { u32: 0 },
        { address: WALLET },
        { i128: 9_999_999_999n }, // wrong amount
        { vec: [] },
      ],
    });
    prisma.distributionClaim.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(makeClaim());

    await expect(
      service.claimSubmit('u2', 'dist-1', dto),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(soroban.submitSignedTransaction).not.toHaveBeenCalled();
  });

  it('rejects a tx whose claimant is not the caller', async () => {
    const { service, prisma, soroban } = makeDeps();
    soroban.decodeInvokeContract.mockReturnValue({
      contractAddress: CONTRACT,
      functionName: 'claim',
      args: [
        { u32: 0 },
        { u32: 0 },
        { address: 'GSOMEONEELSE' },
        { i128: 6_000_000_000n },
        { vec: [] },
      ],
    });
    prisma.distributionClaim.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(makeClaim());

    await expect(
      service.claimSubmit('u2', 'dist-1', dto),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(soroban.submitSignedTransaction).not.toHaveBeenCalled();
  });
});
