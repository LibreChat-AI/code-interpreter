import {
    afterAll,
    afterEach,
    beforeAll,
    describe,
    expect,
    test,
} from 'bun:test';
import axios from 'axios';
import { env } from '../config';
import { HttpSandboxBackend } from './http';
import type { SandboxExecuteContext, SandboxTransportRequest } from './types';
import type * as t from '../types';

type CapturedRequest = {
    method: string;
    path: string;
    rawBody: string;
    headers: Record<string, string>;
};

let server: ReturnType<typeof Bun.serve>;
let captured: CapturedRequest[] = [];
let nextResponse: { status: number; body: unknown; delayMs?: number } = {
    status: 200,
    body: {},
};

const savedEndpoint = env.SANDBOX_ENDPOINT;

beforeAll(() => {
    server = Bun.serve({
        port: 0,
        async fetch(req) {
            captured.push({
                method: req.method,
                path: new URL(req.url).pathname,
                rawBody: await req.text(),
                headers: Object.fromEntries(req.headers.entries()),
            });
            if (nextResponse.delayMs) {
                await new Promise(resolve =>
                    setTimeout(resolve, nextResponse.delayMs),
                );
            }
            return new Response(JSON.stringify(nextResponse.body), {
                status: nextResponse.status,
                headers: { 'Content-Type': 'application/json' },
            });
        },
    });
    env.SANDBOX_ENDPOINT = `http://localhost:${server.port}/api/v2`;
});

afterAll(() => {
    env.SANDBOX_ENDPOINT = savedEndpoint;
    server.stop(true);
});

afterEach(() => {
    captured = [];
    nextResponse = { status: 200, body: {} };
});

function payloadBody(): t.PayloadBody {
    return {
        language: 'python',
        version: '3.14.4',
        session_id: 'sess_exec_1',
        output_session_id: 'sess_out_1',
        files: [
            {
                id: 'file_1',
                storage_session_id: 'sess_store_1',
                name: 'inputs/data.csv',
            },
        ],
        egress_grant: 'ceg1.iv.ct.tag',
        execution_manifest: 'signed-manifest-token',
        env_vars: { PTC_HISTORY_PATH: '/mnt/data/_ptc_history.json' },
    };
}

function request(): SandboxTransportRequest {
    return {
        body: payloadBody(),
        headers: { 'Content-Type': 'application/json' },
    };
}

function context(
    overrides: Partial<SandboxExecuteContext> = {},
): SandboxExecuteContext {
    return {
        executionId: 'exec_1',
        language: 'python',
        isSynthetic: false,
        signal: new AbortController().signal,
        runtimeSessionMode: 'stateless',
        ...overrides,
    };
}

describe('HttpSandboxBackend', () => {
    test('POSTs the request body byte-identical to SANDBOX_ENDPOINT/execute', async () => {
        const responseBody = {
            session_id: 'sess_exec_1',
            language: 'python',
            version: '3.14.4',
            files: [],
            run: {
                stdout: 'ok',
                stderr: '',
                code: 0,
                signal: null,
                output: 'ok',
                memory: 1,
                message: null,
                status: null,
                cpu_time: 1,
                wall_time: 2,
            },
        };
        nextResponse = { status: 200, body: responseBody };

        const backend = new HttpSandboxBackend();
        const req = request();
        const result = await backend.execute(req, context());

        expect(captured).toHaveLength(1);
        expect(captured[0].method).toBe('POST');
        expect(captured[0].path).toBe('/api/v2/execute');
        expect(captured[0].rawBody).toBe(JSON.stringify(req.body));
        expect(captured[0].headers['content-type']).toBe('application/json');
        expect(result).toEqual(responseBody);
    });

    test('does not mutate the signed request body', async () => {
        const req = request();
        const before = JSON.stringify(req.body);
        await new HttpSandboxBackend().execute(req, context());
        expect(JSON.stringify(req.body)).toBe(before);
    });

    test('throws "Error from sandbox" on 2xx statuses other than 200', async () => {
        nextResponse = { status: 201, body: { session_id: 'x' } };
        expect(
            new HttpSandboxBackend().execute(request(), context()),
        ).rejects.toThrow('Error from sandbox');
    });

    test('rethrows axios errors untouched on non-2xx statuses', async () => {
        nextResponse = { status: 500, body: { message: 'sandbox exploded' } };
        try {
            await new HttpSandboxBackend().execute(request(), context());
            throw new Error('expected rejection');
        } catch (error) {
            expect(axios.isAxiosError(error)).toBe(true);
            if (axios.isAxiosError(error)) {
                expect(error.response?.status).toBe(500);
                expect(error.response?.data).toEqual({
                    message: 'sandbox exploded',
                });
            }
        }
    });

    test('propagates the worker abort signal as an axios cancellation', async () => {
        nextResponse = {
            status: 200,
            body: { session_id: 'x' },
            delayMs: 5_000,
        };
        const controller = new AbortController();
        const pending = new HttpSandboxBackend().execute(
            request(),
            context({ signal: controller.signal }),
        );
        setTimeout(() => controller.abort(), 20);
        try {
            await pending;
            throw new Error('expected rejection');
        } catch (error) {
            expect(axios.isAxiosError(error)).toBe(true);
            if (axios.isAxiosError(error)) {
                expect(
                    error.code === 'ERR_CANCELED' ||
                        error.name === 'AbortError',
                ).toBe(true);
            }
        }
    });
});
