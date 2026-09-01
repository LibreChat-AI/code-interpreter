import axios from 'axios';
import { env } from './config';
import type { ExecutionManifestClaims } from './execution-manifest';
import { CODEAPI_SYNTHETIC_INTERNAL_REQUEST_HEADER } from './internal-synthetic';
import { internalServiceHeaders } from './internal-service-auth';
import { injectTraceHeaders, normalizeTracePath, withSpan } from './telemetry';
import type * as t from './types';
import type { NpmUnitRequest } from './npm-unit-contract';

type GatewayRequestOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
  isSynthetic?: boolean;
};

export interface GatewayPreparedEgress {
  grant_id: string;
  payload: t.PayloadBody;
  egressGrantToken: string;
  executionManifestClaims: ExecutionManifestClaims;
}

function gatewayUrl(path: string): string {
  if (!env.EGRESS_GATEWAY_URL.trim()) {
    throw new Error('EGRESS_GATEWAY_URL is required for hardened sandbox egress');
  }
  return `${env.EGRESS_GATEWAY_URL.replace(/\/+$/, '')}${path}`;
}

function gatewayHeaders(headers: Record<string, string>, isSynthetic?: boolean): Record<string, string> {
  const resolved = internalServiceHeaders(headers);
  if (isSynthetic === true) {
    resolved[CODEAPI_SYNTHETIC_INTERNAL_REQUEST_HEADER] = 'true';
  }
  return resolved;
}

export async function createGatewayEgressGrant(args: {
  payload: t.PayloadBody;
  claims: ExecutionManifestClaims;
  isSynthetic?: boolean;
  signal?: AbortSignal;
}): Promise<GatewayPreparedEgress> {
  const { signal, isSynthetic, ...body } = args;
  const response = await withSpan('codeapi.egress_grant.create', {
    'http.request.method': 'POST',
    'url.path': '/internal/egress-grants',
  }, () => axios.post<GatewayPreparedEgress>(
    gatewayUrl('/internal/egress-grants'),
    body,
    {
      headers: injectTraceHeaders(gatewayHeaders({ 'Content-Type': 'application/json' }, isSynthetic)),
      signal,
      timeout: env.EGRESS_GATEWAY_REQUEST_TIMEOUT_MS,
    },
  ), 'CLIENT');
  return response.data;
}

export async function restoreGatewaySandboxResult<T extends { session_id: string; files?: t.FileRefs }>(args: {
  grantId?: string;
  egressGrantToken: string;
  result: T;
  isSynthetic?: boolean;
  signal?: AbortSignal;
}): Promise<T> {
  const path = args.grantId
    ? `/internal/egress-grants/${encodeURIComponent(args.grantId)}/restore-result`
    : '/internal/egress-grants/restore-result';
  const response = await withSpan('codeapi.egress_grant.restore_result', {
    'http.request.method': 'POST',
    'url.path': normalizeTracePath(path),
  }, () => axios.post<{ result: T }>(
    gatewayUrl(path),
    { result: args.result, egressGrantToken: args.egressGrantToken },
    {
      headers: injectTraceHeaders(gatewayHeaders({ 'Content-Type': 'application/json' }, args.isSynthetic)),
      signal: args.signal,
      timeout: env.EGRESS_GATEWAY_REQUEST_TIMEOUT_MS,
    },
  ), 'CLIENT');
  return response.data.result;
}

export async function revokeGatewayEgressGrant(args: {
  grantId?: string;
  egressGrantToken?: string;
  isSynthetic?: boolean;
  reason: string;
  timeoutMs?: number;
}): Promise<void> {
  if (!args.grantId && !args.egressGrantToken) {
    throw new Error('grantId or egressGrantToken is required to revoke egress grant');
  }
  const path = args.grantId
    ? `/internal/egress-grants/${encodeURIComponent(args.grantId)}/revoke`
    : '/internal/egress-grants/revoke';
  const body = args.grantId
    ? { reason: args.reason }
    : { reason: args.reason, egressGrantToken: args.egressGrantToken };
  await withSpan('codeapi.egress_grant.revoke', {
    'http.request.method': 'POST',
    'url.path': normalizeTracePath(path),
    'codeapi.revoke_reason': args.reason,
  }, () => axios.post(
    gatewayUrl(path),
    body,
    {
      headers: injectTraceHeaders(gatewayHeaders({ 'Content-Type': 'application/json' }, args.isSynthetic)),
      timeout: args.timeoutMs ?? env.EGRESS_GATEWAY_REVOKE_TIMEOUT_MS,
    },
  ), 'CLIENT');
}

export async function createGatewayPtcCallbackToken(args: {
  executionId: string;
  sessionId: string;
  callbackToken: string;
  timeoutSeconds: number;
  allowedToolNames: string[];
}, options: GatewayRequestOptions = {}): Promise<string> {
  const response = await withSpan('codeapi.ptc_callback_token.create', {
    'http.request.method': 'POST',
    'url.path': '/internal/ptc-callback-token',
  }, () => axios.post<{ callbackToken: string }>(
    gatewayUrl('/internal/ptc-callback-token'),
    args,
    {
      headers: injectTraceHeaders(internalServiceHeaders({ 'Content-Type': 'application/json' })),
      signal: options.signal,
      timeout: options.timeoutMs ?? env.EGRESS_GATEWAY_REQUEST_TIMEOUT_MS,
    },
  ), 'CLIENT');
  return response.data.callbackToken;
}

export async function createGatewayNpmTarballToken(args: {
  executionId: string;
  request: NpmUnitRequest;
  isSynthetic?: boolean;
  signal?: AbortSignal;
}): Promise<{ fetchToken: string; expiresAt: number }> {
  const response = await withSpan('codeapi.npm_tarball_token.create', {
    'http.request.method': 'POST',
    'url.path': '/internal/npm-tarball-tokens',
  }, () => axios.post<{ fetchToken: string; expiresAt: number }>(
    gatewayUrl('/internal/npm-tarball-tokens'),
    { executionId: args.executionId, request: args.request },
    {
      headers: injectTraceHeaders(gatewayHeaders({ 'Content-Type': 'application/json' }, args.isSynthetic)),
      signal: args.signal,
      timeout: env.EGRESS_GATEWAY_REQUEST_TIMEOUT_MS,
    },
  ), 'CLIENT');
  return response.data;
}
