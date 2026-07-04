import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Res,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { Response } from 'express';
import { ResponseMessage } from '../common/decorators/response-message.decorator';
import { AuthService } from './auth.service';
import {
  AUTH_COOKIE_NAME,
  buildAuthCookieOptions,
} from './constants/auth-cookie.constants';
import { ChallengeDto } from './dto/challenge.dto';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import type { AuthUser } from './types/auth-user';

/** Shape of the JWT payload minted in `AuthService#signToken`, plus `exp`. */
interface DecodedAccessToken {
  sub: string;
  roles: AuthUser['roles'];
  exp?: number;
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  /** Request a challenge message to sign with the wallet. */
  @Post('challenge')
  @HttpCode(HttpStatus.OK)
  @ResponseMessage('Challenge created')
  challenge(@Body() dto: ChallengeDto): Promise<{ message: string }> {
    return this.auth.createChallenge(dto.walletAddress);
  }

  /**
   * Register a new user (proves wallet ownership via signature). The JWT is
   * set as an httpOnly cookie; the body only returns the decoded principal.
   */
  @Post('register')
  @ResponseMessage('Registration successful')
  async register(
    @Body() dto: RegisterDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthUser> {
    const { accessToken } = await this.auth.register(dto);
    return this.setAuthCookie(res, accessToken);
  }

  /**
   * Log in an existing user (proves wallet ownership via signature). The JWT
   * is set as an httpOnly cookie; the body only returns the decoded principal.
   */
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ResponseMessage('Login successful')
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthUser> {
    const { accessToken } = await this.auth.login(dto);
    return this.setAuthCookie(res, accessToken);
  }

  /**
   * Clear the auth cookie. Unguarded and idempotent: JWTs here are stateless
   * (no server-side revocation to perform), so logout is purely "tell the
   * browser to drop the cookie" and should succeed even with an
   * expired/missing cookie.
   */
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  logout(@Res({ passthrough: true }) res: Response): void {
    res.clearCookie(AUTH_COOKIE_NAME, buildAuthCookieOptions(this.config));
  }

  /**
   * Set the signed JWT as an httpOnly cookie (never returned in the body) and
   * return the decoded principal. `maxAge` is derived from the token's own
   * `exp` claim rather than re-parsing `JWT_EXPIRES_IN`, so it can't drift.
   */
  private setAuthCookie(res: Response, accessToken: string): AuthUser {
    const payload = this.jwt.decode<DecodedAccessToken>(accessToken);
    const maxAge = payload.exp ? payload.exp * 1000 - Date.now() : undefined;

    res.cookie(AUTH_COOKIE_NAME, accessToken, {
      ...buildAuthCookieOptions(this.config),
      ...(maxAge != null ? { maxAge } : {}),
    });

    return { userId: payload.sub, roles: payload.roles };
  }
}
