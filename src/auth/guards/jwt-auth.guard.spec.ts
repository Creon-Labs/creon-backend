import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AUTH_COOKIE_NAME } from '../constants/auth-cookie.constants';
import { JwtAuthGuard } from './jwt-auth.guard';

function makeContext(
  headers: Record<string, string | undefined>,
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
  it('verifies the token and attaches the principal', () => {
    const jwt = {
      verify: jest.fn(() => ({ sub: 'u1', roles: ['ENTREPRENEUR'] })),
    } as unknown as JwtService;
    const guard = new JwtAuthGuard(jwt);
    const { context, request } = makeContext({
      authorization: 'Bearer good.token',
    });

    expect(guard.canActivate(context)).toBe(true);
    expect(request.user).toEqual({ userId: 'u1', roles: ['ENTREPRENEUR'] });
  });

  it('rejects a request without a bearer token', () => {
    const jwt = { verify: jest.fn() } as unknown as JwtService;
    const guard = new JwtAuthGuard(jwt);
    const { context } = makeContext({});
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it('rejects a malformed authorization scheme', () => {
    const jwt = { verify: jest.fn() } as unknown as JwtService;
    const guard = new JwtAuthGuard(jwt);
    const { context } = makeContext({ authorization: 'Basic abc' });
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it('rejects an invalid or expired token', () => {
    const jwt = {
      verify: jest.fn(() => {
        throw new Error('bad signature');
      }),
    } as unknown as JwtService;
    const guard = new JwtAuthGuard(jwt);
    const { context } = makeContext({ authorization: 'Bearer bad' });
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it('authenticates via cookie when no Authorization header is present', () => {
    const verify = jest.fn(() => ({ sub: 'u1', roles: ['INVESTOR'] }));
    const jwt = { verify } as unknown as JwtService;
    const guard = new JwtAuthGuard(jwt);
    const { context, request } = makeContext(
      {},
      { [AUTH_COOKIE_NAME]: 'good.token' },
    );

    expect(guard.canActivate(context)).toBe(true);
    expect(verify).toHaveBeenCalledWith('good.token');
    expect(request.user).toEqual({ userId: 'u1', roles: ['INVESTOR'] });
  });

  it('prefers the Authorization header over the cookie when both are present', () => {
    const verify = jest.fn(() => ({ sub: 'u1', roles: ['INVESTOR'] }));
    const jwt = { verify } as unknown as JwtService;
    const guard = new JwtAuthGuard(jwt);
    const { context } = makeContext(
      { authorization: 'Bearer header.token' },
      { [AUTH_COOKIE_NAME]: 'cookie.token' },
    );

    guard.canActivate(context);
    expect(verify).toHaveBeenCalledWith('header.token');
  });

  it('rejects when neither header nor cookie carry a token', () => {
    const jwt = { verify: jest.fn() } as unknown as JwtService;
    const guard = new JwtAuthGuard(jwt);
    const { context } = makeContext({}, {});
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });
});
