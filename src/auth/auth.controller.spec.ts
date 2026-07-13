import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { Response } from 'express';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AUTH_COOKIE_NAME } from './constants/auth-cookie.constants';

function makeResponse() {
  return {
    cookie: jest.fn(),
    clearCookie: jest.fn(),
  } as unknown as Response & { cookie: jest.Mock; clearCookie: jest.Mock };
}

const config = {
  get: (key: string) =>
    ({ AUTH_COOKIE_SAME_SITE: 'lax', AUTH_COOKIE_SECURE: 'false' })[key],
} as unknown as ConfigService;

describe('AuthController', () => {
  it('login sets the auth cookie and does not leak accessToken in the body', async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const auth = {
      login: jest.fn().mockResolvedValue({ accessToken: 'signed.jwt' }),
    } as unknown as AuthService;
    const jwt = {
      decode: jest.fn(() => ({ sub: 'u1', roles: ['INVESTOR'], exp })),
    } as unknown as JwtService;
    const controller = new AuthController(auth, jwt, config);
    const res = makeResponse();

    const body = await controller.login(
      { walletAddress: 'GA...', signature: 'sig' },
      res,
    );

    expect(body).toEqual({ userId: 'u1', roles: ['INVESTOR'] });
    expect(body).not.toHaveProperty('accessToken');
    expect(res.cookie).toHaveBeenCalledWith(
      AUTH_COOKIE_NAME,
      'signed.jwt',
      expect.objectContaining({ httpOnly: true, sameSite: 'lax' }) as unknown,
    );
  });

  it('register sets the auth cookie and does not leak accessToken in the body', async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const auth = {
      register: jest.fn().mockResolvedValue({ accessToken: 'signed.jwt' }),
    } as unknown as AuthService;
    const jwt = {
      decode: jest.fn(() => ({ sub: 'u1', roles: ['ENTREPRENEUR'], exp })),
    } as unknown as JwtService;
    const controller = new AuthController(auth, jwt, config);
    const res = makeResponse();

    const body = await controller.register(
      { walletAddress: 'GA...', signature: 'sig', role: 'ENTREPRENEUR' },
      res,
    );

    expect(body).toEqual({ userId: 'u1', roles: ['ENTREPRENEUR'] });
    expect(body).not.toHaveProperty('accessToken');
    expect(res.cookie).toHaveBeenCalledWith(
      AUTH_COOKIE_NAME,
      'signed.jwt',
      expect.objectContaining({ httpOnly: true, sameSite: 'lax' }) as unknown,
    );
  });

  it('logout clears the cookie with matching attributes', () => {
    const controller = new AuthController(
      {} as AuthService,
      {} as JwtService,
      config,
    );
    const res = makeResponse();

    controller.logout(res);

    expect(res.clearCookie).toHaveBeenCalledWith(
      AUTH_COOKIE_NAME,
      expect.objectContaining({ httpOnly: true, sameSite: 'lax' }) as unknown,
    );
  });

  it('getMe delegates to AuthService and returns user profile', async () => {
    const mockProfile = {
      id: 'u1',
      walletAddress: 'GABC',
      email: 'user@example.com',
      displayName: 'John',
      roles: ['INVESTOR'],
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const getMe = jest.fn().mockResolvedValue(mockProfile);
    const auth = {
      getMe,
    } as unknown as AuthService;
    const controller = new AuthController(auth, {} as JwtService, config);

    const result = await controller.getMe({
      userId: 'u1',
      roles: ['INVESTOR'],
    });

    expect(result).toEqual(mockProfile);
    expect(getMe).toHaveBeenCalledWith('u1');
  });
});
