import { createHash } from 'crypto';
import { describe, expect, test } from 'bun:test';
import {
  NPM_UNIT_KEEP,
  NpmUnitValidationError,
  canonicalNpmTarballUrl,
  validateNpmUnitRequest,
} from './npm-unit-contract';

const INTEGRITY = `sha512-${createHash('sha512').update('tarball').digest('base64')}`;

function valid(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: '@tanstack/react-query',
    version: '4.36.1',
    integrity: INTEGRITY,
    resolved: 'https://registry.npmjs.org/@tanstack/react-query/-/react-query-4.36.1.tgz',
    keep: [...NPM_UNIT_KEEP],
    ...overrides,
  };
}

describe('npm unit request contract', () => {
  test('normalizes one exact scoped registry tarball request', () => {
    expect(validateNpmUnitRequest(valid())).toEqual({
      name: '@tanstack/react-query',
      version: '4.36.1',
      integrity: INTEGRITY,
      resolved: canonicalNpmTarballUrl('@tanstack/react-query', '4.36.1'),
      keep: [...NPM_UNIT_KEEP],
    });
  });

  test.each([
    '../../evil',
    '@scope/../evil',
    '@scope',
    '@scope/pkg/extra',
    'UpperCase',
    '.hidden',
  ])('rejects unsafe or non-canonical package name %s', name => {
    expect(() => validateNpmUnitRequest(valid({ name }))).toThrow(NpmUnitValidationError);
  });

  test('rejects an off-registry URL and a cross-package registry URL', () => {
    let offRegistry: NpmUnitValidationError | undefined;
    try {
      validateNpmUnitRequest(valid({
      resolved: 'https://evil.example/react-query-4.36.1.tgz',
      }));
    } catch (error) {
      offRegistry = error as NpmUnitValidationError;
    }
    expect(offRegistry?.code).toBe('unsupported_registry');
    expect(() => validateNpmUnitRequest(valid({
      resolved: 'https://registry.npmjs.org/zod/-/zod-4.36.1.tgz',
    }))).toThrow('exactly match');
  });

  test('rejects flexible versions, non-sha512 integrity, mutable keep globs, and unknown fields', () => {
    expect(() => validateNpmUnitRequest(valid({ version: '^4.36.1' }))).toThrow('exact semantic');
    expect(() => validateNpmUnitRequest(valid({ integrity: 'sha1-deadbeef' }))).toThrow('sha512');
    expect(() => validateNpmUnitRequest(valid({ keep: ['**/*'] }))).toThrow('keep must be exactly');
    expect(() => validateNpmUnitRequest(valid({ extra: true }))).toThrow('Unknown request fields');
  });
});
