import { maskAddress, maskName } from './holding.util';

const ADDRESS = 'GCUQRLMIYPTNGYQBEN6P6HMTDAETLKYEQORMQWV7SKNTX7XDDNN3OCBY';

describe('maskAddress', () => {
  it('truncates a full Stellar address to first-4…last-4', () => {
    expect(maskAddress(ADDRESS)).toBe('GCUQ…OCBY');
  });

  it('returns short or empty input unchanged', () => {
    expect(maskAddress('')).toBe('');
    expect(maskAddress('GCUQRLMI')).toBe('GCUQRLMI');
  });
});

describe('maskName', () => {
  it('reduces each word to its initial', () => {
    expect(maskName('Budi Santoso')).toBe('B*** S***');
  });

  it('masks a single-word name', () => {
    expect(maskName('Budi')).toBe('B***');
  });

  it('collapses surrounding/extra whitespace', () => {
    expect(maskName('  Budi   Santoso  ')).toBe('B*** S***');
  });

  it('passes null through (unregistered holder)', () => {
    expect(maskName(null)).toBeNull();
  });

  it('returns null for a blank/whitespace-only name', () => {
    expect(maskName('   ')).toBeNull();
  });
});
