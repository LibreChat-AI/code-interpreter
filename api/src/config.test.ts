import { describe, expect, test } from 'bun:test';
import { formatBindAddress, legacyPackagesDirectory } from './config';

describe('bind address formatting', () => {
  test('formats IPv4 listeners without brackets', () => {
    expect(formatBindAddress('0.0.0.0', 2000)).toBe('0.0.0.0:2000');
  });

  test('formats IPv6 listeners with brackets for logs and URLs', () => {
    expect(formatBindAddress('::', 2000)).toBe('[::]:2000');
    expect(formatBindAddress('2001:db8::1', 3112)).toBe('[2001:db8::1]:3112');
  });
});

describe('legacy package directory fallback', () => {
  test('preserves custom legacy data directories', () => {
    expect(legacyPackagesDirectory('/custom/data')).toBe('/custom/data/packages');
    expect(legacyPackagesDirectory('/custom/data/packages')).toBe('/custom/data/packages');
    expect(legacyPackagesDirectory('/')).toBe('/packages');
  });

  test('ignores empty legacy data directories', () => {
    expect(legacyPackagesDirectory(undefined)).toBeUndefined();
    expect(legacyPackagesDirectory('   ')).toBeUndefined();
  });
});
