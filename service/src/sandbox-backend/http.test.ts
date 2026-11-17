import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
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
type TestResponse = {
  status: number;
  body: unknown;
  delayMs?: number;
  location?: string;
  headers?: Record<string, string>;
};

let nextResponse: TestResponse = { status: 200, body: {} };
let responseSequence: TestResponse[] = [];

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
      const response = responseSequence.shift() ?? nextResponse;
      if (response.delayMs !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, response.delayMs));
      }
      return new Response(JSON.stringify(response.body), {
        status: response.status,
        headers: { 'Content-Type': 'application/json', ...response.headers, ...(response.location !== undefined ? { Location: response.location } : {}) },
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
  responseSequence = [];
});

function payloadBody(): t.PayloadBody {
  return {
    language: 'python',
    version: '3.14.4',
    session_id: 'sess_exec_1',
    output_session_id: 'sess_out_1',
    files: [{ id: 'file_1', storage_session_id: 'sess_store_1', name: 'inputs/data.csv' }],
    egress_grant: 'ceg1.iv.ct.tag',
    execution_manifest: 'signed-manifest-token',
    env_vars: { PTC_HISTORY_PATH: '/mnt/data/_ptc_history.json' },
  };
}

function request(): SandboxTransportRequest {
  return { body: payloadBody(), headers: { 'Content-Type': 'application/json' } };
}

function context(overrides: Partial<SandboxExecuteContext> = {}): SandboxExecuteContext {
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
        stdout: 'ok', stderr: '', code: 0, signal: null, output: 'ok',
        memory: 1, message: null, status: null, cpu_time: 1, wall_time: 2,
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

  test('rejects redirects without sending the signed execution to another endpoint', async () => {
    let redirected = 0;
    const target = Bun.serve({
      port: 0,
      fetch() {
        redirected++;
        return Response.json({ session_id: 'unexpected' });
      },
    });
    try {
      for (const status of [302, 307, 308]) {
        nextResponse = { status, body: {}, location: `http://127.0.0.1:${target.port}/stolen` };
        await expect(new HttpSandboxBackend().execute(request(), context())).rejects.toThrow();
      }
      expect(redirected).toBe(0);
    } finally {
      target.stop(true);
    }
  });

  test('does not mutate the signed request body', async () => {
    const req = request();
    const before = JSON.stringify(req.body);
    await new HttpSandboxBackend().execute(req, context());
    expect(JSON.stringify(req.body)).toBe(before);
  });

  test('throws "Error from sandbox" on 2xx statuses other than 200', async () => {
    nextResponse = { status: 201, body: { session_id: 'x' } };
    expect(new HttpSandboxBackend().execute(request(), context()))
      .rejects.toThrow('Error from sandbox');
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
        expect(error.response?.data).toEqual({ message: 'sandbox exploded' });
      }
    }
  });

  test('retries an explicit runner_draining response before execution', async () => {
    responseSequence = [
      {
        status: 503,
        body: { error: 'runner_draining', message: 'Sandbox runner is draining for shutdown' },
        headers: { 'Retry-After': '0' },
      },
      {
        status: 200,
        body: { session_id: 'sess_exec_1', language: 'python', version: '3.14.4', files: [] },
      },
    ];

    const result = await new HttpSandboxBackend().execute(request(), context());

    expect(captured).toHaveLength(2);
    expect(result).toEqual({
      session_id: 'sess_exec_1',
      language: 'python',
      version: '3.14.4',
      files: [],
    });
  });

  test('does not retry a generic sandbox 503', async () => {
    nextResponse = { status: 503, body: { error: 'sandbox_execution_failed' } };

    await expect(new HttpSandboxBackend().execute(request(), context())).rejects.toMatchObject({
      response: { status: 503 },
    });
    expect(captured).toHaveLength(1);
  });

  test('bounds retries when every runner rejects admission', async () => {
    nextResponse = { status: 503, body: { error: 'runner_draining' }, headers: { 'Retry-After': '0' } };
    await expect(new HttpSandboxBackend().execute(request(), context())).rejects.toMatchObject({
      response: { status: 503 },
    });
    expect(captured).toHaveLength(3);
  });

  test('cancellation interrupts the retry delay without dispatching another execution', async () => {
    nextResponse = { status: 503, body: { error: 'runner_draining' }, headers: { 'Retry-After': '999' } };
    const controller = new AbortController();
    const pending = new HttpSandboxBackend().execute(request(), context({ signal: controller.signal }));
    for (let i = 0; i < 100 && captured.length === 0; i++) await Bun.sleep(2);
    await Bun.sleep(10);
    controller.abort(new Error('cancelled during drain retry'));
    await expect(pending).rejects.toThrow('cancelled during drain retry');
    expect(captured).toHaveLength(1);
  });

  test('propagates the worker abort signal as an axios cancellation', async () => {
    nextResponse = { status: 200, body: { session_id: 'x' }, delayMs: 5_000 };
    const controller = new AbortController();
    const pending = new HttpSandboxBackend().execute(request(), context({ signal: controller.signal }));
    setTimeout(() => controller.abort(), 20);
    try {
      await pending;
      throw new Error('expected rejection');
    } catch (error) {
      expect(axios.isAxiosError(error)).toBe(true);
      if (axios.isAxiosError(error)) {
        expect(error.code === 'ERR_CANCELED' || error.name === 'AbortError').toBe(true);
      }
    }
  });
});
