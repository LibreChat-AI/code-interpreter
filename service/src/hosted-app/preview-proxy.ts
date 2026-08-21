import type { Response } from 'express';
import { Readable, Transform } from 'node:stream';
import { env } from '../config';
import { readRuntimeSessionRecord } from '../runtime-session/registry';
import { captureTraceCarrier } from '../telemetry';
import type { AuthenticatedRequest } from '../types';
import { assertHostedAppOwned, HostedAppControlPlaneError } from './control-plane';
import { openHostedAppCredential, parseHostedAppCredentialKey } from './credential';
import {
  hostedAppProxyRequestHeaders,
  hostedAppProxyResponseHeaders,
} from './proxy-policy';
import { submitHostedAppJob } from './queue';
import { hostedAppPreviewOwnerBinding } from './preview-access';

const PREVIEW_REFRESH_SKEW_MS = 60_000;

export interface HostedAppPreviewTarget {
  hostedAppRuntimeId: string;
  sourceRuntimeSessionId?: string;
  identity?: { tenantId: string; canonicalUserId: string };
  ownerBinding?: string;
  publicHost?: string;
}

async function previewRecord(
  resolved: HostedAppPreviewTarget,
  signal: AbortSignal,
) {
  let record = await readRuntimeSessionRecord(resolved.hostedAppRuntimeId, { signal });
  if (
    !record?.hosted_app
    || record.state !== 'RUNNING'
    || !record.microvm_id
    || !record.endpoint
  ) {
    throw new HostedAppControlPlaneError(
      'hosted_app_not_running',
      'Hosted app is not running',
      409,
      true,
    );
  }
  if (resolved.identity) {
    assertHostedAppOwned(record, resolved.identity, resolved.sourceRuntimeSessionId);
  } else {
    const key = Buffer.from(env.HOSTED_APP_PREVIEW_SIGNING_KEY, 'base64');
    const expected = hostedAppPreviewOwnerBinding({
      tenantId: record.tenant_id,
      canonicalUserId: record.canonical_user_id,
    }, key);
    if (!resolved.ownerBinding || resolved.ownerBinding !== expected) {
      throw new HostedAppControlPlaneError('hosted_app_not_found', 'Hosted app not found', 404);
    }
  }
  if (
    !record.hosted_app.preview_credential
    || !record.hosted_app.preview_credential_expires_at
    || record.hosted_app.preview_credential_expires_at <= Date.now() + PREVIEW_REFRESH_SKEW_MS
  ) {
    await submitHostedAppJob('hosted-app:refresh-preview', {
      operation: 'refresh-preview',
      hostedAppRuntimeId: resolved.hostedAppRuntimeId,
      tenantId: record.tenant_id,
      canonicalUserId: record.canonical_user_id,
      _otel: captureTraceCarrier(),
    }, `happ-refresh-${resolved.hostedAppRuntimeId}-${Math.floor(Date.now() / 30_000)}`);
    record = await readRuntimeSessionRecord(resolved.hostedAppRuntimeId, { signal });
  }
  if (
    !record?.hosted_app?.preview_credential
    || record.state !== 'RUNNING'
    || !record.endpoint
  ) {
    throw new HostedAppControlPlaneError(
      'hosted_app_preview_unavailable',
      'Hosted app preview credential is unavailable',
      503,
      true,
    );
  }
  return record;
}

function requestBody(req: AuthenticatedRequest): BodyInit | undefined {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined;
  const declaredLength = Number(req.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > env.MAX_FILE_SIZE) {
    throw new HostedAppControlPlaneError(
      'hosted_app_request_too_large',
      `Hosted app request exceeds ${env.MAX_FILE_SIZE} bytes`,
      413,
    );
  }
  if (req.body != null) {
    const body = Buffer.isBuffer(req.body) || typeof req.body === 'string'
      ? req.body
      : JSON.stringify(req.body);
    if (Buffer.byteLength(body) > env.MAX_FILE_SIZE) {
      throw new HostedAppControlPlaneError(
        'hosted_app_request_too_large',
        `Hosted app request exceeds ${env.MAX_FILE_SIZE} bytes`,
        413,
      );
    }
    return body as unknown as BodyInit;
  }
  let bytes = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      callback(
        bytes > env.MAX_FILE_SIZE
          ? new HostedAppControlPlaneError(
            'hosted_app_request_too_large',
            `Hosted app request exceeds ${env.MAX_FILE_SIZE} bytes`,
            413,
          )
          : null,
        chunk,
      );
    },
  });
  return req.pipe(limiter) as unknown as BodyInit;
}

function rewriteLocation(location: string, endpoint: string): string | undefined {
  try {
    const upstreamOrigin = new URL(endpoint);
    const destination = new URL(location, upstreamOrigin);
    if (destination.origin !== upstreamOrigin.origin) return undefined;
    return `${destination.pathname}${destination.search}${destination.hash}`;
  } catch {
    return undefined;
  }
}

/** Preserve the AWS endpoint origin even when a hostile request path begins
 * with `//` (which URL resolution would otherwise treat as a new host). */
export function hostedAppUpstreamUrl(endpoint: string, upstreamPath: string): URL {
  let upstream: URL;
  try {
    upstream = new URL(endpoint);
  } catch {
    throw new HostedAppControlPlaneError(
      'hosted_app_endpoint_invalid',
      'Hosted app endpoint is invalid',
      502,
      true,
    );
  }
  if (
    upstream.protocol !== 'https:'
    || upstream.username
    || upstream.password
    || !upstream.hostname
  ) {
    throw new HostedAppControlPlaneError(
      'hosted_app_endpoint_invalid',
      'Hosted app endpoint is invalid',
      502,
      true,
    );
  }
  upstream.pathname = upstreamPath.startsWith('/') ? upstreamPath : `/${upstreamPath}`;
  upstream.search = '';
  upstream.hash = '';
  return upstream;
}

export async function proxyHostedAppPreview(
  req: AuthenticatedRequest,
  res: Response,
  resolved: HostedAppPreviewTarget,
  upstreamPath: string,
): Promise<Response | void> {
  const controller = new AbortController();
  const abort = (): void => controller.abort(new Error('Preview client disconnected'));
  req.once('aborted', abort);
  res.once('close', abort);
  try {
    const record = await previewRecord(resolved, controller.signal);
    const key = parseHostedAppCredentialKey(env.HOSTED_APP_CREDENTIAL_KEY);
    const token = openHostedAppCredential(
      resolved.hostedAppRuntimeId,
      record.hosted_app?.preview_credential as string,
      key,
    );
    const endpoint = `${record.endpoint?.replace(/\/+$/, '')}/`;
    const upstream = hostedAppUpstreamUrl(endpoint, upstreamPath);
    for (const [name, value] of Object.entries(req.query)) {
      if (Array.isArray(value)) {
        for (const item of value) upstream.searchParams.append(name, String(item));
      } else if (value != null && typeof value !== 'object') {
        upstream.searchParams.set(name, String(value));
      }
    }
    const init: RequestInit & { duplex?: 'half' } = {
      method: req.method,
      headers: hostedAppProxyRequestHeaders(
        req.headers,
        token,
        env.HOSTED_APP_PREVIEW_PORT,
        resolved.publicHost ? {
          host: resolved.publicHost,
          protocol: new URL(env.HOSTED_APP_PREVIEW_ORIGIN).protocol === 'http:' ? 'http' : 'https',
        } : undefined,
      ),
      body: requestBody(req),
      redirect: 'manual',
      signal: controller.signal,
    };
    if (init.body != null && !Buffer.isBuffer(init.body) && typeof init.body !== 'string') {
      init.duplex = 'half';
    }
    const response = await fetch(upstream, init);
    res.status(response.status);
    hostedAppProxyResponseHeaders(response.headers).forEach((value, name) => {
      res.setHeader(name, value);
    });
    const location = response.headers.get('location');
    const safeLocation = location ? rewriteLocation(location, endpoint) : undefined;
    if (location && !safeLocation) {
      await response.body?.cancel().catch(() => {});
      return res.status(502).type('text/plain').send('Hosted app returned an unsafe redirect');
    }
    if (safeLocation) res.setHeader('Location', safeLocation);
    if (req.method === 'HEAD' || response.body == null) return res.end();
    const body = Readable.fromWeb(response.body as never);
    body.once('error', error => res.destroy(error));
    body.pipe(res);
  } finally {
    req.removeListener('aborted', abort);
    if (res.writableEnded) res.removeListener('close', abort);
  }
}
