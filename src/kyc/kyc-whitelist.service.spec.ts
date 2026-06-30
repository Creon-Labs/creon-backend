import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { KycStatus, WhitelistStatus } from '../../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { SorobanService } from '../soroban/soroban.service';
import { KycWhitelistService } from './kyc-whitelist.service';

const CONFIG: Record<string, string> = {
  COMPLIANCE_REGISTRY_ADDRESS: 'CREG',
};

const anyArray = expect.any(Array) as unknown;

function makeDeps() {
  const prisma = {
    kycProfile: {
      findUnique: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
    },
  };
  const soroban = {
    addressArg: jest.fn((x: string) => ({ address: x })),
    invokeContract: jest.fn(),
  };
  const config = {
    getOrThrow: (k: string) => CONFIG[k],
  } as unknown as ConfigService;
  const queue = {
    add: jest.fn().mockResolvedValue(undefined),
    remove: jest.fn().mockResolvedValue(undefined),
  };
  const service = new KycWhitelistService(
    prisma as unknown as PrismaService,
    soroban as unknown as SorobanService,
    config,
    queue as unknown as Queue,
  );
  return { service, prisma, soroban, queue };
}

function makeProfile(overrides: Record<string, unknown> = {}) {
  return {
    userId: 'u1',
    status: KycStatus.APPROVED,
    whitelistStatus: WhitelistStatus.NOT_SYNCED,
    user: { walletAddress: 'GWALLET' },
    ...overrides,
  };
}

describe('KycWhitelistService.drive', () => {
  it('adds an approved wallet to the registry and persists WHITELISTED + tx hash', async () => {
    const { service, prisma, soroban } = makeDeps();
    prisma.kycProfile.findUnique.mockResolvedValue(makeProfile());
    soroban.invokeContract.mockResolvedValue({ txHash: 'txadd' });

    await service.drive('u1');

    expect(soroban.addressArg).toHaveBeenCalledWith('GWALLET');
    expect(soroban.invokeContract).toHaveBeenCalledWith(
      'CREG',
      'add',
      anyArray,
    );
    expect(prisma.kycProfile.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'u1' },
        data: expect.objectContaining({
          whitelistStatus: WhitelistStatus.WHITELISTED,
          whitelistTxHash: 'txadd',
        }) as unknown,
      }) as unknown,
    );
  });

  it('removes a revoked wallet and persists REMOVED + tx hash', async () => {
    const { service, prisma, soroban } = makeDeps();
    prisma.kycProfile.findUnique.mockResolvedValue(
      makeProfile({
        status: KycStatus.REVOKED,
        whitelistStatus: WhitelistStatus.WHITELISTED,
      }),
    );
    soroban.invokeContract.mockResolvedValue({ txHash: 'txrm' });

    await service.drive('u1');

    expect(soroban.invokeContract).toHaveBeenCalledWith(
      'CREG',
      'remove',
      anyArray,
    );
    expect(prisma.kycProfile.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          whitelistStatus: WhitelistStatus.REMOVED,
          whitelistRemoveTxHash: 'txrm',
        }) as unknown,
      }) as unknown,
    );
  });

  it('no-ops when an approved profile is already WHITELISTED', async () => {
    const { service, prisma, soroban } = makeDeps();
    prisma.kycProfile.findUnique.mockResolvedValue(
      makeProfile({ whitelistStatus: WhitelistStatus.WHITELISTED }),
    );

    await service.drive('u1');

    expect(soroban.invokeContract).not.toHaveBeenCalled();
    expect(prisma.kycProfile.update).not.toHaveBeenCalled();
  });

  it('no-ops for a status with no on-chain action (e.g. PENDING)', async () => {
    const { service, prisma, soroban } = makeDeps();
    prisma.kycProfile.findUnique.mockResolvedValue(
      makeProfile({ status: KycStatus.PENDING }),
    );

    await service.drive('u1');

    expect(soroban.invokeContract).not.toHaveBeenCalled();
    expect(prisma.kycProfile.update).not.toHaveBeenCalled();
  });

  it('marks FAILED with the error and rethrows for BullMQ to retry', async () => {
    const { service, prisma, soroban } = makeDeps();
    prisma.kycProfile.findUnique.mockResolvedValue(makeProfile());
    soroban.invokeContract.mockRejectedValue(new Error('rpc down'));

    await expect(service.drive('u1')).rejects.toThrow('rpc down');

    expect(prisma.kycProfile.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          whitelistStatus: WhitelistStatus.FAILED,
          whitelistError: 'rpc down',
          whitelistAttempts: { increment: 1 },
        }) as unknown,
      }) as unknown,
    );
  });

  it('404s when the profile is missing', async () => {
    const { service, prisma } = makeDeps();
    prisma.kycProfile.findUnique.mockResolvedValue(null);
    await expect(service.drive('u1')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('KycWhitelistService queueing', () => {
  it('enqueue clears any stale job then adds with jobId = userId', async () => {
    const { service, queue } = makeDeps();
    await service.enqueue('u1');
    expect(queue.remove).toHaveBeenCalledWith('u1');
    expect(queue.add).toHaveBeenCalledWith(
      'sync',
      { userId: 'u1' },
      expect.objectContaining({ jobId: 'u1' }) as unknown,
    );
  });

  it('reconcile re-enqueues every not-yet-synced profile', async () => {
    const { service, prisma, queue } = makeDeps();
    prisma.kycProfile.findMany.mockResolvedValue([
      { userId: 'a' },
      { userId: 'b' },
    ]);

    await service.reconcile();

    expect(prisma.kycProfile.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([
            expect.objectContaining({
              status: KycStatus.APPROVED,
              whitelistStatus: { not: WhitelistStatus.WHITELISTED },
            }),
            expect.objectContaining({
              status: KycStatus.REVOKED,
              whitelistStatus: { not: WhitelistStatus.REMOVED },
            }),
          ]) as unknown,
        }) as unknown,
      }) as unknown,
    );
    expect(queue.add).toHaveBeenCalledTimes(2);
  });
});
