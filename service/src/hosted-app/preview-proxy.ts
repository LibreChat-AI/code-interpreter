import type { Response } from 'express';
import { Readable, Transform } from 'node:stream';
import { env } from '../config';
import { readRuntimeSessionRecord } from '../runtime-session/registry';
import type { RuntimeSessionRecord } from '../runtime-session/registry';
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
  revision?: string;
  sourceRuntimeSessionId?: string;
  identity?: { tenantId: string; canonicalUserId: string };
  ownerBinding?: string;
  publicHost?: string;
}

export function hostedAppPreviewRecordUsable(
  record: RuntimeSessionRecord | null | undefined,
  resolved: HostedAppPreviewTarget,
  now = Date.now(),
): record is RuntimeSessionRecord & {
  hosted_app: NonNullable<RuntimeSessionRecord['hosted_app']>;
  microvm_id: string;
  endpoint: string;
} {
  return Boolean(
    record?.hosted_app
    && record.state === 'RUNNING'
    && record.microvm_id
    && record.endpoint
    && record.hard_deadline_at != null
    && record.hard_deadline_at > now
    && (resolved.revision == null || record.hosted_app.revision === resolved.revision)
  );
}

export function hostedAppPreviewCredentialUsable(
  record: RuntimeSessionRecord | null | undefined,
  resolved: HostedAppPreviewTarget,
  now = Date.now(),
  minimumTtlMs = 0,
): record is RuntimeSessionRecord & {
  hosted_app: NonNullable<RuntimeSessionRecord['hosted_app']> & {
    preview_credential: string;
    preview_credential_expires_at: number;
  };
  microvm_id: string;
  endpoint: string;
} {
  return hostedAppPreviewRecordUsable(record, resolved, now)
    && Boolean(
      record.hosted_app.preview_credential
      && record.hosted_app.preview_credential_expires_at != null
      && record.hosted_app.preview_credential_expires_at > now + minimumTtlMs
    );
}

async function previewRecord(
  resolved: HostedAppPreviewTarget,
  signal: AbortSignal,
) {
  let record = await readRuntimeSessionRecord(resolved.hostedAppRuntimeId, { signal });
  if (!hostedAppPreviewRecordUsable(record, resolved)) {
    throw new HostedAppControlPlaneError(
      'hosted_app_not_running',
      'Hosted app is not running',
      409,
      true,
    );
  }
  assertPreviewRecordAuthorized(record, resolved);
  if (!hostedAppPreviewCredentialUsable(record, resolved, Date.now(), PREVIEW_REFRESH_SKEW_MS)) {
    await submitHostedAppJob('hosted-app:refresh-preview', {
      operation: 'refresh-preview',
      hostedAppRuntimeId: resolved.hostedAppRuntimeId,
      tenantId: record.tenant_id,
      canonicalUserId: record.canonical_user_id,
      _otel: captureTraceCarrier(),
    }, `happ-refresh-${resolved.hostedAppRuntimeId}-${Math.floor(Date.now() / 30_000)}`);
    record = await readRuntimeSessionRecord(resolved.hostedAppRuntimeId, { signal });
  }
  if (!hostedAppPreviewCredentialUsable(record, resolved)) {
    throw new HostedAppControlPlaneError(
      'hosted_app_preview_unavailable',
      'Hosted app preview credential is unavailable',
      503,
      true,
    );
  }
  /* Refresh waits on another worker and then rereads durable state. Recheck
   * ownership on that second snapshot instead of relying on the pre-await
   * authorization decision. */
  assertPreviewRecordAuthorized(record, resolved);
  return record;
}

function assertPreviewRecordAuthorized(
  record: RuntimeSessionRecord,
  resolved: HostedAppPreviewTarget,
): void {
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

export function rewriteHostedAppLocation(
  location: string,
  currentUpstreamUrl: string,
): string | undefined {
  try {
    const upstreamOrigin = new URL(currentUpstreamUrl);
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

export function hostedAppForwardedQuery(originalUrl: string): string {
  const queryStart = originalUrl.indexOf('?');
  return queryStart < 0 ? '' : originalUrl.slice(queryStart);
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
    if (token.expiresAtMs <= Date.now()) {
      throw new HostedAppControlPlaneError(
        'hosted_app_preview_unavailable',
        'Hosted app preview credential is unavailable',
        503,
        true,
      );
    }
    const endpoint = `${record.endpoint?.replace(/\/+$/, '')}/`;
    const upstream = hostedAppUpstreamUrl(endpoint, upstreamPath);
    /* A reverse proxy must not parse and rebuild signed/repeated query strings:
     * decoding and re-encoding changes their byte representation, while nested
     * values can disappear entirely through Express's query parser. Preserve
     * the original query bytes and constrain only the upstream origin/path. */
    upstream.search = hostedAppForwardedQuery(req.originalUrl);
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
    /* Resolve relative redirects against the request URL, not the AWS endpoint
     * root. Framework redirects such as `Location: ../login` depend on the
     * current route while the same-origin check still strips the AWS origin. */
    const safeLocation = location
      ? rewriteHostedAppLocation(location, upstream.toString())
      : undefined;
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
