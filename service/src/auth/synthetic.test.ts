import { afterEach, describe, expect, test } from 'bun:test';
import type { Request } from 'express';
import {
    authenticateSyntheticRequest,
    buildSyntheticPrincipal,
    CODEAPI_SYNTHETIC_AUTH_HEADER,
    CODEAPI_SYNTHETIC_PRINCIPAL_SOURCE,
    hasSyntheticAccessToken,
    isSyntheticExecRequest,
    isSyntheticPrincipalSource,
    validateSyntheticAccessTokenConfig,
} from './synthetic';

const validToken = 'x'.repeat(32);

function req(
    headers: Record<string, string> = {},
    overrides: Partial<Request> = {},
): Request {
    const lowerHeaders = Object.fromEntries(
        Object.entries(headers).map(([key, value]) => [
            key.toLowerCase(),
            value,
        ]),
    );
    return {
        method: 'POST',
        path: '/exec',
        originalUrl: '/v1/exec',
        url: '/exec',
        header: (name: string) => lowerHeaders[name.toLowerCase()],
        ...overrides,
    } as unknown as Request;
}

afterEach(() => {
    delete process.env.CODEAPI_SYNTHETIC_USER_ID;
    delete process.env.CODEAPI_SYNTHETIC_TENANT_ID;
});

describe('synthetic CodeAPI auth', () => {
    test('is absent when the synthetic header is not present', () => {
        expect(hasSyntheticAccessToken(req())).toBe(false);
        expect(authenticateSyntheticRequest(req(), validToken)).toBeNull();
    });

    test('authenticates POST /v1/exec with the configured token', () => {
        const result = authenticateSyntheticRequest(
            req({ [CODEAPI_SYNTHETIC_AUTH_HEADER]: validToken }),
            validToken,
        );

        expect(result).toMatchObject({
            ok: true,
            principal: {
                userId: 'synthetic-tests',
                tenantId: 'synthetic',
                principalSource: CODEAPI_SYNTHETIC_PRINCIPAL_SOURCE,
            },
        });
        expect(
            result?.ok === true ? result.principal.authContextHash : '',
        ).toHaveLength(64);
    });

    test('recognizes mounted and unmounted exec paths', () => {
        expect(isSyntheticExecRequest(req())).toBe(true);
        expect(
            isSyntheticExecRequest(
                req({}, { path: '/exec', originalUrl: '/exec' }),
            ),
        ).toBe(true);
    });

    test('rejects synthetic auth outside exec', () => {
        const result = authenticateSyntheticRequest(
            req(
                { [CODEAPI_SYNTHETIC_AUTH_HEADER]: validToken },
                { method: 'GET', path: '/health', originalUrl: '/v1/health' },
            ),
            validToken,
        );

        expect(result).toMatchObject({
            ok: false,
            status: 403,
            reason: 'not_allowed',
        });
    });

    test('rejects missing and invalid configured tokens', () => {
        expect(
            authenticateSyntheticRequest(
                req({ [CODEAPI_SYNTHETIC_AUTH_HEADER]: validToken }),
                null,
            ),
        ).toMatchObject({ ok: false, status: 401, reason: 'missing_config' });
        expect(
            authenticateSyntheticRequest(
                req({ [CODEAPI_SYNTHETIC_AUTH_HEADER]: validToken }),
                'wrong'.repeat(8),
            ),
        ).toMatchObject({ ok: false, status: 401, reason: 'invalid_token' });
    });

    test('fails closed when configured token is weak', () => {
        expect(
            authenticateSyntheticRequest(
                req({ [CODEAPI_SYNTHETIC_AUTH_HEADER]: 'weak-token' }),
                'weak-token',
            ),
        ).toMatchObject({ ok: false, status: 500, reason: 'weak_config' });
        expect(() => validateSyntheticAccessTokenConfig('weak-token')).toThrow(
            'CODEAPI_SYNTHETIC_ACCESS_TOKEN must be at least 32 bytes',
        );
    });

    test('supports explicit synthetic identity overrides', () => {
        process.env.CODEAPI_SYNTHETIC_USER_ID = 'canary-user';
        process.env.CODEAPI_SYNTHETIC_TENANT_ID = 'canary-tenant';

        expect(buildSyntheticPrincipal()).toMatchObject({
            userId: 'canary-user',
            tenantId: 'canary-tenant',
            principalSource: CODEAPI_SYNTHETIC_PRINCIPAL_SOURCE,
        });
    });

    test('identifies synthetic principal sources for log suppression', () => {
        expect(
            isSyntheticPrincipalSource(CODEAPI_SYNTHETIC_PRINCIPAL_SOURCE),
        ).toBe(true);
        expect(isSyntheticPrincipalSource('librechat_jwt')).toBe(false);
        expect(isSyntheticPrincipalSource(undefined)).toBe(false);
    });
});
