import { Router, type Response } from 'express';
import type { AuthenticatedRequest } from '../types';
import { env } from '../config';
import { getExecutionIdentity } from '../execution-identity';
import { checkServiceShutDown, checkServiceStartUp } from '../lifecycle';
import { readRuntimeSessionRecord } from '../runtime-session/registry';
import {
  deriveRuntimeSessionId,
  validateRuntimeSessionHint,
  RuntimeSessionHintError,
} from '../runtime-session/id';
import { captureTraceCarrier } from '../telemetry';
import {
  assertHostedAppOwned,
  HostedAppControlPlaneError,
  hostedAppPublicStatus,
} from './control-plane';
import { submitHostedAppJob } from './queue';
import {
  deriveHostedAppRuntimeId,
  HostedAppSpecError,
  parseHostedAppStartRequest,
  validateHostedAppId,
} from './spec';
import {
  hostedAppPreviewAuthorizeUrl,
  hostedAppPreviewOwnerBinding,
  signHostedAppPreviewAccess,
} from './preview-access';
import type { HostedAppPublicStatus } from './record';
import type { HostedAppPreviewTarget } from './preview-proxy';

const router = Router();
const PREVIEW_LINK_TTL_MS = 5 * 60_000;

function presentStatus(
  status: HostedAppPublicStatus,
  owner: { tenantId: string; canonicalUserId: string },
): HostedAppPublicStatus {
  if (status.state !== 'running') return status;
  const key = Buffer.from(env.HOSTED_APP_PREVIEW_SIGNING_KEY, 'base64');
  const token = signHostedAppPreviewAccess({
    hostedAppRuntimeId: status.preview_id,
    ownerBinding: hostedAppPreviewOwnerBinding(owner, key),
    expiresAt: Date.now() + PREVIEW_LINK_TTL_MS,
  }, key);
  return {
    ...status,
    preview_url: hostedAppPreviewAuthorizeUrl(
      status.preview_id,
      env.HOSTED_APP_PREVIEW_ORIGIN,
      token,
    ),
  };
}

function unavailable(res: Response): Response | undefined {
  if (!env.HOSTED_APPS_ENABLED) {
    return res.status(404).json({ error: 'hosted_apps_disabled', message: 'Not Found' });
  }
  if (checkServiceShutDown()) {
    return res.status(503).json({ error: 'service_shutting_down', message: 'Service is shutting down' });
  }
  if (checkServiceStartUp()) {
    return res.status(503).json({ error: 'service_starting', message: 'Service is starting up' });
  }
  return undefined;
}

function target(
  req: AuthenticatedRequest,
  rawAppId: unknown,
  rawHint: unknown,
): HostedAppPreviewTarget & {
  appId: string;
  sourceRuntimeSessionId: string;
  identity: { tenantId: string; canonicalUserId: string };
} {
  const appId = validateHostedAppId(rawAppId);
  const hint = validateRuntimeSessionHint(rawHint);
  if (!hint) throw new HostedAppSpecError('runtime_session_hint is required');
  const identity = getExecutionIdentity(req);
  const sourceRuntimeSessionId = deriveRuntimeSessionId({
    storageNamespace: identity.storageNamespace,
    canonicalUserId: identity.canonicalUserId,
    hint,
  });
  return {
    appId,
    identity,
    sourceRuntimeSessionId,
    hostedAppRuntimeId: deriveHostedAppRuntimeId(sourceRuntimeSessionId, appId),
  };
}

function parseWorkerFailure(error: unknown): HostedAppControlPlaneError | undefined {
  const message = error instanceof Error ? error.message : String(error);
  const jsonStart = message.indexOf('{');
  if (jsonStart < 0) return undefined;
  try {
    const parsed = JSON.parse(message.slice(jsonStart)) as Record<string, unknown>;
    if (
      typeof parsed.code === 'string'
      && typeof parsed.message === 'string'
      && typeof parsed.status === 'number'
    ) {
      return new HostedAppControlPlaneError(
        parsed.code,
        parsed.message,
        parsed.status,
        parsed.transient === true,
      );
    }
  } catch {
    // Fall through to the generic failure below.
  }
  return undefined;
}

function sendFailure(error: unknown, res: Response): Response {
  if (
    error instanceof HostedAppSpecError
    || error instanceof RuntimeSessionHintError
  ) {
    return res.status(error.status).json({ error: 'invalid_hosted_app_request', message: error.message });
  }
  const known = error instanceof HostedAppControlPlaneError
    ? error
    : parseWorkerFailure(error);
  if (known) {
    return res.status(known.status).json({
      error: known.code,
      message: known.message,
      retryable: known.transient,
    });
  }
  return res.status(503).json({
    error: 'hosted_app_operation_failed',
    message: 'Hosted app operation failed',
    retryable: true,
  });
}

router.post('/', async (req: AuthenticatedRequest, res) => {
  if (unavailable(res)) return;
  try {
    const parsed = parseHostedAppStartRequest(req.body);
    const resolved = target(req, parsed.spec.app_id, parsed.runtimeSessionHint);
    const result = await submitHostedAppJob('hosted-app:start', {
      operation: 'start',
      hostedAppRuntimeId: resolved.hostedAppRuntimeId,
      sourceRuntimeSessionId: resolved.sourceRuntimeSessionId,
      tenantId: resolved.identity.tenantId,
      canonicalUserId: resolved.identity.canonicalUserId,
      spec: parsed.spec,
      _otel: captureTraceCarrier(),
    });
    return res.status(200).json(presentStatus(result, {
      tenantId: resolved.identity.tenantId,
      canonicalUserId: resolved.identity.canonicalUserId,
    }));
  } catch (error) {
    return sendFailure(error, res);
  }
});

router.get('/:appId', async (req: AuthenticatedRequest, res) => {
  if (unavailable(res)) return;
  try {
    const resolved = target(req, req.params.appId, req.query.runtime_session_hint);
    const record = await readRuntimeSessionRecord(resolved.hostedAppRuntimeId);
    if (!record?.hosted_app) {
      throw new HostedAppControlPlaneError('hosted_app_not_found', 'Hosted app not found', 404);
    }
    assertHostedAppOwned(record, {
      tenantId: resolved.identity.tenantId,
      canonicalUserId: resolved.identity.canonicalUserId,
    }, resolved.sourceRuntimeSessionId);
    return res.status(200).json(presentStatus(hostedAppPublicStatus(record), {
      tenantId: resolved.identity.tenantId,
      canonicalUserId: resolved.identity.canonicalUserId,
    }));
  } catch (error) {
    return sendFailure(error, res);
  }
});

router.delete('/:appId', async (req: AuthenticatedRequest, res) => {
  if (unavailable(res)) return;
  try {
    const resolved = target(req, req.params.appId, req.query.runtime_session_hint);
    const result = await submitHostedAppJob('hosted-app:stop', {
      operation: 'stop',
      hostedAppRuntimeId: resolved.hostedAppRuntimeId,
      tenantId: resolved.identity.tenantId,
      canonicalUserId: resolved.identity.canonicalUserId,
      _otel: captureTraceCarrier(),
    });
    return res.status(200).json(result);
  } catch (error) {
    return sendFailure(error, res);
  }
});

export default router;
