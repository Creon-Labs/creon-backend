import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AUTH_COOKIE_NAME } from '../constants/auth-cookie.constants';
import { JwtAuthGuard } from './jwt-auth.guard';

function makeContext(
  headers: Record<string, string | undefined> = {},
  cookies: Record<string, string | undefined> = {},
) {
  const request: {
    headers: Record<string, string | undefined>;
    cookies: Record<string, string | undefined>;
    user?: unknown;
  } = { headers, cookies };
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return { context, request };
}

describe('JwtAuthGuard', () => {
  it('verifies the cookie token and attaches the principal', () => {
    const verify = jest.fn(() => ({ sub: 'u1', roles: ['ENTREPRENEUR'] }));
    const jwt = { verify } as unknown as JwtService;
    const guard = new JwtAuthGuard(jwt);
    const { context, request } = makeContext(
      {},
      { [AUTH_COOKIE_NAME]: 'good.token' },
    );

    expect(guard.canActivate(context)).toBe(true);
    expect(verify).toHaveBeenCalledWith('good.token');
    expect(request.user).toEqual({ userId: 'u1', roles: ['ENTREPRENEUR'] });
  });

  it('rejects a request without the auth cookie', () => {
    const jwt = { verify: jest.fn() } as unknown as JwtService;
    const guard = new JwtAuthGuard(jwt);
    const { context } = makeContext();
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it('rejects an invalid or expired cookie token', () => {
    const jwt = {
      verify: jest.fn(() => {
        throw new Error('bad signature');
      }),
    } as unknown as JwtService;
    const guard = new JwtAuthGuard(jwt);
    const { context } = makeContext({}, { [AUTH_COOKIE_NAME]: 'bad.token' });
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it('ignores an Authorization Bearer header when the cookie is absent', () => {
    const jwt = { verify: jest.fn() } as unknown as JwtService;
    const guard = new JwtAuthGuard(jwt);
    const { context } = makeContext({ authorization: 'Bearer good.token' });
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it('uses the cookie even when an Authorization header is also present', () => {
    const verify = jest.fn(() => ({ sub: 'u1', roles: ['INVESTOR'] }));
    const jwt = { verify } as unknown as JwtService;
    const guard = new JwtAuthGuard(jwt);
    const { context, request } = makeContext(
      { authorization: 'Bearer header.token' },
      { [AUTH_COOKIE_NAME]: 'cookie.token' },
    );

    expect(guard.canActivate(context)).toBe(true);
    expect(verify).toHaveBeenCalledWith('cookie.token');
    expect(request.user).toEqual({ userId: 'u1', roles: ['INVESTOR'] });
  });
});
