import type { NextFunction, Request, Response } from 'express';
import { env } from '../config';
import type { AuthenticatedRequest } from '../types';
import { readRuntimeSessionRecord } from '../runtime-session/registry';
import { HostedAppControlPlaneError } from './control-plane';
import {
  hostedAppRuntimeIdFromHostname,
  HostedAppPreviewAccessError,
  hostedAppPreviewOwnerBinding,
  signHostedAppPreviewAccess,
  verifyHostedAppPreviewAccess,
} from './preview-access';
import { proxyHostedAppPreview } from './preview-proxy';
import { applyHostedAppPreviewSecurityHeaders } from './proxy-policy';

const COOKIE_NAME = '__Host-codeapi-app';
const PREVIEW_COOKIE_TTL_MS = 60 * 60_000;

function rawHostname(req: Request): string | undefined {
  const host = req.headers.host;
  if (!host || /[\s/@\\]/.test(host)) return undefined;
  try {
    return new URL(`http://${host}`).hostname;
  } catch {
    return undefined;
  }
}

function cookie(req: Request, name: string): string | undefined {
  for (const item of (req.headers.cookie ?? '').split(';')) {
    const separator = item.indexOf('=');
    if (separator < 0 || item.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(item.slice(separator + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function previewKey(): Buffer {
  return Buffer.from(env.HOSTED_APP_PREVIEW_SIGNING_KEY, 'base64');
}

function reject(res: Response, status: number, message: string): Response {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  return res.status(status).type('text/plain').send(message);
}

export async function hostedAppPreviewGateway(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (!env.HOSTED_APPS_ENABLED || !env.HOSTED_APP_PREVIEW_ORIGIN) return next();
  const hostname = rawHostname(req);
  const runtimeId = hostname
    ? hostedAppRuntimeIdFromHostname(hostname, env.HOSTED_APP_PREVIEW_ORIGIN)
    : undefined;
  if (!runtimeId) return next();

  /* A wildcard app host is a separate, unprivileged origin. Never fall through
   * from it into CodeAPI routes, even when authentication fails. */
  applyHostedAppPreviewSecurityHeaders(res);
  try {
    if (req.path === '/__codeapi/authorize') {
      if (req.method !== 'GET' || typeof req.query.token !== 'string') {
        reject(res, 400, 'Invalid preview authorization request');
        return;
      }
      const linkClaims = verifyHostedAppPreviewAccess(req.query.token, previewKey());
      if (linkClaims.hostedAppRuntimeId !== runtimeId) {
        reject(res, 403, 'Preview authorization does not match this app');
        return;
      }
      const record = await readRuntimeSessionRecord(runtimeId);
      if (
        !record?.hosted_app
        || record.state !== 'RUNNING'
        || record.hosted_app.revision !== linkClaims.revision
        || !record.microvm_id
        || !record.endpoint
        || record.hard_deadline_at == null
        || record.hard_deadline_at <= Date.now()
      ) {
        reject(res, 409, 'Hosted app is not running');
        return;
      }
      if (hostedAppPreviewOwnerBinding({
        tenantId: record.tenant_id,
        canonicalUserId: record.canonical_user_id,
      }, previewKey()) !== linkClaims.ownerBinding) {
        reject(res, 403, 'Preview authorization does not match this owner');
        return;
      }
      const expiresAt = Math.min(
        record.hard_deadline_at ?? Date.now() + PREVIEW_COOKIE_TTL_MS,
        Date.now() + PREVIEW_COOKIE_TTL_MS,
      );
      if (expiresAt <= Date.now()) {
        reject(res, 409, 'Hosted app lease has expired');
        return;
      }
      const sessionToken = signHostedAppPreviewAccess({
        ...linkClaims,
        expiresAt,
      }, previewKey());
      const maxAge = Math.max(1, Math.floor((expiresAt - Date.now()) / 1_000));
      res.setHeader('Set-Cookie', [
        `${COOKIE_NAME}=${encodeURIComponent(sessionToken)}`,
        'Path=/',
        'HttpOnly',
        'Secure',
        'SameSite=Strict',
        `Max-Age=${maxAge}`,
      ].join('; '));
      res.setHeader('Cache-Control', 'no-store');
      res.redirect(303, '/');
      return;
    }

    const sessionToken = cookie(req, COOKIE_NAME);
    if (!sessionToken) {
      reject(res, 401, 'Preview authorization required');
      return;
    }
    const claims = verifyHostedAppPreviewAccess(sessionToken, previewKey());
    if (claims.hostedAppRuntimeId !== runtimeId) {
      reject(res, 403, 'Preview authorization does not match this app');
      return;
    }
    const publicOrigin = new URL(env.HOSTED_APP_PREVIEW_ORIGIN);
    publicOrigin.hostname = hostname as string;
    await proxyHostedAppPreview(
      req as AuthenticatedRequest,
      res,
      {
        hostedAppRuntimeId: runtimeId,
        revision: claims.revision,
        ownerBinding: claims.ownerBinding,
        publicHost: publicOrigin.host,
      },
      req.path,
    );
  } catch (error) {
    if (res.headersSent) {
      res.destroy(error instanceof Error ? error : undefined);
      return;
    }
    if (error instanceof HostedAppPreviewAccessError) {
      reject(res, 401, 'Preview authorization failed');
      return;
    }
    if (error instanceof HostedAppControlPlaneError) {
      reject(res, error.status, error.message);
      return;
    }
    reject(res, 502, 'Hosted app preview is unavailable');
  }
}
