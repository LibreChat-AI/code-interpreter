import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type * as t from './types';
import {
    buildExecutionIdentity,
    executionIdentityFromPrincipal,
    getExecutionIdentity,
    resolveSingleTenantNamespace,
    resolveStorageNamespace,
} from './execution-identity';

describe('execution identity', () => {
    const originalSingleTenantEnv = process.env.CODEAPI_JWT_SINGLE_TENANT_ID;

    beforeEach(() => {
        delete process.env.CODEAPI_JWT_SINGLE_TENANT_ID;
    });

    afterEach(() => {
        if (originalSingleTenantEnv === undefined) {
            delete process.env.CODEAPI_JWT_SINGLE_TENANT_ID;
        } else {
            process.env.CODEAPI_JWT_SINGLE_TENANT_ID = originalSingleTenantEnv;
        }
    });

    test('uses legacy as the default single-tenant namespace', () => {
        expect(resolveSingleTenantNamespace()).toBe('legacy');
        expect(resolveStorageNamespace(undefined)).toBe('legacy');
    });

    test('uses configured single-tenant namespace when no tenant exists', () => {
        process.env.CODEAPI_JWT_SINGLE_TENANT_ID = 'oss-default';

        expect(resolveSingleTenantNamespace()).toBe('oss-default');
        expect(resolveStorageNamespace({ userId: 'user_123' })).toBe(
            'oss-default',
        );
    });

    test('preserves enterprise tenant context as storage namespace', () => {
        const identity = buildExecutionIdentity({
            userId: 'api_user',
            authContext: {
                userId: 'canonical_user',
                tenantId: 'tenant_abc',
                orgId: 'org_123',
                serviceId: 'svc_123',
                externalUserId: 'chc_123',
                principalSource: 'openid_reuse',
                authContextHash: 'hash_123',
            },
        });

        expect(identity).toMatchObject({
            userId: 'api_user',
            canonicalUserId: 'canonical_user',
            storageNamespace: 'tenant_abc',
            tenantId: 'tenant_abc',
            orgId: 'org_123',
            serviceId: 'svc_123',
            externalUserId: 'chc_123',
            principalSource: 'openid_reuse',
            authContextHash: 'hash_123',
        });
    });

    test('derives identity from a verified principal applied to a request', () => {
        const req = {
            codeApiPrincipal: {
                userId: 'user_123',
                tenantId: 'tenant_abc',
                principalSource: 'librechat_jwt',
                credentialId: 'key_123',
                planId: 'plan_123',
            },
        } as t.AuthenticatedRequest;

        expect(getExecutionIdentity(req)).toEqual(
            executionIdentityFromPrincipal(req.codeApiPrincipal!),
        );
    });

    test('fails through caller-supplied strict tenant error', () => {
        const error = new Error('missing tenant');

        expect(() =>
            resolveStorageNamespace(
                { userId: 'user_123' },
                {
                    requireTenant: true,
                    onMissingTenant: () => error,
                },
            ),
        ).toThrow(error);
    });
});
