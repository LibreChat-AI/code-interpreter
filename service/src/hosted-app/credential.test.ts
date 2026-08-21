import { describe, expect, test } from 'bun:test';
import {
  openHostedAppCredential,
  parseHostedAppCredentialKey,
  sealHostedAppCredential,
} from './credential';

const key = Buffer.alloc(32, 7);
const credential = {
  headerName: 'X-aws-proxy-auth',
  token: 'secret-jwe',
  expiresAtMs: 1_787_300_000_000,
};

describe('hosted-app credential envelope', () => {
  test('round-trips a preview token without emitting plaintext', () => {
    const sealed = sealHostedAppCredential('happ_owner_a', credential, key);
    expect(sealed).not.toContain(credential.token);
    expect(openHostedAppCredential('happ_owner_a', sealed, key)).toEqual(credential);
  });

  test('binds ciphertext to one hosted-app identity', () => {
    const sealed = sealHostedAppCredential('happ_owner_a', credential, key);
    expect(() => openHostedAppCredential('happ_owner_b', sealed, key)).toThrow(
      'could not be authenticated',
    );
  });

  test('rejects tampering and malformed key material', () => {
    const sealed = sealHostedAppCredential('happ_owner_a', credential, key);
    const parts = sealed.split('.');
    const tag = Buffer.from(parts[2] as string, 'base64url');
    tag[0] ^= 1;
    parts[2] = tag.toString('base64url');
    const tampered = parts.join('.');
    expect(() => openHostedAppCredential('happ_owner_a', tampered, key)).toThrow(
      'could not be authenticated',
    );
    expect(() => openHostedAppCredential(
      'happ_owner_a',
      `${sealed.slice(0, -1)}${sealed.endsWith('A') ? 'B' : 'A'}`,
      key,
    )).toThrow('could not be authenticated');
    expect(() => parseHostedAppCredentialKey(Buffer.alloc(31).toString('base64')))
      .toThrow('exactly 32 bytes');
    expect(parseHostedAppCredentialKey(key.toString('base64'))).toEqual(key);
  });
});
