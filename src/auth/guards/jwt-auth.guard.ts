import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { Role } from '../../../generated/prisma/enums';
import { AUTH_COOKIE_NAME } from '../constants/auth-cookie.constants';
import { AuthUser } from '../types/auth-user';

/** Shape of the JWT payload minted in `AuthService#signToken`. */
interface JwtPayload {
  sub: string;
  roles: Role[];
}

/**
 * Authenticate a request from either its `Authorization: Bearer <token>`
 * header or its `AUTH_COOKIE_NAME` httpOnly cookie (the header takes
 * precedence when both are present), verifying the JWT with the module
 * secret and attaching the decoded principal to `request.user`. Throws
 * {@link UnauthorizedException} when absent/invalid.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<Request & { user?: AuthUser }>();

    const token = this.extractToken(request);
    if (!token) {
      throw new UnauthorizedException('Missing bearer token');
    }

    let payload: JwtPayload;
    try {
      payload = this.jwt.verify<JwtPayload>(token);
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }

    request.user = { userId: payload.sub, roles: payload.roles };
    return true;
  }

  private extractToken(request: Request): string | undefined {
    const header = request.headers.authorization;
    if (header) {
      const [scheme, value] = header.split(' ');
      if (scheme === 'Bearer' && value) {
        return value;
      }
    }
    const cookies = request.cookies as
      Record<string, string | undefined> | undefined;
    return cookies?.[AUTH_COOKIE_NAME];
  }
}
