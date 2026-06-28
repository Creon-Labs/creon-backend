import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from './roles.guard';

function makeContext(user: unknown) {
  const request = { user };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
}

function makeReflector(required: string[] | undefined) {
  return {
    getAllAndOverride: jest.fn(() => required),
  } as unknown as Reflector;
}

describe('RolesGuard', () => {
  it('allows routes with no @Roles metadata', () => {
    const guard = new RolesGuard(makeReflector(undefined));
    expect(guard.canActivate(makeContext(undefined))).toBe(true);
  });

  it('allows a user holding a required role', () => {
    const guard = new RolesGuard(makeReflector(['ADMIN']));
    expect(
      guard.canActivate(makeContext({ userId: 'u1', roles: ['ADMIN'] })),
    ).toBe(true);
  });

  it('denies a user lacking every required role', () => {
    const guard = new RolesGuard(makeReflector(['ADMIN']));
    expect(() =>
      guard.canActivate(makeContext({ userId: 'u1', roles: ['INVESTOR'] })),
    ).toThrow(ForbiddenException);
  });

  it('denies an unauthenticated request', () => {
    const guard = new RolesGuard(makeReflector(['ADMIN']));
    expect(() => guard.canActivate(makeContext(undefined))).toThrow(
      ForbiddenException,
    );
  });
});
