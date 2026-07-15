import { ConfigService } from '@nestjs/config';
import { buildAuthCookieOptions } from './auth-cookie.constants';

function makeConfig(values: Record<string, string | undefined>): ConfigService {
  return {
    get: (key: string) => values[key],
  } as unknown as ConfigService;
}

describe('buildAuthCookieOptions', () => {
  it('uses secure cross-site cookies by default in production', () => {
    expect(
      buildAuthCookieOptions(makeConfig({ NODE_ENV: 'production' })),
    ).toMatchObject({
      httpOnly: true,
      sameSite: 'none',
      secure: true,
      path: '/',
    });
  });

  it('keeps lax cookies as the local-development default', () => {
    expect(
      buildAuthCookieOptions(makeConfig({ NODE_ENV: 'development' })),
    ).toMatchObject({
      httpOnly: true,
      sameSite: 'lax',
      secure: false,
      path: '/',
    });
  });

  it('honours an explicit cookie policy', () => {
    expect(
      buildAuthCookieOptions(
        makeConfig({
          NODE_ENV: 'production',
          AUTH_COOKIE_SAME_SITE: 'strict',
        }),
      ),
    ).toMatchObject({ sameSite: 'strict', secure: true });
  });
});
