import {
    buildExecutionManifestClaims,
    maybeBuildExecutionManifestClaims,
} from './execution-manifest-claims';
import { env } from './config';
import { createGatewayPtcCallbackToken } from './egress-gateway-client';
import type { ExecutionManifestClaims } from './execution-manifest';
import type * as t from './types';

export type SandboxJobSecurity = {
    payload: t.PayloadBody;
    executionManifestClaims?: ExecutionManifestClaims;
    egressGrantClaims?: ExecutionManifestClaims;
    egressGrantToken?: string;
};

type BuildArgs = Parameters<typeof buildExecutionManifestClaims>[0];

const MISSING_EGRESS_GATEWAY_ERROR =
    'EGRESS_GATEWAY_URL is required when hardened sandbox mode or egress grant secret is configured';

export function prepareSandboxJobSecurity(args: BuildArgs): SandboxJobSecurity {
    const egressGatewayUrl = env.EGRESS_GATEWAY_URL.trim();
    const egressGrantMode =
        env.HARDENED_SANDBOX_MODE || env.EGRESS_GRANT_SECRET.trim() !== '';

    if (!egressGrantMode) {
        return {
            payload: args.payload,
            executionManifestClaims: maybeBuildExecutionManifestClaims(args),
        };
    }

    if (egressGatewayUrl === '') {
        throw new Error(MISSING_EGRESS_GATEWAY_ERROR);
    }

    const rawClaims = buildExecutionManifestClaims(args);

    return {
        payload: args.payload,
        egressGrantClaims: rawClaims,
    };
}

export function refreshEgressGrantClaims(
    claims: ExecutionManifestClaims,
    nowSeconds: number,
    ttlSeconds = env.EGRESS_GRANT_TTL_SECONDS,
): ExecutionManifestClaims {
    return {
        ...claims,
        iat: nowSeconds,
        exp: nowSeconds + ttlSeconds,
    };
}

export function normalizeEgressGatewayUrl(rawUrl: string): string {
    const url = rawUrl.trim().replace(/\/+$/, '');
    if (!url) {
        throw new Error(
            'EGRESS_GATEWAY_URL is required for sandbox-originated PTC callbacks',
        );
    }
    return url;
}

export function timeoutMsToGrantSeconds(timeoutMs: number): number {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return 1;
    return Math.max(1, Math.ceil(timeoutMs / 1000));
}

const DEFAULT_PROGRAMMATIC_TIMEOUT_MS = 300000;

export function normalizeProgrammaticTimeoutMs(
    rawTimeout: unknown,
    maxTimeoutMs = env.JOB_TIMEOUT,
    defaultTimeoutMs = DEFAULT_PROGRAMMATIC_TIMEOUT_MS,
): number {
    const maxTimeout = Math.max(1, Math.floor(maxTimeoutMs));
    const defaultTimeout = Math.min(
        Math.max(1, Math.floor(defaultTimeoutMs)),
        maxTimeout,
    );
    if (rawTimeout === undefined || rawTimeout === null) return defaultTimeout;
    if (
        typeof rawTimeout !== 'number' ||
        !Number.isFinite(rawTimeout) ||
        rawTimeout <= 0
    ) {
        throw new Error('timeout must be a positive number of milliseconds');
    }
    return Math.min(Math.ceil(rawTimeout), maxTimeout);
}

export async function sealPtcCallbackTokenForGateway(args: {
    executionId: string;
    sessionId: string;
    callbackToken: string;
    timeoutSeconds: number;
    allowedToolNames: string[];
}): Promise<string> {
    return createGatewayPtcCallbackToken({
        executionId: args.executionId,
        sessionId: args.sessionId,
        callbackToken: args.callbackToken,
        timeoutSeconds: args.timeoutSeconds,
        allowedToolNames: args.allowedToolNames,
    });
}
