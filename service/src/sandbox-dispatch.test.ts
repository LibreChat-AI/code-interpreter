import { describe, expect, test } from 'bun:test';
import type * as t from './types';
import { buildSandboxExecuteRequest } from './sandbox-dispatch';
import { EGRESS_GRANT_HEADER } from './egress-grant';
import {
    EXECUTION_MANIFEST_HEADER,
    EXECUTION_MANIFEST_VERSION,
    executionManifestBodySha256,
    type ExecutionManifestClaims,
    verifyExecutionManifest,
    verifyExecutionManifestWithPublicKey,
} from './execution-manifest';

const SECRET = 'test-secret';
const PRIVATE_KEY =
    'MC4CAQAwBQYDK2VwBCIEIBoxzSJjQ5jTVyuohHtlD+uDGqv/tZ6hQS2CmxuOg2Wn';
const PUBLIC_KEY =
    'MCowBQYDK2VwAyEAeY3PRoTS3adfU6E3gQUB5hSZdrdMSw6OrKkH4UhYh0U=';

function payload(overrides: Partial<t.PayloadBody> = {}): t.PayloadBody {
    return {
        language: 'bash',
        version: '5.2.0',
        session_id: 'sess_output',
        files: [{ name: 'script.sh', content: 'echo ok' }],
        ...overrides,
    };
}

function claims(
    overrides: Partial<ExecutionManifestClaims> = {},
): ExecutionManifestClaims {
    return {
        v: EXECUTION_MANIFEST_VERSION,
        exec_id: 'exec_123',
        tenant_id: 'tenant_abc',
        user_id: 'user_123',
        session_key: 'tenant:tenant_abc:user:user_123',
        input_files: [
            {
                id: 'file_123',
                session_id: 'sess_input',
                name: 'inputs/data.csv',
            },
        ],
        read_sessions: ['sess_input'],
        output_session_id: 'sess_output',
        max_upload_bytes: 1024,
        max_output_files: 10,
        max_requests: 50,
        iat: 100,
        exp: 200,
        principal_source: 'librechat',
        ...overrides,
    };
}

describe('sandbox execute request dispatch', () => {
    test('keeps large egress grants out of HTTP headers', () => {
        const largeGrant = `ceg1.${'a'.repeat(24_000)}`;
        const request = buildSandboxExecuteRequest({
            payload: payload(),
            egressGrantToken: largeGrant,
            executionManifestSecret: SECRET,
            executionManifestTtlSeconds: 300,
        });

        expect(request.headers).toEqual({ 'Content-Type': 'application/json' });
        expect(request.headers[EGRESS_GRANT_HEADER]).toBeUndefined();
        expect(request.body.egress_grant).toBe(largeGrant);
    });

    test('keeps signed execution manifests out of HTTP headers', () => {
        const request = buildSandboxExecuteRequest({
            payload: payload(),
            executionManifestClaims: claims(),
            executionManifestSecret: SECRET,
            executionManifestTtlSeconds: 300,
            nowSeconds: 1_000,
        });

        expect(request.headers[EXECUTION_MANIFEST_HEADER]).toBeUndefined();
        expect(request.body.execution_manifest).toEqual(expect.any(String));
        expect(
            verifyExecutionManifest(request.body.execution_manifest!, SECRET, {
                nowSeconds: 1_100,
            }),
        ).toEqual(
            claims({
                execute_body_sha256: executionManifestBodySha256(request.body),
                iat: 1_000,
                exp: 1_300,
            }),
        );
    });

    test('signs execution manifests with a private key when configured', () => {
        const request = buildSandboxExecuteRequest({
            payload: payload(),
            executionManifestClaims: claims(),
            executionManifestPrivateKey: PRIVATE_KEY,
            executionManifestSecret: '',
            executionManifestTtlSeconds: 300,
            nowSeconds: 1_000,
        });

        expect(
            verifyExecutionManifestWithPublicKey(
                request.body.execution_manifest!,
                PUBLIC_KEY,
                { nowSeconds: 1_100 },
            ),
        ).toEqual(
            claims({
                execute_body_sha256: executionManifestBodySha256(request.body),
                iat: 1_000,
                exp: 1_300,
            }),
        );
    });

    test('binds body-carried egress grants into signed execution manifests', () => {
        const request = buildSandboxExecuteRequest({
            payload: payload(),
            egressGrantToken: 'ceg1.sealed-grant',
            executionManifestClaims: claims(),
            executionManifestSecret: SECRET,
            executionManifestTtlSeconds: 300,
            nowSeconds: 1_000,
        });

        expect(request.body.egress_grant).toBe('ceg1.sealed-grant');
        expect(
            verifyExecutionManifest(request.body.execution_manifest!, SECRET, {
                nowSeconds: 1_100,
            }),
        ).toEqual(
            claims({
                execute_body_sha256: executionManifestBodySha256(request.body),
                iat: 1_000,
                exp: 1_300,
            }),
        );
    });
});
