import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeNativeSrtCommandPolicy,
  resolveNativeSrtCommandPolicy,
  serializeNativeSrtCommandPolicy,
} from './native-policy.js';

test('restricted remains the default native SRT command policy', () => {
  assert.deepEqual(resolveNativeSrtCommandPolicy(), {
    version: 1,
    preset: 'restricted',
    network: {
      outbound: 'allowlist',
      allowLocalBinding: false,
      allowAllUnixSockets: false,
    },
  });
});

test('trusted-vm resolves to explicit permissive network controls', () => {
  assert.deepEqual(resolveNativeSrtCommandPolicy('trusted-vm'), {
    version: 1,
    preset: 'trusted-vm',
    network: {
      outbound: 'unrestricted',
      allowLocalBinding: true,
      allowAllUnixSockets: true,
    },
  });
});

test('unknown and forged native policies fail closed', () => {
  assert.throws(
    () => resolveNativeSrtCommandPolicy('host-shell'),
    /must be restricted or trusted-vm/,
  );
  assert.throws(
    () =>
      normalizeNativeSrtCommandPolicy({
        ...resolveNativeSrtCommandPolicy('restricted'),
        network: {
          ...resolveNativeSrtCommandPolicy('restricted').network,
          allowAllUnixSockets: true,
        },
      }),
    /does not match its preset/,
  );
});

test('serialized policy is stable and includes effective controls', () => {
  const first = serializeNativeSrtCommandPolicy(
    resolveNativeSrtCommandPolicy('trusted-vm'),
  );
  const second = serializeNativeSrtCommandPolicy(
    resolveNativeSrtCommandPolicy('trusted-vm'),
  );
  assert.equal(first, second);
  assert.match(first, /"outbound":"unrestricted"/);
  assert.match(first, /"allowLocalBinding":true/);
  assert.match(first, /"allowAllUnixSockets":true/);
});
