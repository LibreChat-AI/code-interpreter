import { describe, expect, test } from 'bun:test';
import type { RuntimeSessionRecord } from '../runtime-session/registry';
import {
  hostedAppPreviewCredentialUsable,
  hostedAppForwardedQuery,
  hostedAppUpstreamUrl,
  rewriteHostedAppLocation,
} from './preview-proxy';

function previewRecord(): RuntimeSessionRecord {
  return {
    runtime_session_id: `happ_${'a'.repeat(40)}`,
    tenant_id: 'tenant-1',
    canonical_user_id: 'user-1',
    state: 'RUNNING',
    generation: 1,
    launched_at: 1_000,
    last_seen_at: 1_000,
    hard_deadline_at: 20_000,
    microvm_id: 'vm-1',
    endpoint: 'https://vm.aws.example',
    hosted_app: {
      source_runtime_session_id: 'rt-source',
      app_id: 'demo',
      revision: 'rev-2',
      spec_fingerprint: 'fingerprint',
      spec: {
        adapter: 'resident',
        app_id: 'demo',
        revision: 'rev-2',
        language: 'node',
        version: '22',
        entrypoint: 'server.js',
        cwd: '.',
        args: [],
        env: {},
      },
      checkpoint_key: 'checkpoint',
      preview_credential: 'sealed',
      preview_credential_expires_at: 15_000,
    },
  };
}

describe('hosted app preview upstream URL', () => {
  test('keeps protocol-relative and ordinary request paths on the AWS endpoint origin', () => {
    const endpoint = 'https://vm.aws.example/';
    expect(hostedAppUpstreamUrl(endpoint, '/assets/app.js').toString())
      .toBe('https://vm.aws.example/assets/app.js');
    expect(hostedAppUpstreamUrl(endpoint, '//attacker.example/steal').origin)
      .toBe('https://vm.aws.example');
    expect(hostedAppUpstreamUrl(endpoint, '//attacker.example/steal').pathname)
      .toBe('//attacker.example/steal');
  });

  test('rejects non-HTTPS and credential-bearing endpoints', () => {
    expect(() => hostedAppUpstreamUrl('http://vm.aws.example', '/')).toThrow(
      'Hosted app endpoint is invalid',
    );
    expect(() => hostedAppUpstreamUrl('https://user@vm.aws.example', '/')).toThrow(
      'Hosted app endpoint is invalid',
    );
  });

  test('resolves relative redirects against the current app route', () => {
    const current = 'https://vm.aws.example/projects/demo/start?from=preview';
    expect(rewriteHostedAppLocation('../login?next=demo', current))
      .toBe('/projects/login?next=demo');
    expect(rewriteHostedAppLocation('?ready=true', current))
      .toBe('/projects/demo/start?ready=true');
    expect(rewriteHostedAppLocation('https://attacker.example/steal', current)).toBeUndefined();
  });

  test('preserves signed and repeated query bytes without Express re-encoding', () => {
    expect(hostedAppForwardedQuery('/download?sig=a%2Fb+c&tag=one&tag=two'))
      .toBe('?sig=a%2Fb+c&tag=one&tag=two');
    expect(hostedAppForwardedQuery('/download')).toBe('');
  });

  test('rejects stale revisions, expired leases, and expired preview credentials', () => {
    const record = previewRecord();
    const target = {
      hostedAppRuntimeId: record.runtime_session_id,
      revision: 'rev-2',
      ownerBinding: 'owner',
    };
    expect(hostedAppPreviewCredentialUsable(record, target, 10_000)).toBe(true);
    expect(hostedAppPreviewCredentialUsable(record, { ...target, revision: 'rev-1' }, 10_000))
      .toBe(false);
    expect(hostedAppPreviewCredentialUsable({
      ...record,
      hard_deadline_at: 10_000,
    }, target, 10_000)).toBe(false);
    expect(hostedAppPreviewCredentialUsable({
      ...record,
      hosted_app: {
        ...record.hosted_app!,
        preview_credential_expires_at: 10_000,
      },
    }, target, 10_000)).toBe(false);
  });
});
