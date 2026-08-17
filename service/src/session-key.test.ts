import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import type * as t from './types';
import {
    resolveSessionKey,
    resolveOutputBucketSessionKey,
    parseUploadSessionKeyInput,
    SessionKeyResolutionError,
} from './session-key';

const USER_ID = 'user_123';
const TENANT_ID = 'tenant_abc';
const SKILL_ID = 'skill_123456789012345';

function request(authContext?: t.CodeApiAuthContext): t.AuthenticatedRequest {
    return { codeApiAuthContext: authContext } as t.AuthenticatedRequest;
}

/* Tenant isolation env is read live from `process.env` per call,
 * so toggling env vars between tests is sufficient — no module
 * cache surgery needed. */
describe('CODEAPI_TENANT_ISOLATION_STRICT', () => {
    const originalStrictEnv = process.env.CODEAPI_TENANT_ISOLATION_STRICT;
    const originalSingleTenantEnv = process.env.CODEAPI_JWT_SINGLE_TENANT_ID;

    beforeEach(() => {
        delete process.env.CODEAPI_TENANT_ISOLATION_STRICT;
        delete process.env.CODEAPI_JWT_SINGLE_TENANT_ID;
    });

    afterEach(() => {
        if (originalStrictEnv === undefined) {
            delete process.env.CODEAPI_TENANT_ISOLATION_STRICT;
        } else {
            process.env.CODEAPI_TENANT_ISOLATION_STRICT = originalStrictEnv;
        }
        if (originalSingleTenantEnv === undefined) {
            delete process.env.CODEAPI_JWT_SINGLE_TENANT_ID;
        } else {
            process.env.CODEAPI_JWT_SINGLE_TENANT_ID = originalSingleTenantEnv;
        }
    });

    test('non-strict (default): missing tenantId falls back to "legacy"', () => {
        const req = request({ userId: USER_ID });
        const key = resolveSessionKey(req, {
            kind: 'skill',
            id: SKILL_ID,
            version: 1,
        });
        expect(key).toBe(`legacy:skill:${SKILL_ID}:v:1`);
    });

    test('non-strict (default): output bucket also falls back to "legacy"', () => {
        const req = request({ userId: USER_ID });
        const key = resolveOutputBucketSessionKey(req);
        expect(key).toBe(`legacy:user:${USER_ID}`);
    });

    test('non-strict (default): missing tenantId uses configured single-tenant namespace', () => {
        process.env.CODEAPI_JWT_SINGLE_TENANT_ID = 'local-single-tenant';
        const req = request({ userId: USER_ID });
        const key = resolveSessionKey(req, {
            kind: 'skill',
            id: SKILL_ID,
            version: 1,
        });
        expect(key).toBe(`local-single-tenant:skill:${SKILL_ID}:v:1`);
    });

    test('strict mode: missing tenantId throws 500', () => {
        process.env.CODEAPI_TENANT_ISOLATION_STRICT = 'true';
        const req = request({ userId: USER_ID });
        try {
            resolveSessionKey(req, { kind: 'skill', id: SKILL_ID, version: 1 });
            throw new Error('expected SessionKeyResolutionError');
        } catch (err) {
            expect(err).toBeInstanceOf(SessionKeyResolutionError);
            expect((err as SessionKeyResolutionError).status).toBe(500);
        }
    });

    test('strict mode: tenantId present resolves normally', () => {
        process.env.CODEAPI_TENANT_ISOLATION_STRICT = 'true';
        const req = request({ tenantId: TENANT_ID, userId: USER_ID });
        const key = resolveSessionKey(req, {
            kind: 'skill',
            id: SKILL_ID,
            version: 1,
        });
        expect(key).toBe(`${TENANT_ID}:skill:${SKILL_ID}:v:1`);
    });

    test('strict mode also gates output bucket: missing tenantId throws 500', () => {
        process.env.CODEAPI_TENANT_ISOLATION_STRICT = 'true';
        const req = request({ userId: USER_ID });
        try {
            resolveOutputBucketSessionKey(req);
            throw new Error('expected SessionKeyResolutionError');
        } catch (err) {
            expect(err).toBeInstanceOf(SessionKeyResolutionError);
            expect((err as SessionKeyResolutionError).status).toBe(500);
        }
    });
});

describe('parseUploadSessionKeyInput', () => {
    test('parses valid skill upload form fields', () => {
        const input = parseUploadSessionKeyInput({
            kind: 'skill',
            id: SKILL_ID,
            version: '7',
            authContextUserId: USER_ID,
        });
        expect(input).toEqual({ kind: 'skill', id: SKILL_ID, version: 7 });
    });

    test('parses valid agent upload form fields', () => {
        const input = parseUploadSessionKeyInput({
            kind: 'agent',
            id: 'agent_123456789012345',
            version: undefined,
            authContextUserId: USER_ID,
        });
        expect(input).toEqual({ kind: 'agent', id: 'agent_123456789012345' });
    });

    test('parses valid user upload with explicit id', () => {
        const input = parseUploadSessionKeyInput({
            kind: 'user',
            id: USER_ID,
            version: undefined,
            authContextUserId: USER_ID,
        });
        expect(input.kind).toBe('user');
        expect(input.id).toBe(USER_ID);
    });

    test('falls back to authContextUserId when id is missing on kind: user', () => {
        const input = parseUploadSessionKeyInput({
            kind: 'user',
            id: undefined,
            version: undefined,
            authContextUserId: USER_ID,
        });
        expect(input).toEqual({ kind: 'user', id: USER_ID });
    });

    test('rejects missing kind as 400', () => {
        expect(() =>
            parseUploadSessionKeyInput({
                kind: undefined,
                id: USER_ID,
                version: undefined,
                authContextUserId: USER_ID,
            }),
        ).toThrow(SessionKeyResolutionError);
    });

    test('rejects unknown kind as 400', () => {
        expect(() =>
            parseUploadSessionKeyInput({
                kind: 'system',
                id: USER_ID,
                version: undefined,
                authContextUserId: USER_ID,
            }),
        ).toThrow(SessionKeyResolutionError);
    });

    test('rejects skill upload without version as 400', () => {
        expect(() =>
            parseUploadSessionKeyInput({
                kind: 'skill',
                id: SKILL_ID,
                version: undefined,
                authContextUserId: USER_ID,
            }),
        ).toThrow(/version is required/);
    });

    test('rejects skill upload with non-numeric version as 400', () => {
        expect(() =>
            parseUploadSessionKeyInput({
                kind: 'skill',
                id: SKILL_ID,
                version: 'one',
                authContextUserId: USER_ID,
            }),
        ).toThrow(/version must be a number/);
    });

    test('rejects version on non-skill kinds as 400', () => {
        expect(() =>
            parseUploadSessionKeyInput({
                kind: 'agent',
                id: 'agent_123456789012345',
                version: '1',
                authContextUserId: USER_ID,
            }),
        ).toThrow(/version is only valid/);
    });
});
