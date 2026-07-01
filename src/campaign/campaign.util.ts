import { createHash } from 'crypto';
import { Prisma } from '../../generated/prisma/client';

/** Stellar's `lockPeriodDays` expressed in seconds (the contract's `u64` unit). */
export const SECONDS_PER_DAY = 86_400;

/** Stroops per unit — Stellar's 7-decimal fixed point, matching `Decimal(28,7)`. */
const STROOPS = 10_000_000;

/**
 * Convert a money `Decimal` (7 dp) to its on-chain `i128` value in stroops.
 * String/BigInt math throughout — never floats.
 */
export function toStroops(amount: Prisma.Decimal | string | number): bigint {
  return BigInt(new Prisma.Decimal(amount).times(STROOPS).toFixed(0));
}

/** Convert an on-chain `i128` stroop value back to a money `Decimal` (7 dp). */
export function fromStroops(stroops: bigint): Prisma.Decimal {
  return new Prisma.Decimal(stroops.toString()).div(STROOPS);
}

/**
 * Derive a ≤12-char SEP-41 asset code (the ShareToken symbol) from the business
 * name, with a short hash suffix so similarly-named businesses don't collide.
 * Codes need not be globally unique — on-chain identity is the contract address.
 */
export function deriveAssetCode(businessName: string, seed: string): string {
  const base =
    businessName
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .slice(0, 8) || 'CREON';
  const suffix = createHash('sha256')
    .update(seed)
    .digest('hex')
    .slice(0, 4)
    .toUpperCase();
  return `${base}${suffix}`.slice(0, 12);
}
