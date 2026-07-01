import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';
import { KycStatus, Role } from '../../../generated/prisma/enums';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthUser } from '../types/auth-user';

/**
 * Gate routes behind a *verified* investor: the user must hold the INVESTOR
 * role AND have a {@link KycProfile} with `status === APPROVED`. The on-chain
 * whitelist is enforced by the campaign contract at `invest()` (a
 * non-whitelisted wallet reverts), so the guard need only check the platform's
 * KYC gate. Mirrors {@link ApprovedEntrepreneurGuard}; must run after
 * {@link JwtAuthGuard}.
 */
@Injectable()
export class ApprovedInvestorGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<Request & { user?: AuthUser }>();
    const user = request.user;
    if (!user || !user.roles?.includes(Role.INVESTOR)) {
      throw new ForbiddenException('Investor role required');
    }

    const profile = await this.prisma.kycProfile.findUnique({
      where: { userId: user.userId },
      select: { status: true },
    });
    if (profile?.status !== KycStatus.APPROVED) {
      throw new ForbiddenException('KYC not approved');
    }
    return true;
  }
}
