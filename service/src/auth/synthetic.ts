import { createHash, timingSafeEqual } from 'crypto';
import type { Request } from 'express';
import type { CodeApiPrincipal } from './principal';

export const CODEAPI_SYNTHETIC_AUTH_HEADER = 'X-CodeAPI-Synthetic-Token';
export const CODEAPI_SYNTHETIC_PRINCIPAL_SOURCE = 'synthetic_test';
export const MIN_SYNTHETIC_ACCESS_TOKEN_BYTES = 32;

type SyntheticAuthRequest = Pick<
    Request,
    'header' | 'method' | 'path' | 'originalUrl' | 'url'
>;

export type SyntheticAuthResult =
    | {
          ok: true;
          principal: CodeApiPrincipal;
      }
    | {
          ok: false;
          status: number;
          error: string;
          reason:
              | 'not_allowed'
              | 'missing_config'
              | 'weak_config'
              | 'invalid_token';
      };

function nonEmpty(value: string | null | undefined): string | null {
    if (value == null) {
        return null;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function pathWithoutQuery(path: string | undefined): string {
    return (path ?? '').split('?')[0] ?? '';
}

function syntheticPrincipalHash(userId: string, tenantId: string): string {
    return createHash('sha256')
        .update(`${CODEAPI_SYNTHETIC_PRINCIPAL_SOURCE}:${tenantId}:${userId}`)
        .digest('hex');
}

function timingSafeStringEquals(a: string, b: string): boolean {
    const aBytes = Buffer.from(a);
    const bBytes = Buffer.from(b);
    if (aBytes.length !== bBytes.length) {
        return false;
    }
    return timingSafeEqual(aBytes, bBytes);
}

export function getSyntheticAccessToken(
    req: SyntheticAuthRequest,
): string | null {
    return nonEmpty(req.header(CODEAPI_SYNTHETIC_AUTH_HEADER));
}

export function hasSyntheticAccessToken(req: SyntheticAuthRequest): boolean {
    return getSyntheticAccessToken(req) !== null;
}

export function isSyntheticPrincipalSource(source: unknown): boolean {
    return source === CODEAPI_SYNTHETIC_PRINCIPAL_SOURCE;
}

export function validateSyntheticAccessTokenConfig(
    token: string | null | undefined = process.env
        .CODEAPI_SYNTHETIC_ACCESS_TOKEN,
): void {
    const configuredToken = nonEmpty(token);
    if (configuredToken === null) {
        return;
    }

    if (Buffer.byteLength(configuredToken) < MIN_SYNTHETIC_ACCESS_TOKEN_BYTES) {
        throw new Error(
            `CODEAPI_SYNTHETIC_ACCESS_TOKEN must be at least ${MIN_SYNTHETIC_ACCESS_TOKEN_BYTES} bytes`,
        );
    }
}

export function isSyntheticExecRequest(req: SyntheticAuthRequest): boolean {
    if (req.method.toUpperCase() !== 'POST') {
        return false;
    }

    const path = pathWithoutQuery(req.path || req.url);
    const originalPath = pathWithoutQuery(req.originalUrl);
    return path === '/exec' || originalPath === '/v1/exec';
}

export function buildSyntheticPrincipal(
    userId = nonEmpty(process.env.CODEAPI_SYNTHETIC_USER_ID) ??
        'synthetic-tests',
    tenantId = nonEmpty(process.env.CODEAPI_SYNTHETIC_TENANT_ID) ?? 'synthetic',
): CodeApiPrincipal {
    return {
        userId,
        tenantId,
        principalSource: CODEAPI_SYNTHETIC_PRINCIPAL_SOURCE,
        authContextHash: syntheticPrincipalHash(userId, tenantId),
    };
}

export function authenticateSyntheticRequest(
    req: SyntheticAuthRequest,
    configuredToken: string | null | undefined = process.env
        .CODEAPI_SYNTHETIC_ACCESS_TOKEN,
): SyntheticAuthResult | null {
    const presentedToken = getSyntheticAccessToken(req);
    if (presentedToken === null) {
        return null;
    }

    if (!isSyntheticExecRequest(req)) {
        return {
            ok: false,
            status: 403,
            error: 'Synthetic auth is only allowed for CodeAPI exec',
            reason: 'not_allowed',
        };
    }

    const expectedToken = nonEmpty(configuredToken);
    if (expectedToken === null) {
        return {
            ok: false,
            status: 401,
            error: 'Synthetic auth is not configured',
            reason: 'missing_config',
        };
    }

    if (Buffer.byteLength(expectedToken) < MIN_SYNTHETIC_ACCESS_TOKEN_BYTES) {
        return {
            ok: false,
            status: 500,
            error: 'CodeAPI synthetic auth is misconfigured',
            reason: 'weak_config',
        };
    }

    if (!timingSafeStringEquals(presentedToken, expectedToken)) {
        return {
            ok: false,
            status: 401,
            error: 'Invalid synthetic token',
            reason: 'invalid_token',
        };
    }

    return {
        ok: true,
        principal: buildSyntheticPrincipal(),
    };
}
