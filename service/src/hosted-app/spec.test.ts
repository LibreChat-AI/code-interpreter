import { describe, expect, test } from 'bun:test';
import {
  deriveHostedAppRuntimeId,
  hostedAppSpecFingerprint,
  parseHostedAppStartRequest,
} from './spec';

const valid = () => ({
  runtime_session_hint: 'conversation-1',
  app_id: 'demo-app',
  revision: 'rev-1',
  language: 'node',
  version: '>=22',
  entrypoint: 'src/server.js',
});

describe('hosted app spec', () => {
  test('normalizes the resident adapter defaults', () => {
    expect(parseHostedAppStartRequest(valid())).toEqual({
      runtimeSessionHint: 'conversation-1',
      spec: {
        adapter: 'resident',
        app_id: 'demo-app',
        revision: 'rev-1',
        language: 'node',
        version: '>=22',
        entrypoint: 'src/server.js',
        cwd: '.',
        args: [],
        env: {},
      },
    });
  });

  test('requires the stateful session hint and rejects unsupported adapters', () => {
    expect(() => parseHostedAppStartRequest({ ...valid(), runtime_session_hint: '' }))
      .toThrow('runtime_session_hint is required');
    expect(() => parseHostedAppStartRequest({ ...valid(), adapter: 'static' }))
      .toThrow('adapter must be "resident"');
  });

  test('rejects traversal, non-canonical paths, and runner-owned networking env', () => {
    expect(() => parseHostedAppStartRequest({ ...valid(), entrypoint: '../server.js' }))
      .toThrow('canonical relative path');
    expect(() => parseHostedAppStartRequest({ ...valid(), cwd: 'src/../src' }))
      .toThrow('canonical relative path');
    expect(() => parseHostedAppStartRequest({ ...valid(), env: { port: '9999' } }))
      .toThrow('runner-controlled');
    expect(() => parseHostedAppStartRequest({ ...valid(), env: { BASH_ENV: 'bootstrap.sh' } }))
      .toThrow('runner-controlled');
    expect(() => parseHostedAppStartRequest({ ...valid(), env: { LD_PRELOAD: './evil.so' } }))
      .toThrow('runner-controlled');
  });

  test('fingerprints equivalent env maps identically and changed launch settings differently', () => {
    const a = parseHostedAppStartRequest({ ...valid(), env: { B: '2', A: '1' } }).spec;
    const b = parseHostedAppStartRequest({ ...valid(), env: { A: '1', B: '2' } }).spec;
    const changed = { ...b, args: ['--changed'] };
    expect(hostedAppSpecFingerprint(a)).toBe(hostedAppSpecFingerprint(b));
    expect(hostedAppSpecFingerprint(a)).not.toBe(hostedAppSpecFingerprint(changed));
  });

  test('derives a stable owner-scoped opaque runtime id', () => {
    const first = deriveHostedAppRuntimeId('rt_owner_a', 'demo');
    expect(first).toMatch(/^happ_[0-9a-f]{40}$/);
    expect(deriveHostedAppRuntimeId('rt_owner_a', 'demo')).toBe(first);
    expect(deriveHostedAppRuntimeId('rt_owner_b', 'demo')).not.toBe(first);
    expect(deriveHostedAppRuntimeId('rt_owner_a', 'other')).not.toBe(first);
  });
});
