import { describe, expect, test } from 'bun:test';
import {
  hostedAppPreviewAuthorizeUrl,
  hostedAppPreviewHostname,
  hostedAppPreviewOwnerBinding,
  hostedAppRuntimeIdFromHostname,
  signHostedAppPreviewAccess,
  verifyHostedAppPreviewAccess,
} from './preview-access';

const key = Buffer.alloc(32, 9);
const claims = {
  hostedAppRuntimeId: `happ_${'a'.repeat(40)}`,
  ownerBinding: hostedAppPreviewOwnerBinding({
    tenantId: 'tenant-1',
    canonicalUserId: 'user-1',
  }, key),
  expiresAt: 2_000_000,
};

describe('hosted app preview access', () => {
  test('round-trips owner-bound claims and rejects tampering or expiry', () => {
    const token = signHostedAppPreviewAccess(claims, key);
    expect(verifyHostedAppPreviewAccess(token, key, 1_000_000)).toEqual(claims);
    const parts = token.split('.');
    const signature = Buffer.from(parts[2] as string, 'base64url');
    signature[0] ^= 1;
    parts[2] = signature.toString('base64url');
    expect(() => verifyHostedAppPreviewAccess(parts.join('.'), key, 1_000_000)).toThrow('invalid');
    expect(() => verifyHostedAppPreviewAccess(`${token}=`, key, 1_000_000)).toThrow('malformed');
    expect(() => verifyHostedAppPreviewAccess(token, key, claims.expiresAt)).toThrow('expired');
  });

  test('blinds tenant and user identities into a stable keyed owner binding', () => {
    const first = hostedAppPreviewOwnerBinding({
      tenantId: 'tenant-1', canonicalUserId: 'user-1',
    }, key);
    const second = hostedAppPreviewOwnerBinding({
      tenantId: 'tenant-1', canonicalUserId: 'user-2',
    }, key);
    expect(first).not.toContain('tenant-1');
    expect(first).not.toContain('user-1');
    expect(first).not.toBe(second);
  });

  test('maps the opaque runtime id to one wildcard host and clean exchange URL', () => {
    const host = hostedAppPreviewHostname(claims.hostedAppRuntimeId, 'https://apps.example.test');
    expect(host).toBe(`happ-${'a'.repeat(40)}.apps.example.test`);
    expect(hostedAppRuntimeIdFromHostname(host, 'https://apps.example.test')).toBe(
      claims.hostedAppRuntimeId,
    );
    expect(hostedAppRuntimeIdFromHostname('apps.example.test', 'https://apps.example.test')).toBeUndefined();
    const url = new URL(hostedAppPreviewAuthorizeUrl(
      claims.hostedAppRuntimeId,
      'https://apps.example.test',
      'signed-token',
    ));
    expect(url.hostname).toBe(host);
    expect(url.pathname).toBe('/__codeapi/authorize');
    expect(url.searchParams.get('token')).toBe('signed-token');
  });
});
