import { nanoid } from 'nanoid';
import { Router } from 'express';
import type * as t from '../types';
import { checkServiceShutDown, checkServiceStartUp } from '../lifecycle';
import { env } from '../config';
import { getPrincipalOrReject } from '../auth/principal';
import {
  NpmUnitValidationError,
  validateNpmUnitRequest,
  type NpmUnitFailure,
  type NpmUnitRequest,
  type NpmUnitResponse,
} from '../npm-unit-contract';
import {
  buildNpmUnitDispatchRequest,
  dispatchNpmUnitOverHttp,
} from '../npm-unit-dispatch';
import logger from '../logger';

const router = Router();

function responseStatus(body: NpmUnitResponse): number {
  if (!('error' in body)) return 200;
  if (body.error === 'not_publicly_fetchable') return 404;
  if (body.error === 'too_large' || body.error === 'decompression_limit') return 413;
  if (body.error === 'integrity_mismatch' || body.error === 'unsafe_entry' || body.error === 'parse_failed') return 422;
  if (body.error === 'timeout') return 504;
  if (body.error === 'invalid_request' || body.error === 'unsupported_registry') return 400;
  if (body.error === 'disabled') return 503;
  return body.retryable ? 503 : 502;
}

router.post('/sandbox/npm-unit', async (req: t.AuthenticatedRequest, res) => {
  const principal = getPrincipalOrReject(req, res);
  if (!principal) return;
  if (!env.NPM_UNIT_ENABLED) {
    const body: NpmUnitFailure = {
      error: 'disabled',
      message: 'npm unit indexing is disabled',
      retryable: false,
    };
    return res.status(503).json(body);
  }
  if (env.SANDBOX_BACKEND !== 'http') {
    const body: NpmUnitFailure = {
      error: 'sandbox_unavailable',
      message: 'npm unit indexing currently requires the stateless HTTP sandbox backend',
      retryable: false,
    };
    return res.status(501).json(body);
  }
  if (checkServiceShutDown()) {
    return res.status(503).json({ error: 'sandbox_unavailable', message: 'Service is shutting down', retryable: true });
  }
  if (checkServiceStartUp()) {
    return res.status(503).json({ error: 'sandbox_unavailable', message: 'Service is starting up', retryable: true });
  }

  let request: NpmUnitRequest;
  try {
    request = validateNpmUnitRequest(req.body);
  } catch (error) {
    if (error instanceof NpmUnitValidationError) {
      return res.status(400).json({ error: error.code, message: error.message, retryable: false });
    }
    throw error;
  }

  const executionId = nanoid();
  const controller = new AbortController();
  const abort = () => controller.abort();
  req.once('aborted', abort);
  res.once('close', abort);
  try {
    const result = await dispatchNpmUnitOverHttp(buildNpmUnitDispatchRequest({
      request,
      executionId,
    }), controller.signal);
    if (res.writableEnded || controller.signal.aborted) return;
    return res.status(responseStatus(result)).json(result);
  } catch (error) {
    if (!controller.signal.aborted) logger.error('npm unit request failed', { executionId, error });
    if (res.writableEnded || controller.signal.aborted) return;
    return res.status(503).json({
      error: 'sandbox_unavailable',
      message: 'npm unit sandbox was unavailable',
      retryable: true,
    });
  } finally {
    req.off('aborted', abort);
    res.off('close', abort);
  }
});

export default router;
