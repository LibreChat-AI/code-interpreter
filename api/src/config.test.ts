import { describe, expect, test } from 'bun:test';
import { legacyPackagesDirectory } from './config';

describe('legacy package directory fallback', () => {
    test('preserves custom legacy data directories', () => {
        expect(legacyPackagesDirectory('/custom/data')).toBe(
            '/custom/data/packages',
        );
        expect(legacyPackagesDirectory('/custom/data/packages')).toBe(
            '/custom/data/packages',
        );
        expect(legacyPackagesDirectory('/')).toBe('/packages');
    });

    test('ignores empty legacy data directories', () => {
        expect(legacyPackagesDirectory(undefined)).toBeUndefined();
        expect(legacyPackagesDirectory('   ')).toBeUndefined();
    });
});
