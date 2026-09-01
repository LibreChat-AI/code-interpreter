import axios from 'axios';
import { env } from './config';
import { createGatewayNpmTarballToken } from './egress-gateway-client';
import {
  EXECUTION_MANIFEST_VERSION,
  executionManifestBodySha256,
  signExecutionManifestWithKey,
  type ExecutionManifestClaims,
} from './execution-manifest';
import { internalServiceHeaders } from './internal-service-auth';
import {
  NpmUnitValidationError,
  validateNpmUnitRequest,
  type NpmUnitFailure,
  type NpmUnitRequest,
  type NpmUnitResponse,
} from './npm-unit-contract';
import { getAxiosErrorDetails } from './utils';
import { injectTraceHeaders, withSpan } from './telemetry';
import logger from './logger';

export interface NpmUnitDispatchRequest {
  executionId: string;
  request: NpmUnitRequest;
}

const EXECUTION_ID_RE = /^[A-Za-z0-9_-]{10,64}$/;

export function buildNpmUnitDispatchRequest(args: {
  executionId: string;
  request: NpmUnitRequest;
}): NpmUnitDispatchRequest {
  return {
    executionId: args.executionId,
    request: args.request,
  };
}

function requiredString(value: unknown, name: string, pattern?: RegExp): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128 || (pattern && !pattern.test(value))) {
    throw new NpmUnitValidationError(`${name} is invalid`);
  }
  return value;
}

export function validateNpmUnitDispatchRequest(value: unknown): NpmUnitDispatchRequest {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new NpmUnitValidationError('dispatch body must be an object');
  }
  const body = value as Record<string, unknown>;
  const allowed = new Set(['executionId', 'request']);
  const unknown = Object.keys(body).filter(key => !allowed.has(key));
  if (unknown.length > 0) throw new NpmUnitValidationError(`unknown dispatch field: ${unknown[0]}`);
  return {
    executionId: requiredString(body.executionId, 'executionId', EXECUTION_ID_RE),
    request: validateNpmUnitRequest(body.request),
  };
}

function structuredFailure(error: unknown): NpmUnitFailure | undefined {
  if (!axios.isAxiosError(error)) return undefined;
  const data = error.response?.data;
  if (data == null || typeof data !== 'object' || Array.isArray(data)) return undefined;
  const body = data as Record<string, unknown>;
  if (typeof body.error !== 'string' || typeof body.message !== 'string' || typeof body.retryable !== 'boolean') {
    return undefined;
  }
  const failure: NpmUnitFailure = {
    error: body.error as NpmUnitFailure['error'],
    message: body.message,
    retryable: body.retryable,
  };
  if (body.rejected && typeof body.rejected === 'object' && !Array.isArray(body.rejected)) {
    failure.rejected = body.rejected as NpmUnitFailure['rejected'];
  }
  if (body.usage && typeof body.usage === 'object' && !Array.isArray(body.usage)) {
    failure.usage = body.usage as NpmUnitFailure['usage'];
  }
  return failure;
}

let activeDispatches = 0;

/**
 * Runs one request synchronously. Capacity is deliberately fail-fast rather
 * than queued: callers retain ownership of retries and this service persists
 * no npm-unit job or result state.
 */
export async function processNpmUnitDispatch(
  raw: NpmUnitDispatchRequest,
  callerSignal?: AbortSignal,
): Promise<NpmUnitResponse> {
  let input: NpmUnitDispatchRequest;
  try {
    input = validateNpmUnitDispatchRequest(raw);
  } catch (error) {
    return {
      error: error instanceof NpmUnitValidationError ? error.code : 'invalid_request',
      message: error instanceof Error ? error.message : 'invalid dispatch request',
      retryable: false,
    };
  }
  if (!env.NPM_UNIT_ENABLED) {
    return { error: 'disabled', message: 'npm unit indexing is disabled', retryable: false };
  }
  if (env.SANDBOX_BACKEND !== 'http') {
    return {
      error: 'sandbox_unavailable',
      message: 'npm unit indexing currently requires the stateless HTTP sandbox backend',
      retryable: false,
    };
  }
  if (activeDispatches >= env.NPM_UNIT_CONCURRENCY) {
    return {
      error: 'sandbox_unavailable',
      message: 'npm unit sandbox is at capacity',
      retryable: true,
    };
  }

  activeDispatches += 1;
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, env.NPM_UNIT_REQUEST_TIMEOUT);
  const abortFromCaller = () => controller.abort();
  callerSignal?.addEventListener('abort', abortFromCaller, { once: true });
  if (callerSignal?.aborted) controller.abort();

  try {
    return await withSpan('codeapi.npm_unit.dispatch', {
      'codeapi.language': 'npm-unit',
      'codeapi.dispatch_mode': 'direct',
    }, async () => {
      const { fetchToken } = await createGatewayNpmTarballToken({
        executionId: input.executionId,
        request: input.request,
        signal: controller.signal,
      });
      const body: Record<string, unknown> = {
        execution_id: input.executionId,
        ...input.request,
        fetch_token: fetchToken,
      };
      if (env.EXECUTION_MANIFEST_PRIVATE_KEY || env.EXECUTION_MANIFEST_SECRET) {
        const now = Math.floor(Date.now() / 1000);
        const claims: ExecutionManifestClaims = {
          v: EXECUTION_MANIFEST_VERSION,
          operation: 'npm-unit',
          exec_id: input.executionId,
          /* npm-unit is a public, stateless pure-function route. These
           * execution-scoped labels satisfy the common manifest schema
           * without carrying tenant- or user-correlated data into the
           * sandbox control plane. */
          tenant_id: `npm-unit:${input.executionId}`,
          user_id: `npm-unit:${input.executionId}`,
          session_key: `npm-unit:${input.executionId}`,
          input_files: [],
          read_sessions: [],
          output_session_id: `npm-unit:${input.executionId}`,
          max_upload_bytes: 0,
          max_output_files: 0,
          max_requests: 1,
          iat: now,
          exp: now + env.EXECUTION_MANIFEST_TTL_SECONDS,
          execute_body_sha256: executionManifestBodySha256(body),
          principal_source: 'npm-unit',
        };
        body.execution_manifest = signExecutionManifestWithKey(claims, {
          privateKey: env.EXECUTION_MANIFEST_PRIVATE_KEY,
          secret: env.EXECUTION_MANIFEST_SECRET,
        });
      }

      try {
        const response = await axios.post<NpmUnitResponse>(
          `${env.SANDBOX_ENDPOINT.replace(/\/+$/, '')}/npm-unit`,
          body,
          {
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal,
            timeout: env.NPM_UNIT_REQUEST_TIMEOUT,
          },
        );
        return response.data;
      } catch (error) {
        const failure = structuredFailure(error);
        if (failure) return failure;
        if (timedOut || controller.signal.aborted) {
          return { error: 'timeout', message: 'npm unit request exceeded its wall-clock limit', retryable: true };
        }
        logger.error('npm unit sandbox request failed', {
          error: getAxiosErrorDetails(error),
          executionId: input.executionId,
        });
        return { error: 'sandbox_unavailable', message: 'npm unit sandbox was unavailable', retryable: true };
      }
    }, 'INTERNAL');
  } catch (error) {
    const failure = structuredFailure(error);
    if (failure) return failure;
    if (timedOut || controller.signal.aborted) {
      return { error: 'timeout', message: 'npm unit request exceeded its wall-clock limit', retryable: true };
    }
    logger.error('npm unit direct dispatch failed', {
      error: getAxiosErrorDetails(error),
      executionId: input.executionId,
    });
    return { error: 'sandbox_unavailable', message: 'npm unit sandbox was unavailable', retryable: true };
  } finally {
    clearTimeout(timeout);
    callerSignal?.removeEventListener('abort', abortFromCaller);
    activeDispatches -= 1;
  }
}

export async function dispatchNpmUnitOverHttp(
  input: NpmUnitDispatchRequest,
  signal?: AbortSignal,
): Promise<NpmUnitResponse> {
  if (!env.NPM_UNIT_DISPATCH_URL.trim()) return processNpmUnitDispatch(input, signal);
  try {
    const response = await withSpan('codeapi.npm_unit.forward', {
      'http.request.method': 'POST',
      'url.path': '/internal/npm-unit',
    }, () => axios.post<NpmUnitResponse>(
      env.NPM_UNIT_DISPATCH_URL,
      input,
      {
        headers: injectTraceHeaders(internalServiceHeaders({ 'Content-Type': 'application/json' })),
        signal,
        timeout: env.NPM_UNIT_REQUEST_TIMEOUT + 1_000,
      },
    ), 'CLIENT');
    return response.data;
  } catch (error) {
    if (signal?.aborted) throw error;
    const failure = structuredFailure(error);
    if (failure) return failure;
    if (axios.isAxiosError(error) && error.code === 'ECONNABORTED') {
      return { error: 'timeout', message: 'npm unit request exceeded its wall-clock limit', retryable: true };
    }
    throw error;
  }
}
