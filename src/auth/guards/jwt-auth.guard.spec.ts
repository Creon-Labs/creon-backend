import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { JwtAuthGuard } from './jwt-auth.guard';

function makeContext(headers: Record<string, string | undefined>) {
  const request: {
    headers: Record<string, string | undefined>;
    user?: unknown;
  } = { headers };
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
});
