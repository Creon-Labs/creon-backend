import { ConfigService } from '@nestjs/config';
import { CookieOptions } from 'express';

/**
 * Name of the httpOnly cookie carrying the wallet-auth JWT. Shared between
 * `AuthController` (sets/clears it) and `JwtAuthGuard` (reads it) so the two
 * can never drift. Not env-configurable: renaming it is a deploy-time code
 * change, unlike the attributes in `buildAuthCookieOptions`, which legitimately
 * vary per environment (same-site dev vs. cross-site prod).
 */
export const AUTH_COOKIE_NAME = 'creon_access_token';

/**
 * Build the `Set-Cookie` attributes shared by `res.cookie()` (register/login)
 * and `res.clearCookie()` (logout). `clearCookie` only works if called with
 * the same attributes used when the cookie was set (aside from
 * `maxAge`/`expires`) — so both call sites build from this single function
 * instead of duplicating env parsing.
 */
export function buildAuthCookieOptions(config: ConfigService): CookieOptions {
  // The production web app and API are deployed on different sites (Vercel and
  // Railway). A `lax` cookie is therefore not sent on credentialed API calls,
  // causing authenticated routes to see a missing token. Keep local development
  // simple, while making the safe cross-site configuration the production
  // default. Deployments can still explicitly opt into `lax` or `strict` when
  // both applications share a site.
  const defaultSameSite =
    config.get<string>('NODE_ENV') === 'production' ? 'none' : 'lax';
  const sameSite = (config.get<string>('AUTH_COOKIE_SAME_SITE') ??
    defaultSameSite) as CookieOptions['sameSite'];

  const secureFlag = config.get<string>('AUTH_COOKIE_SECURE') ?? 'auto';
  const secure =
    secureFlag === 'true' ||
    sameSite === 'none' || // SameSite=None without Secure is dropped by browsers
    (secureFlag === 'auto' && config.get<string>('NODE_ENV') === 'production');

  const domain = config.get<string>('AUTH_COOKIE_DOMAIN');

  return {
    httpOnly: true,
    sameSite,
    secure,
    path: '/',
    ...(domain ? { domain } : {}),
  };
}
