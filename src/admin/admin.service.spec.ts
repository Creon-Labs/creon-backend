import { ConflictException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { KycWhitelistService } from '../kyc/kyc-whitelist.service';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { AdminService } from './admin.service';

function makePrisma() {
  return {
    kycProfile: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
  } as unknown as PrismaService & {
    kycProfile: {
      findMany: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
    };
  };
}

function makeStorage() {
  return {
    getPresignedDownloadUrl: jest.fn().mockResolvedValue('https://signed'),
  } as unknown as StorageService & { getPresignedDownloadUrl: jest.Mock };
}

function makeWhitelist() {
  return {
    enqueue: jest.fn().mockResolvedValue(undefined),
  } as unknown as KycWhitelistService & { enqueue: jest.Mock };
}

const config = {
  getOrThrow: () => 'creon-kyc',
} as unknown as ConfigService;

describe('AdminService', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let storage: ReturnType<typeof makeStorage>;
  let whitelist: ReturnType<typeof makeWhitelist>;
  let service: AdminService;

  beforeEach(() => {
    prisma = makePrisma();
    storage = makeStorage();
    whitelist = makeWhitelist();
    service = new AdminService(prisma, storage, config, whitelist);
  });

  it('lists submissions with presigned image URLs from the private bucket', async () => {
    prisma.kycProfile.findMany.mockResolvedValue([
      {
        userId: 'u1',
        fullName: 'Budi',
        nationalId: '1234567890123456',
        status: 'PENDING',
        submittedAt: new Date(),
        rejectionReason: null,
        idCardImageKey: 'kyc/u1/id-card.jpg',
        selfieImageKey: 'kyc/u1/selfie.jpg',
        user: { walletAddress: 'GABC', email: 'e@x.com', roles: ['INVESTOR'] },
      },
    ]);

    const result = await service.list('PENDING');

    expect(storage.getPresignedDownloadUrl).toHaveBeenCalledWith(
      'kyc/u1/id-card.jpg',
      300,
      'creon-kyc',
    );
    expect(result[0]).toMatchObject({
      userId: 'u1',
      walletAddress: 'GABC',
      roles: ['INVESTOR'],
      idCardUrl: 'https://signed',
      selfieUrl: 'https://signed',
    });
  });

  it('approves a pending submission and stamps the reviewer', async () => {
    prisma.kycProfile.findUnique.mockResolvedValue({
      status: 'PENDING',
    });
    prisma.kycProfile.update.mockResolvedValue({
      userId: 'u1',
      status: 'APPROVED',
    });

    await service.approve('u1', 'admin1');

    expect(prisma.kycProfile.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'u1' },
        data: expect.objectContaining({
          status: 'APPROVED',
          reviewedById: 'admin1',
        }) as unknown,
      }) as unknown,
    );
    expect(whitelist.enqueue).toHaveBeenCalledWith('u1');
  });

  it('revokes an approved submission and enqueues the on-chain remove', async () => {
    prisma.kycProfile.findUnique.mockResolvedValue({ status: 'APPROVED' });
    prisma.kycProfile.update.mockResolvedValue({
      userId: 'u1',
      status: 'REVOKED',
    });

    await service.revoke('u1', 'admin1', 'sanction list hit');

    expect(prisma.kycProfile.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'u1' },
        data: expect.objectContaining({
          status: 'REVOKED',
          reviewedById: 'admin1',
          rejectionReason: 'sanction list hit',
        }) as unknown,
      }) as unknown,
    );
    expect(whitelist.enqueue).toHaveBeenCalledWith('u1');
  });

  it('409s when revoking a non-approved submission', async () => {
    prisma.kycProfile.findUnique.mockResolvedValue({ status: 'PENDING' });
    await expect(service.revoke('u1', 'admin1', 'x')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(whitelist.enqueue).not.toHaveBeenCalled();
  });

  it('404s when revoking a missing submission', async () => {
    prisma.kycProfile.findUnique.mockResolvedValue(null);
    await expect(service.revoke('u1', 'admin1', 'x')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('rejects a pending submission with a reason', async () => {
    prisma.kycProfile.findUnique.mockResolvedValue({
      status: 'PENDING',
    });
    prisma.kycProfile.update.mockResolvedValue({
      userId: 'u1',
      status: 'REJECTED',
    });

    await service.reject('u1', 'admin1', 'blurry photo');

    expect(prisma.kycProfile.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'REJECTED',
          rejectionReason: 'blurry photo',
        }) as unknown,
      }) as unknown,
    );
  });

  it('404s when reviewing a missing submission', async () => {
    prisma.kycProfile.findUnique.mockResolvedValue(null);
    await expect(service.approve('u1', 'admin1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('409s when reviewing a non-pending submission', async () => {
    prisma.kycProfile.findUnique.mockResolvedValue({
      status: 'APPROVED',
    });
    await expect(service.approve('u1', 'admin1')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});
