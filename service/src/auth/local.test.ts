import { describe, expect, test } from 'bun:test';
import type * as t from '../types';
import { applyLocalPrincipal } from './local';

describe('applyLocalPrincipal', () => {
    test('sets the local mock principal used by unauthenticated local mode', () => {
        const req = {} as t.AuthenticatedRequest;

        applyLocalPrincipal(req);

        expect(req.planId).toBe('local-plan');
        expect(req.codeApiAuthContext).toMatchObject({
            userId: 'local-test-user',
            tenantId: 'local',
            principalSource: 'none',
        });
        expect(req.codeApiPrincipal?.credentialId).toBe('local-test-key');
    });
});
