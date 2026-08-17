import { afterEach, describe, expect, test } from 'bun:test';
import axios from 'axios';
import { env } from './config';
import {
    createGatewayEgressGrant,
    createGatewayPtcCallbackToken,
    restoreGatewaySandboxResult,
    revokeGatewayEgressGrant,
} from './egress-gateway-client';
import { CODEAPI_SYNTHETIC_INTERNAL_REQUEST_HEADER } from './internal-synthetic';
import { withTraceContext } from './telemetry';
import type { ExecutionManifestClaims } from './execution-manifest';
import type * as t from './types';

const originalPost = axios.post;

type AxiosPostCall = {
    url: string;
    body: unknown;
    config: {
        headers?: Record<string, string>;
        signal?: AbortSignal;
        timeout?: number;
    };
};

function axiosPostMock(
    responseData: unknown,
    calls: AxiosPostCall[],
): typeof axios.post {
    return (async (
        url: string,
        body?: unknown,
        config?: AxiosPostCall['config'],
    ) => {
        calls.push({ url, body, config: config ?? {} });
        return { data: responseData };
    }) as unknown as typeof axios.post;
}

function claims(): ExecutionManifestClaims {
    return {
        v: 1,
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
        max_requests: 100,
        iat: 100,
        exp: 200,
        principal_source: 'librechat',
        auth_context_hash: 'hash_123',
    };
}

function payload(): t.PayloadBody {
    return {
        language: 'python',
        version: '3.14.4',
        session_id: 'sess_output',
        files: [
            {
                id: 'file_123',
                storage_session_id: 'sess_input',
                name: 'inputs/data.csv',
            },
        ],
    };
}

describe('egress gateway client', () => {
    let previousGatewayUrl: string;
    let previousRequestTimeout: number;
    let previousRevokeTimeout: number;

    afterEach(() => {
        (axios as unknown as { post: typeof axios.post }).post = originalPost;
        env.EGRESS_GATEWAY_URL = previousGatewayUrl;
        env.EGRESS_GATEWAY_REQUEST_TIMEOUT_MS = previousRequestTimeout;
        env.EGRESS_GATEWAY_REVOKE_TIMEOUT_MS = previousRevokeTimeout;
    });

    function setup(
        calls: AxiosPostCall[],
        responseData: unknown,
    ): AbortController {
        previousGatewayUrl = env.EGRESS_GATEWAY_URL;
        previousRequestTimeout = env.EGRESS_GATEWAY_REQUEST_TIMEOUT_MS;
        previousRevokeTimeout = env.EGRESS_GATEWAY_REVOKE_TIMEOUT_MS;
        env.EGRESS_GATEWAY_URL = 'http://egress-gateway:3190';
        env.EGRESS_GATEWAY_REQUEST_TIMEOUT_MS = 12_345;
        env.EGRESS_GATEWAY_REVOKE_TIMEOUT_MS = 987;
        (axios as unknown as { post: typeof axios.post }).post = axiosPostMock(
            responseData,
            calls,
        );
        return new AbortController();
    }

    test('bounds grant create, result restore, and PTC token calls with timeout and abort signal', async () => {
        const calls: AxiosPostCall[] = [];
        const controller = setup(calls, {
            grant_id: 'grant_123',
            payload: payload(),
            egressGrantToken: 'sealed-grant',
            executionManifestClaims: claims(),
            result: { session_id: 'sess_output', files: [] },
            callbackToken: 'sealed-callback',
        });

        await createGatewayEgressGrant({
            payload: payload(),
            claims: claims(),
            signal: controller.signal,
        });
        await restoreGatewaySandboxResult({
            grantId: 'grant_123',
            egressGrantToken: 'sealed-grant',
            result: { session_id: 'sess_output', files: [] },
            signal: controller.signal,
        });
        await createGatewayPtcCallbackToken(
            {
                executionId: 'exec_123',
                sessionId: 'sess_output',
                callbackToken: 'raw-callback',
                timeoutSeconds: 30,
                allowedToolNames: ['query_clickhouse'],
            },
            { signal: controller.signal },
        );

        expect(calls.map(call => call.config.timeout)).toEqual([
            12_345, 12_345, 12_345,
        ]);
        expect(calls.map(call => call.config.signal)).toEqual([
            controller.signal,
            controller.signal,
            controller.signal,
        ]);
    });

    test('propagates only W3C trace context to outbound gateway calls', async () => {
        const calls: AxiosPostCall[] = [];
        setup(calls, {
            grant_id: 'grant_123',
            payload: payload(),
            egressGrantToken: 'sealed-grant',
            executionManifestClaims: claims(),
        });

        await withTraceContext(
            {
                traceparent:
                    '00-11111111111111111111111111111111-2222222222222222-01',
                baggage: 'user_id=secret-user',
                authorization: 'Bearer secret-token',
                cookie: 'session=secret-cookie',
            },
            () =>
                createGatewayEgressGrant({
                    payload: payload(),
                    claims: claims(),
                }),
        );

        expect(calls[0].config.headers?.traceparent).toStartWith(
            '00-11111111111111111111111111111111-',
        );
        expect(calls[0].config.headers).not.toHaveProperty('baggage');
        expect(calls[0].config.headers).not.toHaveProperty('authorization');
        expect(calls[0].config.headers).not.toHaveProperty('cookie');
    });

    test('uses a short bounded timeout for best-effort revocation', async () => {
        const calls: AxiosPostCall[] = [];
        setup(calls, {});

        await revokeGatewayEgressGrant({
            grantId: 'grant_123',
            reason: 'completed',
        });
        await revokeGatewayEgressGrant({
            grantId: 'grant_123',
            reason: 'failed',
            timeoutMs: 321,
        });

        expect(calls.map(call => call.config.timeout)).toEqual([987, 321]);
    });

    test('restores and revokes token-only egress grants through gateway-derived grant routes', async () => {
        const calls: AxiosPostCall[] = [];
        setup(calls, { result: { session_id: 'sess_output', files: [] } });

        await restoreGatewaySandboxResult({
            egressGrantToken: 'sealed-grant',
            result: { session_id: 'sealed-output-session', files: [] },
        });
        await revokeGatewayEgressGrant({
            egressGrantToken: 'sealed-grant',
            reason: 'completed',
        });

        expect(calls[0].url).toBe(
            'http://egress-gateway:3190/internal/egress-grants/restore-result',
        );
        expect(calls[0].body).toMatchObject({
            egressGrantToken: 'sealed-grant',
        });
        expect(calls[1].url).toBe(
            'http://egress-gateway:3190/internal/egress-grants/revoke',
        );
        expect(calls[1].body).toEqual({
            egressGrantToken: 'sealed-grant',
            reason: 'completed',
        });
    });

    test('marks synthetic egress grant lifecycle calls for gateway log suppression', async () => {
        const calls: AxiosPostCall[] = [];
        setup(calls, {
            grant_id: 'grant_123',
            payload: payload(),
            egressGrantToken: 'sealed-grant',
            executionManifestClaims: claims(),
            result: { session_id: 'sess_output', files: [] },
        });

        await createGatewayEgressGrant({
            payload: payload(),
            claims: claims(),
            isSynthetic: true,
        });
        await restoreGatewaySandboxResult({
            grantId: 'grant_123',
            egressGrantToken: 'sealed-grant',
            result: { session_id: 'sess_output', files: [] },
            isSynthetic: true,
        });
        await revokeGatewayEgressGrant({
            grantId: 'grant_123',
            reason: 'completed',
            isSynthetic: true,
        });

        expect(
            calls.map(
                call =>
                    call.config.headers?.[
                        CODEAPI_SYNTHETIC_INTERNAL_REQUEST_HEADER
                    ],
            ),
        ).toEqual(['true', 'true', 'true']);
    });
});
