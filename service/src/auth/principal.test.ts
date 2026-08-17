import { describe, expect, test } from 'bun:test';
import type * as t from '../types';
import { applyPrincipal } from './principal';

describe('applyPrincipal', () => {
    test('sets request planId from a verified principal', () => {
        const req = {} as t.AuthenticatedRequest;

        applyPrincipal(req, {
            userId: 'user_123',
            tenantId: 'tenant_abc',
            principalSource: 'openid_reuse',
            planId: 'prod_plan_123',
        });

        expect(req.planId).toBe('prod_plan_123');
        expect(req.codeApiAuthContext?.userId).toBe('user_123');
        expect(req.codeApiAuthContext?.tenantId).toBe('tenant_abc');
        expect(req.executionIdentity).toMatchObject({
            userId: 'user_123',
            canonicalUserId: 'user_123',
            storageNamespace: 'tenant_abc',
            tenantId: 'tenant_abc',
            principalSource: 'openid_reuse',
            planId: 'prod_plan_123',
        });
    });
});
