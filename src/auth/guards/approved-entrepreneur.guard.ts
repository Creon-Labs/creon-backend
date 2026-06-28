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
 * Gate routes behind a *verified* entrepreneur: the user must hold the
 * ENTREPRENEUR role AND have an {@link EntrepreneurProfile} with
 * `status === APPROVED`. Drop this onto the proposal-submission route once it
 * exists; until then it is exported and unit-tested but unwired.
 * Must run after {@link JwtAuthGuard}.
 */
@Injectable()
export class ApprovedEntrepreneurGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<Request & { user?: AuthUser }>();
    const user = request.user;
    if (!user || !user.roles?.includes(Role.ENTREPRENEUR)) {
      throw new ForbiddenException('Entrepreneur role required');
    }

    const profile = await this.prisma.entrepreneurProfile.findUnique({
      where: { userId: user.userId },
      select: { status: true },
    });
    if (profile?.status !== KycStatus.APPROVED) {
      throw new ForbiddenException('KYC not approved');
    }
    return true;
  }
}
