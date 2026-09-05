import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto';
import type { MicrovmAuthToken } from '../runtime-session/lambda-client';

const TOKEN_FORMAT = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;

export class HostedAppCredentialError extends Error {}

export function parseHostedAppCredentialKey(raw: string): Buffer {
  let key: Buffer;
  try {
    key = Buffer.from(raw, 'base64');
  } catch {
    throw new HostedAppCredentialError('CODEAPI_HOSTED_APP_CREDENTIAL_KEY must be base64');
  }
  if (key.length !== 32 || key.toString('base64').replace(/=+$/, '') !== raw.trim().replace(/=+$/, '')) {
    throw new HostedAppCredentialError(
      'CODEAPI_HOSTED_APP_CREDENTIAL_KEY must encode exactly 32 bytes',
    );
  }
  return key;
}

export function sealHostedAppCredential(
  hostedAppRuntimeId: string,
  credential: MicrovmAuthToken,
  key: Buffer,
): string {
  if (key.length !== 32) throw new HostedAppCredentialError('credential key must be 32 bytes');
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(hostedAppRuntimeId, 'utf8'));
  const plaintext = Buffer.from(JSON.stringify(credential), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    TOKEN_FORMAT,
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

export function openHostedAppCredential(
  hostedAppRuntimeId: string,
  sealed: string,
  key: Buffer,
): MicrovmAuthToken {
  if (key.length !== 32) throw new HostedAppCredentialError('credential key must be 32 bytes');
  const [version, ivRaw, tagRaw, ciphertextRaw, extra] = sealed.split('.');
  if (version !== TOKEN_FORMAT || !ivRaw || !tagRaw || !ciphertextRaw || extra !== undefined) {
    throw new HostedAppCredentialError('hosted-app credential is malformed');
  }
  try {
    const decode = (raw: string, expectedBytes?: number): Buffer => {
      if (!/^[A-Za-z0-9_-]+$/.test(raw)) throw new Error('credential encoding is malformed');
      const decoded = Buffer.from(raw, 'base64url');
      if (
        decoded.toString('base64url') !== raw
        || (expectedBytes != null && decoded.length !== expectedBytes)
      ) {
        throw new Error('credential encoding is malformed');
      }
      return decoded;
    };
    const iv = decode(ivRaw, IV_BYTES);
    const tag = decode(tagRaw, TAG_BYTES);
    const ciphertext = decode(ciphertextRaw);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from(hostedAppRuntimeId, 'utf8'));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString('utf8');
    const parsed = JSON.parse(plaintext) as Partial<MicrovmAuthToken>;
    if (
      typeof parsed.headerName !== 'string'
      || parsed.headerName.length === 0
      || typeof parsed.token !== 'string'
      || parsed.token.length === 0
      || !Number.isSafeInteger(parsed.expiresAtMs)
      || (parsed.expiresAtMs as number) <= 0
    ) {
      throw new Error('credential payload is invalid');
    }
    return parsed as MicrovmAuthToken;
  } catch (error) {
    throw new HostedAppCredentialError(
      `hosted-app credential could not be authenticated: ${(error as Error).message}`,
    );
  }
}
