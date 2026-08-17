import { describe, expect, test } from 'bun:test';
import type { ExecutionManifestClaims } from '../execution-manifest';
import { prepareSandboxEgress } from '../egress-grant';
import type * as t from '../types';
import { prepareInputDelivery } from './input-delivery';
import { inputCacheKey } from './files';

const SECRET = 'test-egress-secret-32-bytes-minimum';

function claims(): ExecutionManifestClaims {
    return {
        v: 1,
        exec_id: 'exec_123',
        tenant_id: 'tenant_abc',
        user_id: 'user_123',
        session_key: 'tenant:tenant_abc:user:user_123',
        input_files: [
            { id: 'raw-file', session_id: 'raw-session', name: 'data.csv' },
        ],
        read_sessions: ['raw-session'],
        output_session_id: 'raw-output',
        max_upload_bytes: 1024,
        max_output_files: 10,
        max_requests: 100,
        iat: 100,
        exp: 300,
        principal_source: 'librechat',
        auth_context_hash: 'hash_123',
    };
}

function payload(): t.PayloadBody {
    return {
        language: 'python',
        version: '3.14.4',
        files: [
            {
                id: 'raw-file',
                storage_session_id: 'raw-session',
                name: 'data.csv',
            },
            {
                id: 'raw-file',
                storage_session_id: 'raw-session',
                name: 'copy/data.csv',
            },
            { name: 'main.py', content: 'print(1)' },
        ],
    };
}

describe('prepareInputDelivery', () => {
    test('keeps raw fetch refs control-plane-only and gives fresh grants one stable cache key', () => {
        const authorized = payload();
        const firstMasked = prepareSandboxEgress({
            payload: authorized,
            claims: claims(),
            grantId: 'grant_1',
            secret: SECRET,
        }).payload;
        const secondMasked = prepareSandboxEgress({
            payload: authorized,
            claims: claims(),
            grantId: 'grant_2',
            secret: SECRET,
        }).payload;

        const first = prepareInputDelivery(authorized, firstMasked);
        const second = prepareInputDelivery(authorized, secondMasked);
        const stable = inputCacheKey('raw-session', 'raw-file');
        const firstRef = first.payload.files[0] as t.PayloadFileRef;
        const secondRef = second.payload.files[0] as t.PayloadFileRef;

        expect(firstRef.id).not.toBe(secondRef.id);
        expect(firstRef.input_cache_key).toBe(stable);
        expect(secondRef.input_cache_key).toBe(stable);
        expect(first.refs).toEqual([
            {
                id: 'raw-file',
                storage_session_id: 'raw-session',
                name: 'data.csv',
                cache_key: stable,
            },
        ]);
        expect(JSON.stringify(first.payload)).not.toContain('raw-file');
        expect(JSON.stringify(first.payload)).not.toContain('raw-session');
    });

    test('rejects a gateway response that changes file ordering or shape', () => {
        const authorized = payload();
        expect(() =>
            prepareInputDelivery(authorized, {
                ...authorized,
                files: [...authorized.files].reverse(),
            }),
        ).toThrow('shape or destination');
    });
});
