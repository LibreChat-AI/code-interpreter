import { describe, expect, test } from 'bun:test';
import {
    EXECUTION_MANIFEST_VERSION,
    ExecutionManifestError,
    type ExecutionManifestClaims,
} from './execution-manifest';
import {
    authorizeToolCallSocket,
    tokenFromBodyOrHeader,
    type ExecuteRequestBody,
} from './api/v2';

function body(overrides: Partial<ExecuteRequestBody> = {}): ExecuteRequestBody {
    return {
        language: 'bash',
        version: '5.2.0',
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
        input_files: [],
        read_sessions: [],
        output_session_id: 'sess_output',
        max_upload_bytes: 1024,
        max_output_files: 10,
        max_requests: 50,
        iat: 100,
        exp: 200,
        execute_body_sha256: 'body-hash',
        principal_source: 'librechat',
        ...overrides,
    };
}

describe('sandbox execute capability transport', () => {
    test('prefers body-carried egress grants over legacy headers', () => {
        expect(
            tokenFromBodyOrHeader(
                body({ egress_grant: 'body-grant' }),
                'egress_grant',
                'header-grant',
            ),
        ).toBe('body-grant');
    });

    test('preserves legacy header fallback during rolling deploys', () => {
        expect(
            tokenFromBodyOrHeader(body(), 'egress_grant', 'header-grant'),
        ).toBe('header-grant');
    });

    test('supports body-carried execution manifests', () => {
        expect(
            tokenFromBodyOrHeader(
                body({ execution_manifest: 'body-manifest' }),
                'execution_manifest',
                'header-manifest',
            ),
        ).toBe('body-manifest');
    });

    test('requires a body-bound manifest claim before honoring tool-call socket requests', () => {
        expect(() =>
            authorizeToolCallSocket(
                body({ tool_call_socket: true }),
                undefined,
            ),
        ).toThrow(ExecutionManifestError);
        expect(() =>
            authorizeToolCallSocket(
                body({ tool_call_socket: true }),
                claims({ tool_call_socket: false }),
            ),
        ).toThrow(ExecutionManifestError);
        expect(() =>
            authorizeToolCallSocket(
                body({ tool_call_socket: true }),
                claims({
                    tool_call_socket: true,
                    execute_body_sha256: undefined,
                }),
            ),
        ).toThrow(ExecutionManifestError);

        expect(
            authorizeToolCallSocket(
                body({ tool_call_socket: true }),
                claims({ tool_call_socket: true }),
            ),
        ).toBe(true);
    });

    test('allows unsigned socket requests only for non-hardened local mode', () => {
        expect(
            authorizeToolCallSocket(
                body({ tool_call_socket: true }),
                undefined,
                { allowUnsignedLocalToolCallSocket: true },
            ),
        ).toBe(true);
    });

    test('preserves old body-hashed worker payloads only during the socket-claim rollout grace window', () => {
        expect(
            authorizeToolCallSocket(
                body(),
                claims({ tool_call_socket: undefined }),
                { nowSeconds: 150, legacyClaimGraceUntilSeconds: 200 },
            ),
        ).toBe(true);
        expect(
            authorizeToolCallSocket(
                body(),
                claims({ tool_call_socket: undefined }),
                { nowSeconds: 200, legacyClaimGraceUntilSeconds: 200 },
            ),
        ).toBe(false);
        expect(
            authorizeToolCallSocket(
                body(),
                claims({ tool_call_socket: false }),
                { nowSeconds: 150, legacyClaimGraceUntilSeconds: 200 },
            ),
        ).toBe(false);
    });
});
