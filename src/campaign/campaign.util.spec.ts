import { Prisma } from '../../generated/prisma/client';
import { deriveAssetCode, toStroops } from './campaign.util';

describe('campaign.util', () => {
  describe('toStroops', () => {
    it('scales a 7-dp money decimal to i128 stroops', () => {
      expect(toStroops('1')).toBe(10_000_000n);
      expect(toStroops('100.5')).toBe(1_005_000_000n);
      expect(toStroops(new Prisma.Decimal('0.0000001'))).toBe(1n);
    });
  });

  describe('deriveAssetCode', () => {
    it('produces a <=12-char uppercase alphanumeric code', () => {
      const code = deriveAssetCode('Warung Bu Sri', 'seed-1');
      expect(code.length).toBeLessThanOrEqual(12);
      expect(code).toMatch(/^[A-Z0-9]+$/);
      expect(code.startsWith('WARUNGBU')).toBe(true);
    });

    it('is deterministic for the same inputs', () => {
      expect(deriveAssetCode('Toko A', 'x')).toBe(
        deriveAssetCode('Toko A', 'x'),
      );
    });

    it('differs by seed so similar names do not collide', () => {
      expect(deriveAssetCode('Toko A', 'p1')).not.toBe(
        deriveAssetCode('Toko A', 'p2'),
      );
    });

    it('falls back to CREON when the name has no alphanumerics', () => {
      expect(deriveAssetCode('!!!', 'x').startsWith('CREON')).toBe(true);
    });
  });
});
