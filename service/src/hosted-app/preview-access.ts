import { createHmac, timingSafeEqual } from 'node:crypto';
import type { HostedAppOwner } from './control-plane';

const PREVIEW_TOKEN_VERSION = 'v1';
const RUNTIME_ID_PATTERN = /^happ_[0-9a-f]{40}$/;

export interface HostedAppPreviewClaims {
  hostedAppRuntimeId: string;
  ownerBinding: string;
  expiresAt: number;
}

export class HostedAppPreviewAccessError extends Error {}

export function hostedAppPreviewOwnerBinding(owner: HostedAppOwner, key: Buffer): string {
  if (!owner.tenantId || !owner.canonicalUserId) {
    throw new HostedAppPreviewAccessError('preview owner is invalid');
  }
  return createHmac('sha256', key)
    .update('hosted-app-preview-owner-v1\0')
    .update(owner.tenantId, 'utf8')
    .update('\0')
    .update(owner.canonicalUserId, 'utf8')
    .digest('base64url');
}

function signature(payload: string, key: Buffer): Buffer {
  if (key.length !== 32) throw new HostedAppPreviewAccessError('preview signing key must be 32 bytes');
  return createHmac('sha256', key).update(PREVIEW_TOKEN_VERSION).update('.').update(payload).digest();
}

function decodeBase64url(raw: string, maxBytes: number): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) {
    throw new HostedAppPreviewAccessError('preview access token is malformed');
  }
  const decoded = Buffer.from(raw, 'base64url');
  if (decoded.length > maxBytes || decoded.toString('base64url') !== raw) {
    throw new HostedAppPreviewAccessError('preview access token is malformed');
  }
  return decoded;
}

export function signHostedAppPreviewAccess(
  claims: HostedAppPreviewClaims,
  key: Buffer,
): string {
  if (!RUNTIME_ID_PATTERN.test(claims.hostedAppRuntimeId)) {
    throw new HostedAppPreviewAccessError('hosted app runtime id is malformed');
  }
  if (
    !Number.isSafeInteger(claims.expiresAt)
    || claims.expiresAt <= 0
    || !/^[A-Za-z0-9_-]{43}$/.test(claims.ownerBinding)
  ) {
    throw new HostedAppPreviewAccessError('preview claims are invalid');
  }
  const payload = Buffer.from(JSON.stringify({
    r: claims.hostedAppRuntimeId,
    o: claims.ownerBinding,
    e: claims.expiresAt,
  }), 'utf8').toString('base64url');
  return `${PREVIEW_TOKEN_VERSION}.${payload}.${signature(payload, key).toString('base64url')}`;
}

export function verifyHostedAppPreviewAccess(
  token: string,
  key: Buffer,
  now = Date.now(),
): HostedAppPreviewClaims {
  if (token.length > 1_024) {
    throw new HostedAppPreviewAccessError('preview access token is malformed');
  }
  const [version, payload, signatureRaw, extra] = token.split('.');
  if (version !== PREVIEW_TOKEN_VERSION || !payload || !signatureRaw || extra !== undefined) {
    throw new HostedAppPreviewAccessError('preview access token is malformed');
  }
  const received = decodeBase64url(signatureRaw, 32);
  const expected = signature(payload, key);
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    throw new HostedAppPreviewAccessError('preview access token is invalid');
  }
  try {
    const parsed = JSON.parse(decodeBase64url(payload, 512).toString('utf8')) as {
      r?: unknown; o?: unknown; e?: unknown;
    };
    if (
      typeof parsed.r !== 'string'
      || !RUNTIME_ID_PATTERN.test(parsed.r)
      || typeof parsed.o !== 'string'
      || !/^[A-Za-z0-9_-]{43}$/.test(parsed.o)
      || !Number.isSafeInteger(parsed.e)
      || (parsed.e as number) <= now
    ) {
      throw new Error('claims invalid or expired');
    }
    return {
      hostedAppRuntimeId: parsed.r,
      ownerBinding: parsed.o,
      expiresAt: parsed.e as number,
    };
  } catch (error) {
    throw new HostedAppPreviewAccessError(
      `preview access token claims are invalid: ${(error as Error).message}`,
    );
  }
}

export function hostedAppPreviewHostname(runtimeId: string, previewOrigin: string): string {
  if (!RUNTIME_ID_PATTERN.test(runtimeId)) {
    throw new HostedAppPreviewAccessError('hosted app runtime id is malformed');
  }
  return `${runtimeId.replace('_', '-')}.${new URL(previewOrigin).hostname}`;
}

export function hostedAppRuntimeIdFromHostname(
  hostname: string,
  previewOrigin: string,
): string | undefined {
  const suffix = new URL(previewOrigin).hostname.toLowerCase();
  const lower = hostname.toLowerCase().replace(/\.$/, '');
  if (!lower.endsWith(`.${suffix}`)) return undefined;
  const label = lower.slice(0, -(suffix.length + 1));
  if (!/^happ-[0-9a-f]{40}$/.test(label)) return undefined;
  return label.replace('-', '_');
}

export function hostedAppPreviewAuthorizeUrl(
  runtimeId: string,
  previewOrigin: string,
  token: string,
): string {
  const origin = new URL(previewOrigin);
  origin.hostname = hostedAppPreviewHostname(runtimeId, previewOrigin);
  origin.pathname = '/__codeapi/authorize';
  origin.searchParams.set('token', token);
  return origin.toString();
}
