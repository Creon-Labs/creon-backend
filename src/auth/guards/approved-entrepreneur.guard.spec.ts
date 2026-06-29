import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ApprovedEntrepreneurGuard } from './approved-entrepreneur.guard';

function makeContext(user: unknown) {
  const request = { user };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function makePrisma(status?: string) {
  return {
    kycProfile: {
      findUnique: jest.fn(() => Promise.resolve(status ? { status } : null)),
    },
  } as unknown as PrismaService;
}

describe('ApprovedEntrepreneurGuard', () => {
  it('allows an entrepreneur whose KYC is APPROVED', async () => {
    const guard = new ApprovedEntrepreneurGuard(makePrisma('APPROVED'));
    await expect(
      guard.canActivate(makeContext({ userId: 'u1', roles: ['ENTREPRENEUR'] })),
    ).resolves.toBe(true);
  });

  it('denies a non-entrepreneur', async () => {
    const guard = new ApprovedEntrepreneurGuard(makePrisma('APPROVED'));
    await expect(
      guard.canActivate(makeContext({ userId: 'u1', roles: ['INVESTOR'] })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('denies an entrepreneur whose KYC is not APPROVED', async () => {
    const guard = new ApprovedEntrepreneurGuard(makePrisma('PENDING'));
    await expect(
      guard.canActivate(makeContext({ userId: 'u1', roles: ['ENTREPRENEUR'] })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('denies an entrepreneur with no KYC profile', async () => {
    const guard = new ApprovedEntrepreneurGuard(makePrisma(undefined));
    await expect(
      guard.canActivate(makeContext({ userId: 'u1', roles: ['ENTREPRENEUR'] })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
