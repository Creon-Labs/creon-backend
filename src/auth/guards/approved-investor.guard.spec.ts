import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ApprovedInvestorGuard } from './approved-investor.guard';

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

describe('ApprovedInvestorGuard', () => {
  it('allows an investor whose KYC is APPROVED', async () => {
    const guard = new ApprovedInvestorGuard(makePrisma('APPROVED'));
    await expect(
      guard.canActivate(makeContext({ userId: 'u1', roles: ['INVESTOR'] })),
    ).resolves.toBe(true);
  });

  it('denies a non-investor', async () => {
    const guard = new ApprovedInvestorGuard(makePrisma('APPROVED'));
    await expect(
      guard.canActivate(makeContext({ userId: 'u1', roles: ['ENTREPRENEUR'] })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('denies an investor whose KYC is not APPROVED', async () => {
    const guard = new ApprovedInvestorGuard(makePrisma('PENDING'));
    await expect(
      guard.canActivate(makeContext({ userId: 'u1', roles: ['INVESTOR'] })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('denies an investor with no KYC profile', async () => {
    const guard = new ApprovedInvestorGuard(makePrisma(undefined));
    await expect(
      guard.canActivate(makeContext({ userId: 'u1', roles: ['INVESTOR'] })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
