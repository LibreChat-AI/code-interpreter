import { describe, expect, test } from 'bun:test';
import { NPM_UNIT_KEEP, type NpmUnitRequest } from './npm-unit-contract';
import {
  buildNpmUnitDispatchRequest,
  validateNpmUnitDispatchRequest,
} from './npm-unit-dispatch';

const request: NpmUnitRequest = {
  name: '@tanstack/react-query',
  version: '4.36.1',
  integrity: `sha512-${Buffer.alloc(64, 7).toString('base64')}`,
  resolved: 'https://registry.npmjs.org/@tanstack/react-query/-/react-query-4.36.1.tgz',
  keep: [...NPM_UNIT_KEEP],
};

describe('direct npm unit dispatch contract', () => {
  test('dispatches only an execution id and public package input', () => {
    const dispatch = buildNpmUnitDispatchRequest({
      executionId: 'abcdefghij_1234567890',
      request,
    });

    expect(Object.keys(dispatch).sort()).toEqual(['executionId', 'request']);
    expect(validateNpmUnitDispatchRequest(dispatch)).toEqual(dispatch);
  });

  test('rejects extra fields, including identity context', () => {
    const dispatch = buildNpmUnitDispatchRequest({
      executionId: 'abcdefghij_1234567890',
      request,
    });

    expect(() => validateNpmUnitDispatchRequest({ ...dispatch, queued: true })).toThrow('unknown dispatch field');
    expect(() => validateNpmUnitDispatchRequest({ ...dispatch, tenantLabel: 'tenant:raw-value' })).toThrow('unknown dispatch field');
  });
});
