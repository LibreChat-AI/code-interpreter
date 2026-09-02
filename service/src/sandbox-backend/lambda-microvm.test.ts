import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import RedisMock from 'ioredis-mock';
import * as zlib from 'zlib';
import * as fsp from 'fs/promises';
import axios from 'axios';
import { env } from '../config';
import { FakeLambdaMicrovmClient } from '../runtime-session/lambda-client-fake';
import { LambdaMicrovmApiError } from '../runtime-session/lambda-client';
import {
  resetRedisForTests as resetThrottleRedis,
  setRedisForTests as setThrottleRedis,
} from '../runtime-session/throttle';
import {
  acquireRuntimeSessionLock,
  readRuntimeSessionRecord,
  releaseRuntimeSessionLock,
  resetRedisForTests as resetRegistryRedis,
  setRedisForTests as setRegistryRedis,
  writeRuntimeSessionRecord,
} from '../runtime-session/registry';
import { MemoryCheckpointStore, checkpointObjectKey, checkpointPrefixFor } from '../runtime-session/checkpoint-store';
import {
  LambdaMicrovmSandboxBackend,
  normalizeMicrovmEndpoint,
  RUNTIME_SESSION_NAMESPACED_GENERATION_MIN,
  runtimeSessionLaunchClientToken,
  runtimeSessionLaunchFingerprint,
  runtimeSessionLaunchGenerationSeed,
  statelessLaunchClientToken,
  type LambdaMicrovmBackendConfig,
} from './lambda-microvm';
import { SandboxBackendError } from './types';
import type { SandboxExecuteContext, SandboxRawResponse, SandboxTransportRequest } from './types';
import type * as t from '../types';

type CapturedRequest = { path: string; rawBody: string; headers: Record<string, string> };

let server: ReturnType<typeof Bun.serve>;
let captured: CapturedRequest[] = [];
let healthStatus = 200;
let executeDelayMs = 0;
let executeStatus = 200;
let executeResponseBody: unknown;
let sessionFilesStatus = 200;
let sessionProbeDelayMs = 0;
let lastSessionFilesBody: Buffer | null = null;
let stealSessionLockOnExecute = false;
let fileReadOnly = false;
let fileObjectStatus = 200;
let probeMissingOverride: Array<{ cache_key: string }> | undefined;
let evictAfterPush = false;
let recordDuringRestore: Awaited<ReturnType<typeof readRuntimeSessionRecord>> | undefined;
let onExecute: (() => void | Promise<void>) | undefined;
let checkpointChunkIntervalMs = 0;
let checkpointChunkCount = 0;
/** Models the runner's input cache so probe/push behave like the real VM. */
let lastProbedRefs: Array<{ cache_key: string }> = [];
const vmInputCache = new Set<string>();
const fileObjectBytes = 'csv,bytes\n1,2\n';
let mock: InstanceType<typeof RedisMock>;
const checkpointBlob = 'FAKE_TAR_GZ_BYTES';

const EXECUTE_RESPONSE = {
  session_id: 'sess_exec_1',
  language: 'python',
  version: '3.14.4',
  files: [],
  run: {
    stdout: 'ok', stderr: '', code: 0, signal: null, output: 'ok',
    memory: 1, message: null, status: null, cpu_time: 1, wall_time: 2,
  },
};

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      const raw = Buffer.from(await req.arrayBuffer());
      captured.push({
        path,
        rawBody: raw.toString(),
        headers: Object.fromEntries(req.headers.entries()),
      });
      /* The same server doubles as the internal file server the control plane
       * fetches input refs from when building a session files delivery. */
      if (path.startsWith('/sessions/')) {
        return new Response(fileObjectBytes, {
          status: fileObjectStatus,
          headers: fileReadOnly ? { 'X-Read-Only': 'true' } : {},
        });
      }
      if (path === '/api/v2/session/inputs/probe') {
        if (sessionProbeDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, sessionProbeDelayMs));
        }
        const refs = (JSON.parse(raw.toString()) as {
          refs: Array<{ cache_key: string }>;
        }).refs;
        lastProbedRefs = refs;
        const missing = probeMissingOverride
          ?? refs.filter((r) => !vmInputCache.has(r.cache_key));
        return new Response(JSON.stringify({ missing }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (path === '/api/v2/session/inputs') {
        lastSessionFilesBody = raw;
        if (sessionFilesStatus === 200) {
          /* Model the runner cache: everything just pushed is now held. */
          for (const ref of lastProbedRefs) vmInputCache.add(ref.cache_key);
          if (evictAfterPush) vmInputCache.clear();
        }
        return new Response(JSON.stringify({ stored: lastProbedRefs.length }), {
          status: sessionFilesStatus,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (path === '/api/v2/health') {
        return new Response(JSON.stringify({ status: 'ok' }), {
          status: healthStatus,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (path === '/api/v2/execute') {
        await onExecute?.();
        if (executeDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, executeDelayMs));
        }
        if (stealSessionLockOnExecute) {
          await mock.set('rtsx:lock:rt_session_1', 'stolen');
        }
        return new Response(JSON.stringify(executeResponseBody), {
          status: executeStatus,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (path === '/api/v2/session/checkpoint') {
        if (checkpointChunkIntervalMs > 0 && checkpointChunkCount > 0) {
          let timer: ReturnType<typeof setInterval> | undefined;
          const intervalMs = checkpointChunkIntervalMs;
          const chunkCount = checkpointChunkCount;
          return new Response(new ReadableStream<Uint8Array>({
            start(controller) {
              let emitted = 0;
              const emit = (): void => {
                try {
                  controller.enqueue(Buffer.from('x'));
                  emitted += 1;
                  if (emitted >= chunkCount) {
                    if (timer) clearInterval(timer);
                    controller.close();
                  }
                } catch {
                  if (timer) clearInterval(timer);
                }
              };
              emit();
              if (emitted < chunkCount) timer = setInterval(emit, intervalMs);
            },
            cancel() {
              if (timer) clearInterval(timer);
            },
          }), { status: 200, headers: { 'Content-Type': 'application/x-gtar' } });
        }
        return new Response(checkpointBlob, { status: 200, headers: { 'Content-Type': 'application/x-gtar' } });
      }
      if (path === '/api/v2/session/restore') {
        recordDuringRestore = await readRuntimeSessionRecord('rt_ckpt_1');
        return new Response(JSON.stringify({ status: 'restored' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('not found', { status: 404 });
    },
  });
  env.FILE_SERVER_URL = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop(true);
});

beforeEach(async () => {
  /* ioredis-mock shares one keyspace across instances — flush per test. */
  mock = new RedisMock();
  await mock.flushall();
  setThrottleRedis(mock);
  setRegistryRedis(mock);
  captured = [];
  healthStatus = 200;
  executeDelayMs = 0;
  executeStatus = 200;
  executeResponseBody = EXECUTE_RESPONSE;
  sessionFilesStatus = 200;
  sessionProbeDelayMs = 0;
  lastSessionFilesBody = null;
  stealSessionLockOnExecute = false;
  fileReadOnly = false;
  fileObjectStatus = 200;
  probeMissingOverride = undefined;
  evictAfterPush = false;
  recordDuringRestore = undefined;
  onExecute = undefined;
  checkpointChunkIntervalMs = 0;
  checkpointChunkCount = 0;
  lastProbedRefs = [];
  vmInputCache.clear();
});

afterEach(() => {
  resetThrottleRedis();
  resetRegistryRedis();
});

function config(overrides: Partial<LambdaMicrovmBackendConfig> = {}): LambdaMicrovmBackendConfig {
  return {
    imageArn: 'arn:aws:lambda:us-east-2:1:microvm-image:codeapi',
    imageVersion: '3',
    port: 8080,
    maxDurationSeconds: 28_800,
    authTokenTtlSeconds: 300,
    launchTimeoutMs: 2_000,
    healthTimeoutMs: 1_000,
    launchTps: 50,
    tokenTps: 50,
    jobTimeoutMs: 300_000,
    idleSeconds: 300,
    suspendedSeconds: 1_800,
    lockWaitMs: 500,
    checkpointsEnabled: false,
    checkpoint: { port: 8080, authTokenTtlSeconds: 300, maxBytes: 512 * 1024 * 1024, timeoutMs: 30_000 },
    ...overrides,
  };
}

function makeBackend(
  fake: FakeLambdaMicrovmClient,
  cfg?: Partial<LambdaMicrovmBackendConfig>,
  checkpointStore?: MemoryCheckpointStore,
): LambdaMicrovmSandboxBackend {
  return new LambdaMicrovmSandboxBackend({
    clientFactory: () => Promise.resolve(fake),
    config: config(cfg),
    pollIntervalMs: 5,
    checkpointStore,
  });
}

function fakeClient(): FakeLambdaMicrovmClient {
  return new FakeLambdaMicrovmClient({ endpointProvider: () => `http://localhost:${server.port}` });
}

function payloadBody(): t.PayloadBody {
  return {
    language: 'python',
    version: '3.14.4',
    session_id: 'sess_exec_1',
    files: [{ id: 'file_1', storage_session_id: 'sess_store_1', name: 'inputs/data.csv' }],
    egress_grant: 'ceg1.iv.ct.tag',
    execution_manifest: 'signed-manifest-token',
  };
}

function request(): SandboxTransportRequest {
  return { body: payloadBody(), headers: { 'Content-Type': 'application/json' } };
}

function context(overrides: Partial<SandboxExecuteContext> = {}): SandboxExecuteContext {
  return {
    executionId: 'exec_42',
    language: 'python',
    isSynthetic: false,
    signal: new AbortController().signal,
    runtimeSessionMode: 'stateless',
    ...overrides,
  };
}

describe('normalizeMicrovmEndpoint', () => {
  test('prefixes https for bare hosts and keeps explicit schemes', () => {
    expect(normalizeMicrovmEndpoint('abc.lambda-microvm.on.aws')).toBe('https://abc.lambda-microvm.on.aws');
    expect(normalizeMicrovmEndpoint('abc.on.aws/')).toBe('https://abc.on.aws');
    expect(normalizeMicrovmEndpoint('http://localhost:1234')).toBe('http://localhost:1234');
    expect(normalizeMicrovmEndpoint('https://x.on.aws///')).toBe('https://x.on.aws');
  });
});

describe('runtime session launch tokens', () => {
  test('uses a deterministic launch namespace and stays within the AWS limit', () => {
    const cfg = config();
    const seed = runtimeSessionLaunchGenerationSeed(cfg);
    expect(seed).toBeGreaterThanOrEqual(RUNTIME_SESSION_NAMESPACED_GENERATION_MIN);
    expect(runtimeSessionLaunchGenerationSeed({ ...cfg, imageVersion: '4' })).not.toBe(seed);

    const runtimeSessionId = `rt_${'a'.repeat(40)}`;
    const token = runtimeSessionLaunchClientToken(runtimeSessionId, Number.MAX_SAFE_INTEGER);
    expect(`${token}-r1`.length).toBeLessThanOrEqual(128);
    expect(token).toMatch(/^[A-Za-z0-9_.:-]+$/);
  });
});

describe('statelessLaunchClientToken', () => {
  const ptcIteration = (history: string): SandboxTransportRequest => ({
    ...request(),
    body: {
      ...payloadBody(),
      files: [{ id: history, storage_session_id: 'sess_store_1', name: '_ptc_history.json' }],
    },
  });

  test('is deterministic for an identical relaunch', () => {
    const first = statelessLaunchClientToken('exec_42', config(), 420, request());
    const second = statelessLaunchClientToken('exec_42', config(), 420, request());
    expect(first).toBe(second);
  });

  /* PTC replay reuses one executionId across iterations while the sandbox
   * payload gains a new _ptc_history.json each round. A token derived from the
   * executionId alone repeated, and AWS rejected the relaunch with "The
   * provided clientToken was used with different request parameters". */
  test('differs per replay iteration when the request body changes', () => {
    const round1 = statelessLaunchClientToken('exec_42', config(), 420, ptcIteration('hist_1'));
    const round2 = statelessLaunchClientToken('exec_42', config(), 420, ptcIteration('hist_2'));
    expect(round1).not.toBe(round2);
    expect(round1).toMatch(/^exec-exec_42-[0-9a-f]{16}$/);
    expect(round2).toMatch(/^exec-exec_42-[0-9a-f]{16}$/);
  });

  test('differs when launch configuration or duration changes', () => {
    const base = statelessLaunchClientToken('exec_42', config(), 420, request());
    expect(statelessLaunchClientToken('exec_42', config({ imageVersion: '4' }), 420, request()))
      .not.toBe(base);
    expect(statelessLaunchClientToken('exec_42', config(), 421, request())).not.toBe(base);
  });

  test('stays within the AWS clientToken budget including the retry suffix', () => {
    const token = statelessLaunchClientToken('exec_42', config(), 420, request());
    expect(`${token}-r1`.length).toBeLessThanOrEqual(128);
    expect(() => statelessLaunchClientToken('e'.repeat(200), config(), 420, request())).toThrow(
      'Stateless launch clientToken exceeds the AWS length limit',
    );
  });
});

describe('LambdaMicrovmSandboxBackend stateless execution', () => {
  test('run -> health -> execute -> terminate happy path', async () => {
    const fake = fakeClient();
    const backend = makeBackend(fake);
    const req = request();

    const result = await backend.execute(req, context());

    expect(result).toEqual(EXECUTE_RESPONSE);

    const runCalls = fake.callsFor('runMicrovm');
    expect(runCalls).toHaveLength(1);
    const runArgs = runCalls[0].args as { imageIdentifier: string; clientToken?: string; maximumDurationSeconds: number };
    expect(runArgs.imageIdentifier).toBe('arn:aws:lambda:us-east-2:1:microvm-image:codeapi');
    expect(runArgs.clientToken).toMatch(/^exec-exec_42-[0-9a-f]{16}$/);
    expect(runArgs.maximumDurationSeconds).toBe(Math.ceil(300_000 / 1_000) + 120);

    const executeReq = captured.find((c) => c.path === '/api/v2/execute');
    expect(executeReq).toBeDefined();
    expect(executeReq?.rawBody).toBe(JSON.stringify(req.body));
    const vm = [...fake.vms.values()][0];
    /* Input delivery mints its own tokens before the execute, so assert the
     * execute carried one of THIS VM's tokens rather than a fixed index. */
    expect(vm.mintedTokens).toContain(executeReq?.headers['x-aws-proxy-auth'] as string);

    expect(fake.callsFor('terminateMicrovm')).toHaveLength(1);
    expect(vm.state).toBe('TERMINATED');
  });

  test('health check runs before execute', async () => {
    const fake = fakeClient();
    await makeBackend(fake).execute(request(), context());
    const paths = captured.map((c) => c.path);
    expect(paths.indexOf('/api/v2/health')).toBeGreaterThanOrEqual(0);
    expect(paths.indexOf('/api/v2/health')).toBeLessThan(paths.indexOf('/api/v2/execute'));
  });

  test('health check runs before stateless input delivery', async () => {
    const fake = fakeClient();
    await makeBackend(fake).execute(request(), context());
    const paths = captured.map((c) => c.path);
    expect(paths.indexOf('/api/v2/health')).toBeLessThan(
      paths.indexOf('/api/v2/session/inputs/probe'),
    );
  });

  test('terminates the VM even when the execute is aborted mid-flight', async () => {
    const fake = fakeClient();
    executeDelayMs = 5_000;
    const controller = new AbortController();
    const pending = makeBackend(fake).execute(request(), context({ signal: controller.signal }));
    setTimeout(() => controller.abort(), 50);

    try {
      await pending;
      throw new Error('expected rejection');
    } catch (error) {
      expect(axios.isAxiosError(error)).toBe(true);
    }
    expect(fake.callsFor('terminateMicrovm')).toHaveLength(1);
  });

  test('launch poll timeout surfaces MICROVM_LAUNCH_FAILED and terminates the stuck VM', async () => {
    const fake = fakeClient();
    fake.delayNextLaunch(10_000);
    const backend = makeBackend(fake, { launchTimeoutMs: 60 });

    try {
      await backend.execute(request(), context());
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(SandboxBackendError);
      expect((error as SandboxBackendError).code).toBe('MICROVM_LAUNCH_FAILED');
    }
    expect(fake.callsFor('terminateMicrovm')).toHaveLength(1);
  });

  test('shares one launch budget across throttle, RunMicrovm, and control-plane polling', async () => {
    const fake = fakeClient();
    const runMicrovm = fake.runMicrovm.bind(fake);
    const getMicrovm = fake.getMicrovm.bind(fake);
    await mock.set('rtsx:tps:poison:run', '1', 'PX', 20);
    fake.delayNextLaunch(100);
    fake.runMicrovm = async (args) => {
      await new Promise(resolve => setTimeout(resolve, 30));
      return runMicrovm(args);
    };
    fake.getMicrovm = async (microvmId: string, signal?: AbortSignal) => {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        }, 200);
        const onAbort = (): void => {
          clearTimeout(timer);
          reject(signal?.reason ?? new Error('launch aborted'));
        };
        if (signal?.aborted) {
          onAbort();
        } else {
          signal?.addEventListener('abort', onAbort, { once: true });
        }
      });
      fake.setState(microvmId, 'RUNNING');
      return getMicrovm(microvmId);
    };

    await expect(
      makeBackend(fake, { launchTimeoutMs: 120 }).execute(request(), context()),
    ).rejects.toMatchObject({
      code: 'MICROVM_LAUNCH_FAILED',
      message: 'MicroVM launch did not reach RUNNING within 120ms',
      transient: false,
    });
    expect(captured.some(request => request.path === '/api/v2/execute')).toBe(false);
    expect(fake.callsFor('terminateMicrovm')).toHaveLength(1);
  });

  test('rejects and terminates a RUNNING response returned after the launch deadline', async () => {
    const fake = fakeClient();
    const runMicrovm = fake.runMicrovm.bind(fake);
    fake.runMicrovm = async (args) => {
      /* Models same-token reconciliation returning after the forward launch
       * signal expired: cleanup still needs the recovered VM id. */
      await new Promise(resolve => setTimeout(resolve, 80));
      return runMicrovm(args);
    };

    await expect(
      makeBackend(fake, { launchTimeoutMs: 40 }).execute(request(), context()),
    ).rejects.toMatchObject({
      code: 'MICROVM_LAUNCH_FAILED',
      message: 'MicroVM launch did not reach RUNNING within 40ms',
    });
    expect(captured.some(request => request.path === '/api/v2/execute')).toBe(false);
    expect(fake.callsFor('terminateMicrovm')).toHaveLength(1);
  });

  test('control-plane throttle surfaces MICROVM_LAUNCH_THROTTLED and poisons the run bucket', async () => {
    const fake = fakeClient();
    fake.failNext('runMicrovm', new LambdaMicrovmApiError('throttled', 'RunMicrovm', 'rate exceeded'));

    try {
      await makeBackend(fake).execute(request(), context());
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(SandboxBackendError);
      expect((error as SandboxBackendError).code).toBe('MICROVM_LAUNCH_THROTTLED');
    }
    expect(await mock.exists('rtsx:tps:poison:run')).toBe(1);
  });

  test('failed health check surfaces MICROVM_UNHEALTHY and terminates', async () => {
    const fake = fakeClient();
    healthStatus = 500;

    try {
      await makeBackend(fake).execute(request(), context());
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(SandboxBackendError);
      expect((error as SandboxBackendError).code).toBe('MICROVM_UNHEALTHY');
    }
    expect(fake.callsFor('terminateMicrovm')).toHaveLength(1);
  });

  test('refreshes an expiring proxy token while waiting for runner readiness', async () => {
    const fake = fakeClient();
    const mint = fake.createMicrovmAuthToken.bind(fake);
    let readinessMints = 0;
    healthStatus = 500;
    fake.createMicrovmAuthToken = async (args) => {
      readinessMints += 1;
      const token = await mint(args);
      if (readinessMints === 1) {
        return { ...token, expiresAtMs: Date.now() + 1 };
      }
      /* A second readiness mint is what makes the simulated runner ready.
       * Without rollover the first 500 repeats until launch timeout. */
      if (readinessMints === 2) healthStatus = 200;
      return token;
    };

    await expect(
      makeBackend(fake, { launchTimeoutMs: 250, healthTimeoutMs: 20 })
        .execute(request(), context()),
    ).resolves.toEqual(EXECUTE_RESPONSE);
    expect(readinessMints).toBeGreaterThanOrEqual(2);
  });

  test('does not mutate the signed request body', async () => {
    const fake = fakeClient();
    const req = request();
    const before = JSON.stringify(req.body);
    await makeBackend(fake).execute(req, context());
    expect(JSON.stringify(req.body)).toBe(before);
  });

  test('a MicroVM that dies during boot is retried once with a fresh clientToken', async () => {
    const fake = fakeClient();
    fake.terminateNextLaunch();

    const result = await makeBackend(fake).execute(request(), context());

    expect(result).toEqual(EXECUTE_RESPONSE);
    const runCalls = fake.callsFor('runMicrovm');
    expect(runCalls).toHaveLength(2);
    const tokens = runCalls.map((call) => (call.args as { clientToken?: string }).clientToken);
    expect(tokens[0]).toMatch(/^exec-exec_42-[0-9a-f]{16}$/);
    expect(tokens[1]).toBe(`${tokens[0]}-r1`);
  });

  test('the boot-death retry consumes only the first attempt remaining launch budget', async () => {
    const fake = fakeClient();
    const runMicrovm = fake.runMicrovm.bind(fake);
    fake.terminateNextLaunch();
    let attempt = 0;
    fake.runMicrovm = async (args) => {
      attempt += 1;
      await new Promise(resolve => setTimeout(resolve, attempt === 1 ? 100 : 250));
      return runMicrovm(args);
    };

    await expect(
      makeBackend(fake, { launchTimeoutMs: 300 }).execute(request(), context()),
    ).rejects.toMatchObject({
      code: 'MICROVM_LAUNCH_FAILED',
      message: 'MicroVM launch did not reach RUNNING within 300ms',
      transient: false,
    });
    const tokens = fake.callsFor('runMicrovm')
      .map(call => (call.args as { clientToken?: string }).clientToken);
    expect(tokens[0]).toMatch(/^exec-exec_42-[0-9a-f]{16}$/);
    expect(tokens).toEqual([tokens[0], `${tokens[0]}-r1`]);
    expect(captured.some(request => request.path === '/api/v2/execute')).toBe(false);
    expect(fake.callsFor('terminateMicrovm')).toHaveLength(2);
  });

  test('a second boot-time death fails the request — single retry only', async () => {
    const fake = fakeClient();
    fake.terminateNextLaunch();
    fake.terminateNextLaunch();

    await expect(makeBackend(fake).execute(request(), context())).rejects.toMatchObject({
      code: 'MICROVM_LAUNCH_FAILED',
    });
    expect(fake.callsFor('runMicrovm')).toHaveLength(2);
  });
});

describe('LambdaMicrovmSandboxBackend session execution', () => {
  test('retries transport failures while a suspended input endpoint resumes', async () => {
    const reservation = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => new Response('reserved'),
    });
    const port = reservation.port;
    reservation.stop(true);

    let lateServer: ReturnType<typeof Bun.serve> | undefined;
    const starter = setTimeout(() => {
      lateServer = Bun.serve({
        hostname: '127.0.0.1',
        port,
        fetch: () => new Response(JSON.stringify({ missing: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      });
    }, 25);

    const backend = makeBackend(fakeClient()) as unknown as {
      probeInputsWithRetry(
        args: {
          mintToken: () => Promise<{
            headerName: string;
            token: string;
            expiresAtMs: number;
          }>;
          endpointBase: string;
          signal?: AbortSignal;
        },
        refs: Array<{ cache_key: string }>,
        cfg: {
          port: number;
          authTokenTtlSeconds: number;
          maxBytes: number;
          timeoutMs: number;
        },
      ): Promise<Array<{ cache_key: string }>>;
    };

    try {
      await expect(backend.probeInputsWithRetry(
        {
          mintToken: async () => ({
            headerName: 'X-aws-proxy-auth',
            token: 'test-token',
            expiresAtMs: Date.now() + 60_000,
          }),
          endpointBase: `http://127.0.0.1:${port}`,
        },
        [{ cache_key: 'a'.repeat(64) }],
        {
          port: 8080,
          authTokenTtlSeconds: 300,
          maxBytes: 1024,
          timeoutMs: 500,
        },
      )).resolves.toEqual([]);
    } finally {
      clearTimeout(starter);
      lateServer?.stop(true);
    }
  });

  function sessionContext(overrides: Partial<SandboxExecuteContext> = {}): SandboxExecuteContext {
    return context({
      runtimeSessionId: 'rt_session_1',
      runtimeSessionMode: 'affinity',
      tenantId: 'tenant-a',
      canonicalUserId: 'user-1',
      ...overrides,
    });
  }

  test('launches a hookless session VM (idlePolicy, no runHookPayload) and stamps the workspace header on execute', async () => {
    const fake = fakeClient();
    const backend = makeBackend(fake);

    const result = await backend.execute(request(), sessionContext());
    expect(result).toEqual(EXECUTE_RESPONSE);

    const runArgs = fake.callsFor('runMicrovm')[0].args as {
      runHookPayload?: string;
      idlePolicy?: { autoResume: boolean; maxIdleSeconds: number };
      clientToken?: string;
      maximumDurationSeconds: number;
    };
    /* Session mode is delivered per-request via the header, never a /run hook
     * (image builds stay hookless), so RunMicrovm carries no runHookPayload. */
    expect(runArgs.runHookPayload).toBeUndefined();
    expect(runArgs.idlePolicy?.autoResume).toBe(true);
    expect(runArgs.clientToken).toBe(runtimeSessionLaunchClientToken(
      'rt_session_1',
      runtimeSessionLaunchGenerationSeed(config()),
    ));
    expect(runArgs.maximumDurationSeconds).toBe(28_800);

    const executeReq = captured.find((c) => c.path === '/api/v2/execute');
    expect(executeReq?.headers['x-runtime-session-id']).toBe('rt_session_1');

    const record = await readRuntimeSessionRecord('rt_session_1');
    expect(record?.state).toBe('RUNNING');
    expect(record?.microvm_id).toBe([...fake.vms.keys()][0]);
    expect(record?.generation).toBeGreaterThanOrEqual(RUNTIME_SESSION_NAMESPACED_GENERATION_MIN);
    expect(record?.launch_client_token).toBe(runArgs.clientToken);
  });

  test('replays a legacy recorded launch intent after the RunMicrovm response is lost', async () => {
    const fake = fakeClient();
    const cfg = config();
    const launchedAt = Date.now();
    const token = 'sess-rt_session_1-7';
    const accepted = await fake.runMicrovm({
      imageIdentifier: cfg.imageArn,
      imageVersion: cfg.imageVersion,
      executionRoleArn: cfg.executionRoleArn,
      logGroup: cfg.logGroup,
      ingressConnectorArns: cfg.ingressConnectorArns,
      egressConnectorArns: cfg.egressConnectorArns,
      maximumDurationSeconds: cfg.maxDurationSeconds,
      idlePolicy: {
        maxIdleSeconds: cfg.idleSeconds,
        suspendedSeconds: cfg.suspendedSeconds,
        autoResume: true,
      },
      clientToken: token,
    });
    /* Model a worker that persisted its intent and whose RunMicrovm reached AWS,
     * but died before it could record the returned MicroVM id. */
    await mock.set('rtsx:gen:rt_session_1', '7');
    const lock = await acquireRuntimeSessionLock('rt_session_1', 60_000);
    expect(lock).not.toBeNull();
    await writeRuntimeSessionRecord({
      runtime_session_id: 'rt_session_1',
      tenant_id: 'tenant-a',
      canonical_user_id: 'user-1',
      port: cfg.port,
      image_arn: cfg.imageArn,
      image_version: cfg.imageVersion,
      launch_fingerprint: runtimeSessionLaunchFingerprint(cfg),
      state: 'PENDING',
      generation: 7,
      launched_at: launchedAt,
      last_seen_at: launchedAt,
      hard_deadline_at: launchedAt + cfg.maxDurationSeconds * 1_000 - 60_000,
    }, lock as string);
    await releaseRuntimeSessionLock('rt_session_1', lock as string);

    const result = await makeBackend(fake).execute(request(), sessionContext());
    expect(result).toEqual(EXECUTE_RESPONSE);
    const runCalls = fake.callsFor('runMicrovm');
    expect(runCalls).toHaveLength(2);
    expect(runCalls.map(call => (call.args as { clientToken?: string }).clientToken))
      .toEqual([token, token]);
    expect(fake.vms.size).toBe(1);
    expect((await readRuntimeSessionRecord('rt_session_1'))?.microvm_id)
      .toBe(accepted.microvmId);
  });

  test('persists and replays the exact launch token after an ambiguous lost response', async () => {
    const fake = fakeClient();
    const acceptedRun = fake.runMicrovm.bind(fake);
    let loseResponse = true;
    fake.runMicrovm = async (args) => {
      const vm = await acceptedRun(args);
      if (loseResponse) {
        loseResponse = false;
        throw new LambdaMicrovmApiError('other', 'RunMicrovm', 'response lost after acceptance');
      }
      return vm;
    };

    await expect(makeBackend(fake).execute(request(), sessionContext())).rejects.toMatchObject({
      code: 'MICROVM_LAUNCH_FAILED',
    });
    const firstToken = (fake.callsFor('runMicrovm')[0].args as { clientToken?: string }).clientToken;
    const pending = await readRuntimeSessionRecord('rt_session_1');
    expect(pending?.state).toBe('PENDING');
    expect(pending?.launch_client_token).toBe(firstToken);

    await expect(makeBackend(fake).execute(request(), sessionContext()))
      .resolves.toEqual(EXECUTE_RESPONSE);
    const tokens = fake.callsFor('runMicrovm')
      .map(call => (call.args as { clientToken?: string }).clientToken);
    expect(tokens).toEqual([firstToken, firstToken]);
    expect(fake.vms.size).toBe(1);
  });

  test('migrates a poisoned legacy PENDING token after a validation rejection', async () => {
    const fake = fakeClient();
    const oldCfg = config();
    const newCfg = config({ imageVersion: '4' });
    const legacyToken = 'sess-rt_session_1-1';
    const oldVm = await fake.runMicrovm({
      imageIdentifier: oldCfg.imageArn,
      imageVersion: oldCfg.imageVersion,
      executionRoleArn: oldCfg.executionRoleArn,
      logGroup: oldCfg.logGroup,
      ingressConnectorArns: oldCfg.ingressConnectorArns,
      egressConnectorArns: oldCfg.egressConnectorArns,
      maximumDurationSeconds: oldCfg.maxDurationSeconds,
      idlePolicy: {
        maxIdleSeconds: oldCfg.idleSeconds,
        suspendedSeconds: oldCfg.suspendedSeconds,
        autoResume: true,
      },
      clientToken: legacyToken,
    });
    await fake.terminateMicrovm(oldVm.microvmId);

    const launchedAt = Date.now();
    const lock = await acquireRuntimeSessionLock('rt_session_1', 60_000);
    expect(lock).not.toBeNull();
    await writeRuntimeSessionRecord({
      runtime_session_id: 'rt_session_1',
      tenant_id: 'tenant-a',
      canonical_user_id: 'user-1',
      port: newCfg.port,
      image_arn: newCfg.imageArn,
      image_version: newCfg.imageVersion,
      launch_fingerprint: runtimeSessionLaunchFingerprint(newCfg),
      state: 'PENDING',
      generation: 1,
      launched_at: launchedAt,
      last_seen_at: launchedAt,
      hard_deadline_at: launchedAt + newCfg.maxDurationSeconds * 1_000 - 60_000,
    }, lock as string);
    await releaseRuntimeSessionLock('rt_session_1', lock as string);

    /* First patched worker dies ambiguously after persisting the replay intent.
     * It must not erase the fact that this is still a legacy token. */
    fake.failNext(
      'runMicrovm',
      new LambdaMicrovmApiError('other', 'RunMicrovm', 'connection lost before response'),
    );
    await expect(makeBackend(fake, { imageVersion: '4' }).execute(request(), sessionContext()))
      .rejects.toMatchObject({ code: 'MICROVM_LAUNCH_FAILED' });
    const stillLegacy = await readRuntimeSessionRecord('rt_session_1');
    expect(stillLegacy?.generation).toBe(1);
    expect(stillLegacy?.launch_client_token).toBeUndefined();

    await expect(makeBackend(fake, { imageVersion: '4' }).execute(request(), sessionContext()))
      .resolves.toEqual(EXECUTE_RESPONSE);
    const tokens = fake.callsFor('runMicrovm')
      .map(call => (call.args as { clientToken?: string }).clientToken);
    expect(tokens.slice(0, 3)).toEqual([legacyToken, legacyToken, legacyToken]);
    expect(tokens[3]).not.toBe(legacyToken);
    const record = await readRuntimeSessionRecord('rt_session_1');
    expect(record?.generation).toBeGreaterThanOrEqual(RUNTIME_SESSION_NAMESPACED_GENERATION_MIN);
    expect(record?.launch_client_token).toBe(tokens[3]);
  });

  test('uses a distinct launch token after registry loss and an image upgrade', async () => {
    const fake = fakeClient();
    await makeBackend(fake).execute(request(), sessionContext());
    const firstVmId = [...fake.vms.keys()][0];
    const firstToken = (fake.callsFor('runMicrovm')[0].args as { clientToken?: string }).clientToken;

    /* Model the documented recycle boundary: the old VM is drained and the
     * volatile registry (including its generation counter) is lost, while the
     * provider retains its client-token idempotency history. */
    await fake.terminateMicrovm(firstVmId);
    await mock.del('rtsx:sess:rt_session_1', 'rtsx:gen:rt_session_1');

    await expect(
      makeBackend(fake, { imageVersion: '4' }).execute(request(), sessionContext()),
    ).resolves.toEqual(EXECUTE_RESPONSE);

    const runCalls = fake.callsFor('runMicrovm');
    expect(runCalls).toHaveLength(2);
    const secondToken = (runCalls[1].args as { clientToken?: string }).clientToken;
    expect(secondToken).not.toBe(firstToken);
    expect(secondToken?.length).toBeLessThanOrEqual(128);
    expect((await readRuntimeSessionRecord('rt_session_1'))?.image_version).toBe('4');
  });

  test('does not replay a persisted token when the exact connector request changed', async () => {
    const fake = fakeClient();
    const firstRun = fake.runMicrovm.bind(fake);
    let loseResponse = true;
    fake.runMicrovm = async (args) => {
      const vm = await firstRun(args);
      if (loseResponse) {
        loseResponse = false;
        throw new LambdaMicrovmApiError('other', 'RunMicrovm', 'response lost after acceptance');
      }
      return vm;
    };
    const firstConnectors = [
      'arn:aws:lambda:us-east-2:1:network-connector:z',
      'arn:aws:lambda:us-east-2:1:network-connector:a',
    ];
    await expect(makeBackend(fake, { egressConnectorArns: firstConnectors })
      .execute(request(), sessionContext())).rejects.toMatchObject({
      code: 'MICROVM_LAUNCH_FAILED',
    });
    const pending = await readRuntimeSessionRecord('rt_session_1');
    expect(pending?.launch_request_fingerprint).toBeDefined();

    await expect(makeBackend(fake, { egressConnectorArns: [...firstConnectors].reverse() })
      .execute(request(), sessionContext())).resolves.toEqual(EXECUTE_RESPONSE);
    const tokens = fake.callsFor('runMicrovm')
      .map(call => (call.args as { clientToken?: string }).clientToken);
    expect(tokens).toHaveLength(2);
    expect(tokens[1]).not.toBe(tokens[0]);
  });

  test('terminalizes two known-dead launch tokens without losing the checkpoint pointer', async () => {
    const fake = fakeClient();
    const cfg = config();
    const lock = await acquireRuntimeSessionLock('rt_session_1', 60_000);
    expect(lock).not.toBeNull();
    await writeRuntimeSessionRecord({
      runtime_session_id: 'rt_session_1',
      tenant_id: 'tenant-a',
      canonical_user_id: 'user-1',
      port: cfg.port,
      image_arn: cfg.imageArn,
      image_version: cfg.imageVersion,
      launch_fingerprint: runtimeSessionLaunchFingerprint(cfg),
      state: 'TERMINATED',
      generation: 1,
      last_seen_at: Date.now(),
      workspace_checkpoint: 'sessions/rt_session_1/checkpoints/redis-only.gtar',
      checkpointed_at: Date.now(),
    }, lock as string);
    await releaseRuntimeSessionLock('rt_session_1', lock as string);
    fake.terminateNextLaunch();
    fake.terminateNextLaunch();

    await expect(makeBackend(fake).execute(request(), sessionContext())).rejects.toMatchObject({
      code: 'MICROVM_LAUNCH_FAILED',
    });
    const retired = await readRuntimeSessionRecord('rt_session_1');
    expect(retired?.state).toBe('TERMINATED');
    expect(retired?.workspace_checkpoint)
      .toBe('sessions/rt_session_1/checkpoints/redis-only.gtar');

    await expect(makeBackend(fake).execute(request(), sessionContext()))
      .resolves.toEqual(EXECUTE_RESPONSE);
    const tokens = fake.callsFor('runMicrovm')
      .map(call => (call.args as { clientToken?: string }).clientToken as string);
    expect(tokens).toHaveLength(3);
    expect(tokens[1]).toBe(`${tokens[0]}-r1`);
    expect(tokens[2]).not.toBe(tokens[0]);
    expect((await readRuntimeSessionRecord('rt_session_1'))?.state).toBe('RUNNING');
  });

  test('does not retry an unrelated validation rejection', async () => {
    const fake = fakeClient();
    fake.failNext(
      'runMicrovm',
      new LambdaMicrovmApiError('validation', 'RunMicrovm', 'bad connector'),
    );
    await expect(makeBackend(fake).execute(request(), sessionContext())).rejects.toMatchObject({
      code: 'MICROVM_LAUNCH_FAILED',
    });
    expect(fake.callsFor('runMicrovm')).toHaveLength(1);
  });

  test('bounds an unstructured legacy validation fallback to one migrated token', async () => {
    const fake = fakeClient();
    const cfg = config();
    const launchedAt = Date.now();
    const lock = await acquireRuntimeSessionLock('rt_session_1', 60_000);
    expect(lock).not.toBeNull();
    await writeRuntimeSessionRecord({
      runtime_session_id: 'rt_session_1',
      tenant_id: 'tenant-a',
      canonical_user_id: 'user-1',
      port: cfg.port,
      image_arn: cfg.imageArn,
      image_version: cfg.imageVersion,
      launch_fingerprint: runtimeSessionLaunchFingerprint(cfg),
      state: 'PENDING',
      generation: 7,
      launched_at: launchedAt,
      last_seen_at: launchedAt,
      hard_deadline_at: launchedAt + cfg.maxDurationSeconds * 1_000 - 60_000,
    }, lock as string);
    await releaseRuntimeSessionLock('rt_session_1', lock as string);

    fake.failNext('runMicrovm', new LambdaMicrovmApiError('validation', 'RunMicrovm', 'bad role'));
    fake.failNext('runMicrovm', new LambdaMicrovmApiError('validation', 'RunMicrovm', 'bad role'));
    await expect(makeBackend(fake).execute(request(), sessionContext())).rejects.toMatchObject({
      code: 'MICROVM_LAUNCH_FAILED',
    });
    expect(fake.callsFor('runMicrovm')).toHaveLength(2);
    const migrated = await readRuntimeSessionRecord('rt_session_1');
    expect(migrated?.generation).toBeGreaterThanOrEqual(RUNTIME_SESSION_NAMESPACED_GENERATION_MIN);
    expect(migrated?.launch_client_token).toBeDefined();
    expect(migrated?.launch_request_fingerprint).toBeDefined();

    fake.failNext('runMicrovm', new LambdaMicrovmApiError('validation', 'RunMicrovm', 'bad role'));
    await expect(makeBackend(fake).execute(request(), sessionContext())).rejects.toMatchObject({
      code: 'MICROVM_LAUNCH_FAILED',
    });
    expect(fake.callsFor('runMicrovm')).toHaveLength(3);
    const thirdToken = (fake.callsFor('runMicrovm')[2].args as { clientToken?: string }).clientToken;
    expect(thirdToken).toBe(migrated?.launch_client_token);
  });

  test('reuses the warm VM on the second execution (no second RunMicrovm)', async () => {
    const fake = fakeClient();
    const backend = makeBackend(fake);

    await backend.execute(request(), sessionContext());
    await backend.execute(request(), sessionContext());

    expect(fake.callsFor('runMicrovm')).toHaveLength(1);
    expect(fake.callsFor('terminateMicrovm')).toHaveLength(0);
    const executes = captured.filter((c) => c.path === '/api/v2/execute');
    expect(executes).toHaveLength(2);
  });

  test('a reused VM skips the preflight health check so a slow auto-resume can proceed', async () => {
    const fake = fakeClient();
    const backend = makeBackend(fake);
    await backend.execute(request(), sessionContext());
    captured = [];
    await backend.execute(request(), sessionContext());
    /* The warm/suspended VM auto-resumes on the execute itself under the full
     * job budget; a 5s health probe would misclassify a slow resume as
     * unhealthy and tear the VM down. */
    expect(captured.filter((c) => c.path === '/api/v2/health')).toHaveLength(0);
    expect(captured.filter((c) => c.path === '/api/v2/execute')).toHaveLength(1);
  });

  test('a runner non-2xx keeps the warm VM (does not tear down the session)', async () => {
    const fake = fakeClient();
    const backend = makeBackend(fake);
    await backend.execute(request(), sessionContext());
    executeStatus = 500;
    /* The runner responded (500) — the VM is alive, only the request failed —
     * so the session must NOT be terminated (regression: the error-classifier
     * previously tore down any error that wasn't literally "Error from sandbox"). */
    await expect(backend.execute(request(), sessionContext())).rejects.toThrow();
    expect(fake.callsFor('terminateMicrovm')).toHaveLength(0);
    const record = await readRuntimeSessionRecord('rt_session_1');
    expect(record?.state).toBe('RUNNING');
  });

  test('an unrelated runner 409 keeps the warm VM', async () => {
    const fake = fakeClient();
    const backend = makeBackend(fake);
    await backend.execute(request(), sessionContext());
    executeStatus = 409;
    executeResponseBody = {
      error: 'request_conflict',
      message: 'The request conflicts with current state',
    };

    await expect(backend.execute(request(), sessionContext())).rejects.toThrow();
    expect(fake.callsFor('terminateMicrovm')).toHaveLength(0);
    expect((await readRuntimeSessionRecord('rt_session_1'))?.state).toBe('RUNNING');
  });

  test('a partial-prime signal recycles the dirty session workspace', async () => {
    const fake = fakeClient();
    const backend = makeBackend(fake);
    await backend.execute(request(), sessionContext());
    executeStatus = 409;
    executeResponseBody = {
      error: 'session_workspace_dirty',
      message: 'Session workspace must be restored',
    };

    try {
      await backend.execute(request(), sessionContext());
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(SandboxBackendError);
      expect((error as SandboxBackendError).code).toBe('MICROVM_UNHEALTHY');
    }
    expect(fake.callsFor('terminateMicrovm')).toHaveLength(1);
    const recycled = await readRuntimeSessionRecord('rt_session_1');
    expect(recycled?.state).toBe('TERMINATED');
    expect(recycled?.microvm_id).toBeUndefined();

    executeStatus = 200;
    executeResponseBody = EXECUTE_RESPONSE;
    await expect(backend.execute(request(), sessionContext())).resolves.toEqual(EXECUTE_RESPONSE);
    expect(fake.callsFor('runMicrovm')).toHaveLength(2);
  });

  test('a legacy untagged session-binding conflict recycles the mismatched runner', async () => {
    const fake = fakeClient();
    const backend = makeBackend(fake);
    await backend.execute(request(), sessionContext());
    executeStatus = 409;
    executeResponseBody = {
      message: 'Runner is bound to a different runtime session',
    };

    await expect(backend.execute(request(), sessionContext())).rejects.toMatchObject({
      code: 'MICROVM_UNHEALTHY',
    });
    expect(fake.callsFor('terminateMicrovm')).toHaveLength(1);
    const recycled = await readRuntimeSessionRecord('rt_session_1');
    expect(recycled?.state).toBe('TERMINATED');
    expect(recycled?.microvm_id).toBeUndefined();
    expect(recycled?.last_error).toBe('session_binding_conflict');

    executeStatus = 200;
    executeResponseBody = EXECUTE_RESPONSE;
    await expect(backend.execute(request(), sessionContext())).resolves.toEqual(EXECUTE_RESPONSE);
    expect(fake.callsFor('runMicrovm')).toHaveLength(2);
  });

  test('an aborted input probe remains a typed timeout and keeps the warm session reusable', async () => {
    const fake = fakeClient();
    const backend = makeBackend(fake);
    await backend.execute(request(), sessionContext());
    captured = [];
    sessionProbeDelayMs = 100;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10);

    try {
      await expect(
        backend.execute(request(), sessionContext({ signal: controller.signal })),
      ).rejects.toMatchObject({
        code: 'SESSION_INPUT_ABORTED',
      });
    } finally {
      clearTimeout(timer);
    }
    expect(captured.filter((c) => c.path === '/api/v2/execute')).toHaveLength(0);
    expect(fake.callsFor('terminateMicrovm')).toHaveLength(0);
    expect((await readRuntimeSessionRecord('rt_session_1'))?.state).toBe('RUNNING');
  });

  test('probes the VM and pushes only what it is missing', async () => {
    const fake = fakeClient();
    const backend = makeBackend(fake);
    await backend.execute(request(), sessionContext());

    const paths = captured.map((c) => c.path);
    expect(paths.indexOf('/api/v2/session/inputs/probe')).toBeGreaterThanOrEqual(0);
    expect(paths.indexOf('/api/v2/session/inputs')).toBeGreaterThan(
      paths.indexOf('/api/v2/session/inputs/probe'),
    );
    expect(paths.indexOf('/api/v2/session/inputs')).toBeLessThan(paths.indexOf('/api/v2/execute'));
    const push = captured.find((request) => request.path === '/api/v2/session/inputs');
    expect(Number(push?.headers['x-codeapi-input-expanded-bytes'])).toBe(
      Buffer.byteLength(fileObjectBytes)
      + Buffer.byteLength(JSON.stringify({ readOnly: false })),
    );
    /* Objects are pushed under runner-computed digests, and carry only
     * object-level metadata: no caller-supplied path appears anywhere in the
     * batch, so nothing in delivery can act on one. */
    const untarred = zlib.gunzipSync(lastSessionFilesBody!).toString('latin1');
    expect(untarred).toMatch(/[0-9a-f]{64}/);
    expect(untarred).not.toContain('inputs/data.csv');
  });

  test('a second execution pushes nothing when the VM already holds the object', async () => {
    const fake = fakeClient();
    const backend = makeBackend(fake);
    await backend.execute(request(), sessionContext());
    captured = [];
    await backend.execute(request(), sessionContext());

    /* Dedupe is the VM's answer, not control-plane bookkeeping — so it stays
     * correct across record loss, and a re-push could never revert an edit
     * anyway (this path does not write the workspace). */
    expect(captured.filter((c) => c.path === '/api/v2/session/inputs/probe')).toHaveLength(1);
    expect(captured.filter((c) => c.path === '/api/v2/session/inputs')).toHaveLength(0);
  });

  test('a stateless one-shot receives its by-ref inputs too', async () => {
    const fake = fakeClient();
    const backend = makeBackend(fake);
    await backend.execute(request(), context());

    /* The cache is keyed by object, not session, so the same mechanism serves
     * stateless execution — which previously ran with its inputs missing. */
    const paths = captured.map((c) => c.path);
    expect(paths.indexOf('/api/v2/session/inputs')).toBeGreaterThanOrEqual(0);
    expect(paths.indexOf('/api/v2/session/inputs')).toBeLessThan(paths.indexOf('/api/v2/execute'));
  });

  test('a live runner rejecting an input push keeps the warm session VM', async () => {
    const fake = fakeClient();
    const backend = makeBackend(fake);
    sessionFilesStatus = 500;

    await expect(backend.execute(request(), sessionContext())).rejects.toThrow(
      'Session input push failed',
    );
    expect(captured.filter((c) => c.path === '/api/v2/execute')).toHaveLength(0);
    expect(fake.callsFor('terminateMicrovm')).toHaveLength(0);
    expect((await readRuntimeSessionRecord('rt_session_1'))?.state).toBe('RUNNING');
  });

  test('a proxy 502 during input push recycles the unreachable session VM', async () => {
    const fake = fakeClient();
    const backend = makeBackend(fake);
    sessionFilesStatus = 502;

    await expect(backend.execute(request(), sessionContext())).rejects.toThrow(
      'Session input push failed',
    );
    expect(captured.filter((c) => c.path === '/api/v2/execute')).toHaveLength(0);
    expect(fake.callsFor('terminateMicrovm')).toHaveLength(1);
    expect(await readRuntimeSessionRecord('rt_session_1')).toBeNull();
  });

  test('a probe token throttle preserves its code and keeps the warm session VM', async () => {
    const fake = fakeClient();
    const backend = makeBackend(fake);
    await backend.execute(request(), sessionContext());
    vmInputCache.clear();
    captured = [];
    fake.failNext(
      'createMicrovmAuthToken',
      new LambdaMicrovmApiError('throttled', 'CreateMicrovmAuthToken', 'rate exceeded'),
    );

    await expect(backend.execute(request(), sessionContext())).rejects.toMatchObject({
      code: 'MICROVM_LAUNCH_THROTTLED',
    });
    expect(captured.filter((c) => c.path === '/api/v2/execute')).toHaveLength(0);
    expect(fake.callsFor('terminateMicrovm')).toHaveLength(0);
    expect((await readRuntimeSessionRecord('rt_session_1'))?.state).toBe('RUNNING');
  });

  test('a push token throttle preserves its code and keeps the warm session VM', async () => {
    const fake = fakeClient();
    const backend = makeBackend(fake);
    await backend.execute(request(), sessionContext());
    vmInputCache.clear();
    captured = [];

    const mint = fake.createMicrovmAuthToken.bind(fake);
    let deliveryMints = 0;
    fake.createMicrovmAuthToken = async (args) => {
      deliveryMints += 1;
      if (deliveryMints === 2) {
        throw new LambdaMicrovmApiError(
          'throttled',
          'CreateMicrovmAuthToken',
          'rate exceeded',
        );
      }
      return mint(args);
    };

    await expect(backend.execute(request(), sessionContext())).rejects.toMatchObject({
      code: 'MICROVM_LAUNCH_THROTTLED',
    });
    expect(captured.filter((c) => c.path === '/api/v2/execute')).toHaveLength(0);
    expect(fake.callsFor('terminateMicrovm')).toHaveLength(0);
    expect((await readRuntimeSessionRecord('rt_session_1'))?.state).toBe('RUNNING');
  });

  test('a source-object failure never recycles a healthy warm session VM', async () => {
    const fake = fakeClient();
    const backend = makeBackend(fake);
    await backend.execute(request(), sessionContext());
    vmInputCache.clear();
    fileObjectStatus = 404;
    captured = [];

    await expect(backend.execute(request(), sessionContext())).rejects.toMatchObject({
      code: 'SESSION_INPUT_UNAVAILABLE',
    });
    expect(captured.filter((c) => c.path === '/api/v2/execute')).toHaveLength(0);
    expect(fake.callsFor('terminateMicrovm')).toHaveLength(0);
    expect((await readRuntimeSessionRecord('rt_session_1'))?.state).toBe('RUNNING');
  });

  test('an oversized input returns a typed limit error and keeps the warm session VM', async () => {
    const fake = fakeClient();
    const backend = makeBackend(fake, {
      checkpoint: { ...config().checkpoint, maxBytes: 1 },
    });
    const warmup = request();
    warmup.body = { ...warmup.body, files: [] };
    await backend.execute(warmup, sessionContext());
    captured = [];

    await expect(backend.execute(request(), sessionContext())).rejects.toMatchObject({
      code: 'SESSION_INPUT_TOO_LARGE',
    });
    expect(captured.filter((c) => c.path === '/api/v2/execute')).toHaveLength(0);
    expect(fake.callsFor('terminateMicrovm')).toHaveLength(0);
    expect((await readRuntimeSessionRecord('rt_session_1'))?.state).toBe('RUNNING');
  });

  test('rejects a probe response containing an unrequested cache key', async () => {
    const fake = fakeClient();
    probeMissingOverride = [{ cache_key: 'f'.repeat(64) }];

    await expect(makeBackend(fake).execute(request(), sessionContext())).rejects.toThrow(
      'Session input delivery failed',
    );
    expect(captured.filter((c) => c.path === '/api/v2/execute')).toHaveLength(0);
    expect(fake.callsFor('terminateMicrovm')).toHaveLength(0);
  });

  test('re-probes the full working set after push and never executes after eviction', async () => {
    const fake = fakeClient();
    evictAfterPush = true;

    await expect(makeBackend(fake).execute(request(), sessionContext())).rejects.toThrow(
      'working set',
    );
    const paths = captured.map((c) => c.path);
    const pushIndex = paths.indexOf('/api/v2/session/inputs');
    expect(pushIndex).toBeGreaterThanOrEqual(0);
    expect(paths.lastIndexOf('/api/v2/session/inputs/probe')).toBeGreaterThan(pushIndex);
    expect(paths).not.toContain('/api/v2/execute');
  });

  test('a payload with no by-ref inputs skips probe and push entirely', async () => {
    const fake = fakeClient();
    const req = request();
    req.body.files = [{ name: 'inline.txt', content: 'inline' }];
    await makeBackend(fake).execute(req, sessionContext());
    expect(captured.filter((c) => c.path.startsWith('/api/v2/session/inputs'))).toHaveLength(0);
  });

  test('lock contention is retryable BUSY, never a cold one-shot', async () => {
    const fake = fakeClient();
    const backend = makeBackend(fake, { lockWaitMs: 10 });
    await acquireRuntimeSessionLock('rt_session_1', 60_000);

    /* A session-bound request depends on workspace state a fresh VM lacks —
     * packages, files, database state — so answering from one would be
     * silently wrong regardless of whether THIS payload carries refs. */
    for (const mode of ['affinity', 'strict'] as const) {
      await expect(
        backend.execute(request(), sessionContext({ runtimeSessionMode: mode })),
      ).rejects.toThrow('busy');
    }
    expect(captured.filter((c) => c.path === '/api/v2/execute')).toHaveLength(0);
  });

  test('an aborted stateful execute bounds hung registry work and still bounds lock cleanup', async () => {
    const fake = fakeClient();
    const backend = makeBackend(fake);
    const scripted = mock as unknown as {
      get(key: string): Promise<string | null>;
      releaseRuntimeSessionLockScript(lockKey: string, token: string): Promise<number>;
    };
    scripted.get = async () => new Promise(() => {});
    let releaseCalls = 0;
    scripted.releaseRuntimeSessionLockScript = async () => {
      releaseCalls += 1;
      return new Promise(() => {});
    };
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('job deadline')), 20);
    const started = Date.now();

    await expect(
      backend.execute(request(), sessionContext({ signal: controller.signal })),
    ).rejects.toThrow('job deadline');

    /* Forward Redis work inherits the job signal, while final lock release
     * deliberately uses its own two-second cleanup budget. */
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(releaseCalls).toBe(1);
    expect(fake.callsFor('runMicrovm')).toHaveLength(0);
  });

  test('a fresh session VM returning a proxy 502 is recycled immediately', async () => {
    const fake = fakeClient();
    const backend = makeBackend(fake);
    executeStatus = 502;

    await expect(backend.execute(request(), sessionContext())).rejects.toThrow();
    expect(fake.callsFor('terminateMicrovm')).toHaveLength(1);
    expect(await readRuntimeSessionRecord('rt_session_1')).toBeNull();
  });

  test('a reused VM returning a proxy 502 (failed auto-resume) is recycled', async () => {
    const fake = fakeClient();
    const backend = makeBackend(fake);
    await backend.execute(request(), sessionContext());
    /* 502/503/504 is the AWS proxy reporting the VM unreachable (a suspended VM
     * that failed to auto-resume), not the runner rejecting the request — so the
     * dead VM must be torn down, unlike a runner 500. */
    executeStatus = 502;
    await expect(backend.execute(request(), sessionContext())).rejects.toThrow();
    expect(fake.callsFor('terminateMicrovm')).toHaveLength(1);
    expect(await readRuntimeSessionRecord('rt_session_1')).toBeNull();
  });

  test('relaunches an idle-expired session instead of reusing the dead endpoint', async () => {
    const fake = fakeClient();
    const backend = makeBackend(fake);
    await backend.execute(request(), sessionContext());
    /* Backdate last_seen past idle+suspended: AWS would have auto-terminated the
     * VM, so the next request must relaunch rather than reuse the stale RUNNING
     * endpoint (which would health-check-fail and 503 the first request). */
    const token = (await acquireRuntimeSessionLock('rt_session_1', 60_000)) as string;
    const rec = await readRuntimeSessionRecord('rt_session_1');
    await writeRuntimeSessionRecord({ ...rec!, last_seen_at: 1 }, token);
    const { releaseRuntimeSessionLock } = await import('../runtime-session/registry');
    await releaseRuntimeSessionLock('rt_session_1', token);
    await backend.execute(request(), sessionContext());
    expect(fake.callsFor('runMicrovm')).toHaveLength(2);
    expect(fake.callsFor('terminateMicrovm')).toHaveLength(1);
  });

  test('two concurrent executions on one session serialize on the registry lock', async () => {
    const fake = fakeClient();
    const backend = makeBackend(fake);

    const [a, b] = await Promise.all([
      backend.execute(request(), sessionContext()),
      backend.execute(request(), sessionContext()),
    ]);
    expect(a).toEqual(EXECUTE_RESPONSE);
    expect(b).toEqual(EXECUTE_RESPONSE);
    /* Serialized launch: exactly one VM created, reused by the other. */
    expect(fake.callsFor('runMicrovm')).toHaveLength(1);
  });

  test('a fenced post-execute record write fails instead of returning stale session state', async () => {
    const fake = fakeClient();
    const backend = makeBackend(fake);
    stealSessionLockOnExecute = true;

    try {
      await backend.execute(request(), sessionContext());
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(SandboxBackendError);
      expect((error as SandboxBackendError).code).toBe('MICROVM_FENCED');
    }
    expect(fake.callsFor('terminateMicrovm')).toHaveLength(1);
  });

  test('a missing post-execute session record fences and terminates the known VM', async () => {
    const fake = fakeClient();
    const backend = makeBackend(fake);
    onExecute = async () => {
      await mock.del('rtsx:sess:rt_session_1');
    };

    try {
      await backend.execute(request(), sessionContext());
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(SandboxBackendError);
      expect((error as SandboxBackendError).code).toBe('MICROVM_FENCED');
    }
    expect(fake.callsFor('terminateMicrovm')).toHaveLength(1);
    expect(await readRuntimeSessionRecord('rt_session_1')).toBeNull();
  });

  test('strict mode raises RUNTIME_SESSION_BUSY when the lock is held', async () => {
    const fake = fakeClient();
    const backend = makeBackend(fake, { lockWaitMs: 100 });
    const held = await acquireRuntimeSessionLock('rt_session_1', 60_000);
    expect(held).not.toBeNull();

    try {
      await backend.execute(request(), sessionContext({ runtimeSessionMode: 'strict' }));
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(SandboxBackendError);
      expect((error as SandboxBackendError).code).toBe('RUNTIME_SESSION_BUSY');
    }
  });


  test('stateless mode ignores a runtime session id', async () => {
    const fake = fakeClient();
    const backend = makeBackend(fake);
    await backend.execute(request(), sessionContext({ runtimeSessionMode: 'stateless' }));
    const runArgs = fake.callsFor('runMicrovm')[0].args as { runHookPayload?: string };
    expect(runArgs.runHookPayload).toBeUndefined();
    expect(fake.callsFor('terminateMicrovm')).toHaveLength(1);
    expect(await readRuntimeSessionRecord('rt_session_1')).toBeNull();
  });

  test('session mode refuses an unpinned image version before launch', async () => {
    const fake = fakeClient();
    await expect(
      makeBackend(fake, { imageVersion: undefined }).execute(request(), sessionContext()),
    ).rejects.toThrow('pinned LAMBDA_MICROVM_IMAGE_VERSION');
    expect(fake.callsFor('runMicrovm')).toHaveLength(0);
  });

  test('sends X-aws-proxy-port only when the port is not the 8080 default', async () => {
    const fake = fakeClient();
    await makeBackend(fake, { port: 9090 }).execute(request(), sessionContext());
    const exec = captured.find((c) => c.path === '/api/v2/execute');
    /* Non-default port needs the routing header, or AWS sends traffic to 8080. */
    expect(exec?.headers['x-aws-proxy-port']).toBe('9090');

    captured = [];
    await makeBackend(fake, { port: 8080 }).execute(request(), sessionContext({ runtimeSessionId: 'rt_8080' }));
    const exec8080 = captured.find((c) => c.path === '/api/v2/execute');
    expect(exec8080?.headers['x-aws-proxy-port']).toBeUndefined();
  });

  test('a reused VM whose token mint returns not_found is torn down and the record dropped', async () => {
    const fake = fakeClient();
    const backend = makeBackend(fake);
    await backend.execute(request(), sessionContext());
    /* The VM was evicted between calls: CreateMicrovmAuthToken now 404s. That
     * escapes raw today; it must surface as MICROVM_UNHEALTHY so the dead VM is
     * terminated and its record dropped, and the next call relaunches. */
    fake.failNext('createMicrovmAuthToken', new LambdaMicrovmApiError('not_found', 'CreateMicrovmAuthToken', 'gone'));
    await expect(backend.execute(request(), sessionContext())).rejects.toBeInstanceOf(SandboxBackendError);
    expect(fake.callsFor('terminateMicrovm')).toHaveLength(1);
    expect(await readRuntimeSessionRecord('rt_session_1')).toBeNull();
  });

  test('terminates a superseded (config-drifted) VM before relaunching', async () => {
    const fake = fakeClient();
    await makeBackend(fake).execute(request(), sessionContext());
    const oldVmId = [...fake.vms.keys()][0];
    /* A deploy bumps the image version: the recorded VM no longer matches config,
     * so it must be terminated (not left running/billing) before the replacement
     * launches. */
    await makeBackend(fake, { imageVersion: '4' }).execute(request(), sessionContext());
    expect(fake.callsFor('runMicrovm')).toHaveLength(2);
    const terminated = fake.callsFor('terminateMicrovm').map((c) => (c.args as { microvmId: string }).microvmId);
    expect(terminated).toContain(oldVmId);
  });

  test('provider not-found while terminating a stale VM still permits relaunch', async () => {
    const fake = fakeClient();
    await makeBackend(fake).execute(request(), sessionContext());
    fake.failNext(
      'terminateMicrovm',
      new LambdaMicrovmApiError('not_found', 'TerminateMicrovm', 'already gone'),
    );

    await makeBackend(fake, { imageVersion: '4' }).execute(request(), sessionContext());
    expect(fake.callsFor('runMicrovm')).toHaveLength(2);
    expect((await readRuntimeSessionRecord('rt_session_1'))?.image_version).toBe('4');
  });

  test('launch-record failure after RunMicrovm terminates the untracked VM', async () => {
    const fake = fakeClient();
    const redisWithScript = mock as unknown as {
      writeRuntimeSessionRecordScript: (...args: string[]) => Promise<number>;
    };
    const originalWrite = redisWithScript.writeRuntimeSessionRecordScript.bind(mock);
    let writes = 0;
    redisWithScript.writeRuntimeSessionRecordScript = async (...args: string[]) => {
      writes += 1;
      if (writes === 2) throw new Error('Redis unavailable after launch');
      return originalWrite(...args);
    };

    await expect(makeBackend(fake).execute(request(), sessionContext())).rejects.toThrow(
      'Lost session lock for rt_session_1 after launch',
    );
    expect(fake.callsFor('runMicrovm')).toHaveLength(1);
    expect(fake.callsFor('terminateMicrovm')).toHaveLength(1);
  });

  test('a tightened egress connector config makes an existing session non-reusable', async () => {
    const fake = fakeClient();
    await makeBackend(fake).execute(request(), sessionContext());
    const oldVmId = [...fake.vms.keys()][0];
    /* Connectors apply only at RunMicrovm, so a hardened deploy that tightens
     * egress must relaunch rather than keep serving on the old broader policy. */
    await makeBackend(fake, {
      egressConnectorArns: ['arn:aws:lambda:us-east-2:1:network-connector:vpc-egress'],
    }).execute(request(), sessionContext());
    expect(fake.callsFor('runMicrovm')).toHaveLength(2);
    const terminated = fake.callsFor('terminateMicrovm').map((c) => (c.args as { microvmId: string }).microvmId);
    expect(terminated).toContain(oldVmId);
  });
});

describe('LambdaMicrovmSandboxBackend auto-checkpoint', () => {
  function sessionContext(overrides: Partial<SandboxExecuteContext> = {}): SandboxExecuteContext {
    return context({
      runtimeSessionId: 'rt_ckpt_1',
      runtimeSessionMode: 'affinity',
      tenantId: 'tenant-a',
      canonicalUserId: 'user-1',
      ...overrides,
    });
  }
  const cfgOn: Partial<LambdaMicrovmBackendConfig> = { checkpointsEnabled: true };

  test('checkpoints the workspace after a session exec and records the pointer', async () => {
    const fake = fakeClient();
    const store = new MemoryCheckpointStore();
    const backend = makeBackend(fake, cfgOn, store);

    await backend.execute(request(), sessionContext());

    const checkpoints = captured.filter((c) => c.path === '/api/v2/session/checkpoint');
    expect(checkpoints).toHaveLength(1);
    /* The runner binds session mode from this header (hookless): without it the
     * checkpoint/restore handlers 409 and state is lost across expiry. */
    expect(checkpoints[0].headers['x-runtime-session-id']).toBe('rt_ckpt_1');
    const stored = await store.get('rt_ckpt_1', 1_000_000);
    expect(stored).not.toBeNull();
    try {
      expect(await fsp.readFile(stored!.path, 'utf8')).toBe(checkpointBlob);
    } finally {
      await stored?.cleanup();
    }
    const record = await readRuntimeSessionRecord('rt_ckpt_1');
    /* Key is an immutable, zero-padded per-session sequence. */
    expect(record?.workspace_checkpoint).toStartWith(checkpointPrefixFor('rt_ckpt_1'));
    expect(record?.workspace_checkpoint).toEndWith('.tar.gz');
    expect(record?.checkpointed_at).toBeGreaterThan(0);
  });

  test('restores the prior checkpoint on retry when result finalization fails', async () => {
    const fake = fakeClient();
    const store = new MemoryCheckpointStore();
    await store.put('rt_ckpt_1', 7, Buffer.from('PRIOR_WORKSPACE'));
    await store.commit('rt_ckpt_1', 7);
    const checkpointKey = checkpointObjectKey('rt_ckpt_1', 7);
    const seedToken = await acquireRuntimeSessionLock('rt_ckpt_1', 60_000);
    await writeRuntimeSessionRecord({
      runtime_session_id: 'rt_ckpt_1',
      tenant_id: 'tenant-a',
      canonical_user_id: 'user-1',
      state: 'TERMINATED',
      generation: 1,
      last_seen_at: 1,
      workspace_checkpoint: checkpointKey,
    }, seedToken as string);
    await releaseRuntimeSessionLock('rt_ckpt_1', seedToken as string);
    const backend = makeBackend(fake, cfgOn, store);
    let finalizeAttempts = 0;
    const sessionResultFinalizer = async (result: SandboxRawResponse): Promise<SandboxRawResponse> => {
      finalizeAttempts += 1;
      if (finalizeAttempts === 1) {
        throw new Error('egress gateway restore unavailable');
      }
      return { ...result, session_id: 'restored_result' };
    };

    await expect(backend.execute(
      request(),
      sessionContext({ sessionResultFinalizer }),
    )).rejects.toThrow('egress gateway restore unavailable');

    const firstAttemptPaths = captured.map((c) => c.path);
    expect(firstAttemptPaths.filter((path) => path === '/api/v2/session/checkpoint')).toHaveLength(0);
    expect(fake.callsFor('terminateMicrovm')).toHaveLength(1);
    const recycled = await readRuntimeSessionRecord('rt_ckpt_1');
    expect(recycled?.state).toBe('TERMINATED');
    expect(recycled?.workspace_checkpoint).toBe(checkpointKey);

    const result = await backend.execute(
      request(),
      sessionContext({ sessionResultFinalizer }),
    );
    expect(result.session_id).toBe('restored_result');
    expect(fake.callsFor('runMicrovm')).toHaveLength(2);

    const paths = captured.map((c) => c.path);
    const executeIndexes = paths
      .map((path, index) => path === '/api/v2/execute' ? index : -1)
      .filter((index) => index >= 0);
    const restoreIndexes = paths
      .map((path, index) => path === '/api/v2/session/restore' ? index : -1)
      .filter((index) => index >= 0);
    expect(executeIndexes).toHaveLength(2);
    expect(restoreIndexes).toHaveLength(2);
    expect(restoreIndexes[1]).toBeGreaterThan(executeIndexes[0]);
    expect(restoreIndexes[1]).toBeLessThan(executeIndexes[1]);
  });

  test('still terminates the mutated VM when the rollback registry read fails', async () => {
    const fake = fakeClient();
    const backend = makeBackend(fake, cfgOn, new MemoryCheckpointStore());
    const redisWithGet = mock as unknown as {
      get(key: string): Promise<string | null>;
    };
    const originalGet = redisWithGet.get.bind(mock);
    let failSessionRead = false;
    redisWithGet.get = async (key: string): Promise<string | null> => {
      if (failSessionRead && key === 'rtsx:sess:rt_ckpt_1') {
        throw new Error('registry read unavailable');
      }
      return originalGet(key);
    };
    const sessionResultFinalizer = async (
      _result: SandboxRawResponse,
    ): Promise<SandboxRawResponse> => {
      failSessionRead = true;
      throw new Error('egress gateway restore unavailable');
    };

    try {
      await expect(backend.execute(
        request(),
        sessionContext({ sessionResultFinalizer }),
      )).rejects.toThrow('egress gateway restore unavailable');
    } finally {
      failSessionRead = false;
    }

    expect(fake.callsFor('terminateMicrovm')).toHaveLength(1);
    /* The registry could not be quarantined, so provider teardown—not Redis
     * state—is what prevents reuse of the uncommitted workspace. */
    expect((await readRuntimeSessionRecord('rt_ckpt_1'))?.state).toBe('RUNNING');
  });

  test('still terminates the mutated VM when the rollback quarantine write fails', async () => {
    const fake = fakeClient();
    const backend = makeBackend(fake, cfgOn, new MemoryCheckpointStore());
    const redisWithScript = mock as unknown as {
      writeRuntimeSessionRecordScript(...args: string[]): Promise<number>;
    };
    const originalWrite = redisWithScript.writeRuntimeSessionRecordScript.bind(mock);
    let failQuarantineWrite = false;
    redisWithScript.writeRuntimeSessionRecordScript = async (
      ...args: string[]
    ): Promise<number> => {
      if (failQuarantineWrite) throw new Error('registry write unavailable');
      return originalWrite(...args);
    };
    const sessionResultFinalizer = async (
      _result: SandboxRawResponse,
    ): Promise<SandboxRawResponse> => {
      failQuarantineWrite = true;
      throw new Error('egress gateway restore unavailable');
    };

    try {
      await expect(backend.execute(
        request(),
        sessionContext({ sessionResultFinalizer }),
      )).rejects.toThrow('egress gateway restore unavailable');
    } finally {
      failQuarantineWrite = false;
    }

    expect(fake.callsFor('terminateMicrovm')).toHaveLength(1);
    expect((await readRuntimeSessionRecord('rt_ckpt_1'))?.state).toBe('RUNNING');
  });

  test('a relaunched VM restores the checkpoint before the first exec', async () => {
    const store = new MemoryCheckpointStore();
    await store.put('rt_ckpt_1', 1000, Buffer.from('PRIOR_WORKSPACE'));
    await store.commit('rt_ckpt_1', 1000);
    /* Seed a terminated prior session so findOrLaunch relaunches. */
    const seedToken = await acquireRuntimeSessionLock('rt_ckpt_1', 60_000);
    await writeRuntimeSessionRecord({
      runtime_session_id: 'rt_ckpt_1', tenant_id: 'tenant-a', canonical_user_id: 'user-1',
      state: 'TERMINATED', generation: 3, last_seen_at: 1, workspace_checkpoint: checkpointObjectKey('rt_ckpt_1', 1000),
    }, seedToken as string);
    const { releaseRuntimeSessionLock } = await import('../runtime-session/registry');
    await releaseRuntimeSessionLock('rt_ckpt_1', seedToken as string);

    const fake = fakeClient();
    const backend = makeBackend(fake, cfgOn, store);
    const result = await backend.execute(request(), sessionContext());
    expect(result).toEqual(EXECUTE_RESPONSE);

    const paths = captured.map((c) => c.path);
    /* restore precedes execute on the fresh VM. */
    expect(paths.indexOf('/api/v2/session/restore')).toBeGreaterThanOrEqual(0);
    expect(paths.indexOf('/api/v2/session/restore')).toBeLessThan(paths.indexOf('/api/v2/execute'));
    const restoreReq = captured.find((c) => c.path === '/api/v2/session/restore');
    expect(restoreReq?.headers['x-runtime-session-id']).toBe('rt_ckpt_1');
    expect(recordDuringRestore?.state).toBe('PENDING');
    expect(recordDuringRestore?.workspace_checkpoint).toBe(
      checkpointObjectKey('rt_ckpt_1', 1000),
    );
    expect(fake.callsFor('runMicrovm')).toHaveLength(1);
  });

  test('reuse (warm VM) does not restore — no prior expiry', async () => {
    const fake = fakeClient();
    const store = new MemoryCheckpointStore();
    const backend = makeBackend(fake, cfgOn, store);

    await backend.execute(request(), sessionContext());
    captured = [];
    await backend.execute(request(), sessionContext());

    expect(captured.filter((c) => c.path === '/api/v2/session/restore')).toHaveLength(0);
    expect(fake.callsFor('runMicrovm')).toHaveLength(1);
  });

  test('disabled checkpoints skip both checkpoint and restore', async () => {
    const fake = fakeClient();
    const store = new MemoryCheckpointStore();
    const backend = makeBackend(fake, { checkpointsEnabled: false }, store);
    await backend.execute(request(), sessionContext());
    /* File delivery is independent of checkpointing — only the checkpoint and
     * restore legs must be skipped. */
    expect(captured.filter((c) =>
      c.path === '/api/v2/session/checkpoint' || c.path === '/api/v2/session/restore',
    )).toHaveLength(0);
    expect(store.objects.size).toBe(0);
  });

  test('skips a checkpoint unless the budget covers the complete bounded pipeline', async () => {
    const originalNow = Date.now;
    let now = 1_000_000;
    Date.now = () => now;
    onExecute = () => {
      /* Leaves 31035ms: more than the old 1000 + 3*10 guard, but less than the
       * actual token wait + GET + list + put + commit + six independently
       * bounded registry commands worst case (31040ms).
       * The roomy launch timeout keeps this clock-focused test independent of
       * real event-loop scheduling under the full suite. */
      now += 65;
    };
    try {
      const fake = fakeClient();
      const store = new MemoryCheckpointStore();
      const backend = makeBackend(fake, {
        checkpointsEnabled: true,
        jobTimeoutMs: 31_100,
        launchTimeoutMs: 1_000,
        checkpoint: {
          port: 8080,
          authTokenTtlSeconds: 300,
          maxBytes: 512 * 1024 * 1024,
          timeoutMs: 10,
        },
      }, store);

      expect(await backend.execute(request(), sessionContext())).toEqual(EXECUTE_RESPONSE);
      expect(captured.filter((c) => c.path === '/api/v2/session/checkpoint')).toHaveLength(0);
      expect(store.objects.size).toBe(0);
    } finally {
      Date.now = originalNow;
    }
  });

  test('production defaults leave enough budget for a fresh session checkpoint', async () => {
    const fake = fakeClient();
    const store = new MemoryCheckpointStore();
    const backend = makeBackend(fake, {
      checkpointsEnabled: true,
      jobTimeoutMs: 300_000,
      launchTimeoutMs: 60_000,
      checkpoint: {
        port: 8080,
        authTokenTtlSeconds: 300,
        maxBytes: 512 * 1024 * 1024,
        timeoutMs: 60_000,
      },
    }, store);

    expect(await backend.execute(request(), sessionContext())).toEqual(EXECUTE_RESPONSE);
    expect(captured.filter((c) => c.path === '/api/v2/session/checkpoint')).toHaveLength(1);
    expect(store.objects.size).toBe(1);
  });

  test('shares one absolute token deadline across checkpoint throttle and SDK legs', async () => {
    const fake = fakeClient();
    const originalMint = fake.createMicrovmAuthToken.bind(fake);
    let mintCalls = 0;
    fake.createMicrovmAuthToken = async (args, signal?: AbortSignal) => {
      mintCalls += 1;
      /* A fresh VM mints once for readiness and once for execute before the
       * post-run checkpoint requests the third token. */
      if (mintCalls <= 2) return originalMint(args);
      return new Promise((_, reject) => {
        if (!signal) {
          reject(new Error('checkpoint token mint omitted its deadline signal'));
          return;
        }
        const onAbort = (): void => reject(signal.reason ?? new Error('token mint aborted'));
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      });
    };
    /* Set the poison only after the execute token was minted. The checkpoint
     * token must spend part of its one budget waiting here, then give the SDK
     * only the remainder instead of starting a second full window. */
    onExecute = () => mock.set('rtsx:tps:poison:token', '1', 'PX', 80).then(() => undefined);
    const store = new MemoryCheckpointStore();
    const backend = makeBackend(fake, {
      checkpointsEnabled: true,
      launchTimeoutMs: 200,
    }, store);
    const req = request();
    req.body.files = [];
    const controller = new AbortController();
    const fallback = setTimeout(() => controller.abort(), 2_000);
    try {
      expect(await backend.execute(
        req,
        sessionContext({ signal: controller.signal }),
      )).toEqual(EXECUTE_RESPONSE);
    } finally {
      clearTimeout(fallback);
    }

    expect(controller.signal.aborted).toBe(false);
    expect(mintCalls).toBe(3);
    expect(captured.filter((c) => c.path === '/api/v2/session/checkpoint')).toHaveLength(0);
    expect(store.objects.size).toBe(0);
  });

  test('aborts a slow-trickle guest checkpoint on the absolute transfer deadline', async () => {
    /* Each chunk arrives before Axios' inactivity timeout, while the complete
     * response takes much longer. The explicit transfer signal must still
     * stop it at the configured wall-clock deadline. */
    checkpointChunkIntervalMs = 20;
    checkpointChunkCount = 10;
    const fake = fakeClient();
    const store = new MemoryCheckpointStore();
    const backend = makeBackend(fake, {
      checkpointsEnabled: true,
      launchTimeoutMs: 100,
      checkpoint: {
        port: 8080,
        authTokenTtlSeconds: 300,
        maxBytes: 512 * 1024 * 1024,
        timeoutMs: 100,
      },
    }, store);
    const req = request();
    req.body.files = [];

    expect(await backend.execute(req, sessionContext())).toEqual(EXECUTE_RESPONSE);
    expect(captured.filter((c) => c.path === '/api/v2/session/checkpoint')).toHaveLength(1);
    expect(store.objects.size).toBe(0);
  });

  test('uses the worker deadline so pre-backend setup consumes checkpoint budget', async () => {
    const originalNow = Date.now;
    const now = 1_000_000;
    Date.now = () => now;
    try {
      const fake = fakeClient();
      const store = new MemoryCheckpointStore();
      const backend = makeBackend(fake, {
        checkpointsEnabled: true,
        /* A backend-local 31100ms clock would allow the 31040ms pipeline. The
         * worker deadline has only 31039ms left after earlier setup work. */
        jobTimeoutMs: 31_100,
        launchTimeoutMs: 1_000,
        checkpoint: {
          port: 8080,
          authTokenTtlSeconds: 300,
          maxBytes: 512 * 1024 * 1024,
          timeoutMs: 10,
        },
      }, store);

      expect(await backend.execute(
        request(),
        sessionContext({ deadlineAtMs: now + 31_039 }),
      )).toEqual(EXECUTE_RESPONSE);
      expect(captured.filter((c) => c.path === '/api/v2/session/checkpoint')).toHaveLength(0);
      expect(store.objects.size).toBe(0);
    } finally {
      Date.now = originalNow;
    }
  });

  test('a checkpoint FETCH failure fails closed instead of running on an empty workspace', async () => {
    const fake = fakeClient();
    const store = new MemoryCheckpointStore();
    store.get = () => Promise.reject(new Error('S3 down'));
    const backend = makeBackend(fake, cfgOn, store);

    /* Running anyway used to let the post-run checkpoint prune the last good
     * snapshot — a transient S3 blip becoming permanent data loss. */
    await expect(backend.execute(request(), sessionContext())).rejects.toThrow(
      'refusing to run against an empty workspace',
    );
    expect(captured.filter((c) => c.path === '/api/v2/execute')).toHaveLength(0);
    expect(fake.callsFor('terminateMicrovm')).toHaveLength(1);
    expect(await readRuntimeSessionRecord('rt_ckpt_1')).toBeNull();
  });

  test('a failed checkpoint is non-fatal — the exec still succeeds', async () => {
    const fake = fakeClient();
    const failing: MemoryCheckpointStore = new MemoryCheckpointStore();
    failing.put = () => Promise.reject(new Error('S3 down'));
    const backend = makeBackend(fake, cfgOn, failing);
    const result = await backend.execute(request(), sessionContext());
    expect(result).toEqual(EXECUTE_RESPONSE);
    const record = await readRuntimeSessionRecord('rt_ckpt_1');
    expect(record?.state).toBe('RUNNING');
    expect(record?.workspace_checkpoint).toBeUndefined();
  });

  test('a failed first reseed lookup cannot strand the Redis sequence below retained objects', async () => {
    const fake = fakeClient();
    const store = new MemoryCheckpointStore();
    await store.put('rt_ckpt_1', 100, Buffer.from('PRIOR_WORKSPACE'));
    await store.commit('rt_ckpt_1', 100);
    const latestSequence = store.latestSequence.bind(store);
    let lookups = 0;
    store.latestSequence = async (runtimeSessionId) => {
      lookups += 1;
      if (lookups === 1) throw new Error('transient list failure');
      return latestSequence(runtimeSessionId);
    };
    const backend = makeBackend(fake, cfgOn, store);

    expect(await backend.execute(request(), sessionContext())).toEqual(EXECUTE_RESPONSE);
    expect(await backend.execute(request(), sessionContext())).toEqual(EXECUTE_RESPONSE);

    const record = await readRuntimeSessionRecord('rt_ckpt_1');
    expect(record?.workspace_checkpoint).toBe(checkpointObjectKey('rt_ckpt_1', 101));
    expect(store.objects.has(checkpointObjectKey('rt_ckpt_1', 101))).toBe(true);
  });

  test('a commit-marker failure keeps the previous durable recovery point', async () => {
    const fake = fakeClient();
    const store = new MemoryCheckpointStore();
    await store.put('rt_ckpt_1', 10, Buffer.from('PRIOR_WORKSPACE'));
    await store.commit('rt_ckpt_1', 10);
    const commit = store.commit.bind(store);
    store.commit = async (runtimeSessionId, sequence) => {
      if (sequence === 11) throw new Error('marker write failed');
      await commit(runtimeSessionId, sequence);
    };
    let pruneCalls = 0;
    const prune = store.pruneOlderThan.bind(store);
    store.pruneOlderThan = async (runtimeSessionId, sequence) => {
      pruneCalls += 1;
      await prune(runtimeSessionId, sequence);
    };
    const backend = makeBackend(fake, cfgOn, store);

    expect(await backend.execute(request(), sessionContext())).toEqual(EXECUTE_RESPONSE);
    expect((await readRuntimeSessionRecord('rt_ckpt_1'))?.workspace_checkpoint).toBe(
      checkpointObjectKey('rt_ckpt_1', 11),
    );
    expect(pruneCalls).toBe(0);

    const durable = await store.get('rt_ckpt_1', 1_000_000);
    try {
      expect(await fsp.readFile(durable!.path, 'utf8')).toBe('PRIOR_WORKSPACE');
    } finally {
      await durable?.cleanup();
    }
  });
});
