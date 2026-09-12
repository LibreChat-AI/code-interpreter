import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, spyOn } from 'bun:test';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { createHash, randomUUID } from 'node:crypto';
import { SESSION_INPUT_CACHE_DIR } from './session-inputs';
import * as semver from 'semver';
import { Job, SessionWorkspaceDirtyError, type TFile } from './job';
import type { Runtime } from './runtime';
import { config } from './config';
import { SANDBOX_DIR_MODE, SANDBOX_FILE_MODE } from './validation';
import type { SessionWorkspace } from './session-workspace';
import {
  SANDBOX_READONLY_FILE_MODE,
  compatibilityModeForSkippedChown,
  fallbackSandboxIdentity,
} from './workspace-isolation';

/**
 * Integration tests for `Job.downloadAndWriteFile` against a real HTTP
 * listener. Hitting a real listener verifies that response metadata cannot
 * redirect a caller-validated sandbox destination.
 */

interface DownloadInternals {
  submissionDir: string;
  files: TFile[];
  inputFileHashes: Map<string, { hash: string; path: string; originalId?: string; originalSessionId?: string }>;
}

function asInternals(job: Job): DownloadInternals {
  return job as unknown as DownloadInternals;
}

function makeRuntime(): Runtime {
  return {
    language: 'python',
    version: new semver.SemVer('3.11.0'),
    aliases: [],
    pkgdir: '/tmp',
    compiled: false,
    env_vars: {},
    timeouts: { compile: 5000, run: 5000 },
    cpu_times: { compile: 5000, run: 5000 },
    memory_limits: { compile: 100_000_000, run: 100_000_000 },
    max_process_count: 100,
    max_open_files: 100,
    max_file_size: 10_000_000,
    output_max_size: 1_000_000,
  };
}

function makeJob(files: TFile[] = [], session?: SessionWorkspace): Job {
  return new Job({
    session_id: 'test-session',
    egress_grant: 'test-grant',
    runtime: makeRuntime(),
    files,
    args: [],
    stdin: '',
    timeouts: { compile: 5000, run: 5000 },
    cpu_times: { compile: 5000, run: 5000 },
    memory_limits: { compile: 100_000_000, run: 100_000_000 },
    session,
  });
}

function sessionWorkspaceAt(
  dir: string,
  runtimeSessionId: string,
  markDirty: () => void = () => {},
): SessionWorkspace {
  const identity = fallbackSandboxIdentity();
  return {
    runtimeSessionId,
    acquire: async () => ({
      workspaceId: runtimeSessionId,
      dir,
      identity,
    }),
    primedInputId: () => undefined,
    markPrimed: () => {},
    markDirty,
  } as unknown as SessionWorkspace;
}

function currentUid(): number | undefined {
  return typeof process.getuid === 'function' ? process.getuid() : undefined;
}

function expectedWritableMode(mode: number): number {
  return currentUid() === 0 ? mode : compatibilityModeForSkippedChown(mode);
}

/* Minimal stand-in for the file-server's `GET /sessions/:sid/objects/:id`.
 * Configurable per test via the `routes` map so individual cases can wire
 * different headers / status codes / bodies. */
type Route = {
  status: number;
  contentDisposition?: string;
  headers?: Record<string, string>;
  body?: string;
  delayMs?: number;
  onRequest?: (req: Request) => void;
};

let server: ReturnType<typeof Bun.serve>;
let serverPort = 0;
const routes = new Map<string, Route>();
let originalFileServerUrl: string;
let originalEgressGatewayUrl: string;
let originalFileRelayToken: string;
let originalPerJobUids: boolean;

beforeAll(() => {
  originalFileServerUrl = config.file_server_url;
  originalEgressGatewayUrl = config.egress_gateway_url;
  originalFileRelayToken = config.file_relay_token;
  originalPerJobUids = config.per_job_uids;
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const route = routes.get(url.pathname);
      if (!route) return new Response('not found', { status: 404 });
      route.onRequest?.(req);
      if (route.delayMs) {
        await new Promise(resolve => setTimeout(resolve, route.delayMs));
      }
      const headers = new Headers();
      if (route.contentDisposition) {
        headers.set('content-disposition', route.contentDisposition);
      }
      for (const [key, value] of Object.entries(route.headers ?? {})) {
        headers.set(key, value);
      }
      return new Response(route.body ?? '', { status: route.status, headers });
    },
  });
  /* `Bun.serve(...)`'s `port` is typed `number | undefined` because the
   * field is also writable post-construction; in practice it's always
   * populated after the server boots. Coerce defensively so a zero would
   * still produce an unreachable URL rather than a malformed one. */
  serverPort = server.port ?? 0;
  /* Override config.file_server_url so the Job under test points at our
   * listener. `config` is a plain object, not frozen, so direct mutation
   * works — restored in afterAll. */
  (config as { file_server_url: string }).file_server_url = `http://127.0.0.1:${serverPort}`;
  (config as { per_job_uids: boolean }).per_job_uids = false;
});

afterAll(() => {
  (config as { file_server_url: string }).file_server_url = originalFileServerUrl;
  (config as { egress_gateway_url: string }).egress_gateway_url = originalEgressGatewayUrl;
  (config as { file_relay_token: string }).file_relay_token = originalFileRelayToken;
  (config as { per_job_uids: boolean }).per_job_uids = originalPerJobUids;
  server.stop(true);
});

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'codeapi-download-'));
  routes.clear();
});

afterEach(async () => {
  (config as { egress_gateway_url: string }).egress_gateway_url = originalEgressGatewayUrl;
  (config as { file_relay_token: string }).file_relay_token = originalFileRelayToken;
  (config as { file_server_url: string }).file_server_url = `http://127.0.0.1:${serverPort}`;
  (config as { per_job_uids: boolean }).per_job_uids = false;
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

describe('downloadAndWriteFile destinations', () => {
  it('writes a nested-path artifact at the requested location', async () => {
    const file: TFile = {
      id: 'nested-id',
      storage_session_id: 'prev-session',
      name: 'proj/notes.txt',
    };
    routes.set(`/sessions/${encodeURIComponent(file.storage_session_id!)}/objects/${encodeURIComponent(file.id!)}`, {
      status: 200,
      contentDisposition: "attachment; filename*=UTF-8''stored-original.txt",
      body: 'hello from a nested artifact\n',
    });

    const job = makeJob([file]);
    const internals = asInternals(job);
    internals.submissionDir = tmpDir;

    const writtenName = await job.downloadAndWriteFile(file);

    expect(writtenName).toBe('proj/notes.txt');
    const expectedFull = path.join(tmpDir, 'proj', 'notes.txt');
    const contents = await fsp.readFile(expectedFull, 'utf8');
    expect(contents).toBe('hello from a nested artifact\n');
    expect((await fsp.stat(path.dirname(expectedFull))).mode & 0o777).toBe(expectedWritableMode(SANDBOX_DIR_MODE));
    expect((await fsp.stat(expectedFull)).mode & 0o777).toBe(expectedWritableMode(SANDBOX_FILE_MODE));
  });

  it('uses the egress gateway URL and grant header when configured', async () => {
    const file: TFile = {
      id: 'opaque-object-handle',
      storage_session_id: 'opaque-session-handle',
      name: 'gateway.txt',
    };
    let sawGrantHeader = false;
    let sawRelayToken = false;
    let sawInternalHeader = false;
    routes.set(`/sessions/${encodeURIComponent(file.storage_session_id!)}/objects/${encodeURIComponent(file.id!)}`, {
      status: 200,
      contentDisposition: 'attachment; filename="gateway.txt"',
      body: 'gateway bytes',
      onRequest(req) {
        sawGrantHeader = req.headers.get('x-codeapi-egress-grant') === 'opaque-grant';
        sawRelayToken = req.headers.get('x-librechat-code-relay-token') === 'relay-secret';
        sawInternalHeader = req.headers.has('x-codeapi-internal-token');
      },
    });
    (config as { egress_gateway_url: string }).egress_gateway_url = `http://127.0.0.1:${serverPort}`;
    (config as { file_relay_token: string }).file_relay_token = 'relay-secret';
    (config as { file_server_url: string }).file_server_url = 'http://127.0.0.1:1';

    const job = new Job({
      session_id: 'opaque-output-session-handle',
      runtime: makeRuntime(),
      files: [file],
      args: [],
      stdin: '',
      timeouts: { compile: 5000, run: 5000 },
      cpu_times: { compile: 5000, run: 5000 },
      memory_limits: { compile: 100_000_000, run: 100_000_000 },
      egress_grant: 'opaque-grant',
    });
    asInternals(job).submissionDir = tmpDir;

    const writtenName = await job.downloadAndWriteFile(file);

    expect(writtenName).toBe('gateway.txt');
    expect(sawGrantHeader).toBe(true);
    expect(sawRelayToken).toBe(true);
    expect(sawInternalHeader).toBe(false);
    expect(await fsp.readFile(path.join(tmpDir, 'gateway.txt'), 'utf8')).toBe('gateway bytes');
  });

  it('keeps read-only downloaded inputs non-writable to the sandbox owner', async () => {
    const file: TFile = {
      id: 'readonly-id',
      storage_session_id: 'prev-session',
      name: 'readonly.txt',
    };
    routes.set(`/sessions/${encodeURIComponent(file.storage_session_id!)}/objects/${encodeURIComponent(file.id!)}`, {
      status: 200,
      contentDisposition: 'attachment; filename="readonly.txt"',
      headers: { 'x-read-only': 'true' },
      body: 'readonly bytes',
    });

    const job = makeJob([file]);
    asInternals(job).submissionDir = tmpDir;

    const writtenName = await job.downloadAndWriteFile(file);

    expect(writtenName).toBe('readonly.txt');
    expect((await fsp.stat(path.join(tmpDir, 'readonly.txt'))).mode & 0o777).toBe(SANDBOX_READONLY_FILE_MODE);
  });

  it('downloads when a legacy filename header matches the requested name', async () => {
    const file: TFile = {
      id: 'legacy-id',
      storage_session_id: 'prev-session',
      name: 'legacy.txt',
    };
    routes.set(`/sessions/${encodeURIComponent(file.storage_session_id!)}/objects/${encodeURIComponent(file.id!)}`, {
      status: 200,
      contentDisposition: 'attachment; filename="legacy.txt"',
      body: 'legacy bytes',
    });

    const job = makeJob([file]);
    asInternals(job).submissionDir = tmpDir;

    const writtenName = await job.downloadAndWriteFile(file);

    expect(writtenName).toBe('legacy.txt');
    const contents = await fsp.readFile(path.join(tmpDir, 'legacy.txt'), 'utf8');
    expect(contents).toBe('legacy bytes');
  });

  it('writes under the requested name when a legacy server returns an opaque storage filename', async () => {
    const file: TFile = {
      id: 'opaque-storage-id',
      storage_session_id: 'prev-session',
      name: 'Sample_-_Superstore.xlsx',
    };
    routes.set(`/sessions/${encodeURIComponent(file.storage_session_id!)}/objects/${encodeURIComponent(file.id!)}`, {
      status: 200,
      contentDisposition: "attachment; filename*=UTF-8''opaque-storage-id.xlsx",
      body: 'workbook bytes',
    });

    const job = makeJob([file]);
    asInternals(job).submissionDir = tmpDir;

    const writtenName = await job.downloadAndWriteFile(file);

    expect(writtenName).toBe('Sample_-_Superstore.xlsx');
    expect(await fsp.readFile(path.join(tmpDir, 'Sample_-_Superstore.xlsx'), 'utf8'))
      .toBe('workbook bytes');
    expect(await fsp.stat(path.join(tmpDir, 'opaque-storage-id.xlsx')).catch(() => null)).toBeNull();
  });

  it('keeps concurrent inputs at their requested destinations', async () => {
    const renamed: TFile = {
      id: 'renamed-id',
      storage_session_id: 'prev-session',
      name: 'vacated.txt',
    };
    const replacement: TFile = {
      id: 'replacement-id',
      storage_session_id: 'prev-session',
      name: 'actual.txt',
    };
    routes.set(`/sessions/${encodeURIComponent(renamed.storage_session_id!)}/objects/${encodeURIComponent(renamed.id!)}`, {
      status: 200,
      contentDisposition: 'attachment; filename="actual.txt"',
      body: 'renamed bytes',
      delayMs: 75,
    });
    routes.set(`/sessions/${encodeURIComponent(replacement.storage_session_id!)}/objects/${encodeURIComponent(replacement.id!)}`, {
      status: 200,
      contentDisposition: 'attachment; filename="vacated.txt"',
      body: 'replacement bytes',
    });

    const session = sessionWorkspaceAt(tmpDir, 'rt_concurrent_rename');
    const job = makeJob([renamed, replacement], session);
    const originalPrimeConcurrency = config.prime_concurrency;
    config.prime_concurrency = 2;
    try {
      await job.prime();
      const submissionDir = asInternals(job).submissionDir;
      expect(await fsp.readFile(path.join(submissionDir, 'actual.txt'), 'utf8'))
        .toBe('replacement bytes');
      expect(await fsp.readFile(path.join(submissionDir, 'vacated.txt'), 'utf8'))
        .toBe('renamed bytes');
    } finally {
      config.prime_concurrency = originalPrimeConcurrency;
      await job.cleanup();
    }
  });

  it('keeps distinct requested names when stored objects share an original filename', async () => {
    const original: TFile = {
      id: 'original-id',
      storage_session_id: 'prev-session',
      name: 'data.xlsx',
    };
    const aliased: TFile = {
      id: 'aliased-id',
      storage_session_id: 'prev-session',
      name: 'data-3f9a2c.xlsx',
    };
    routes.set(`/sessions/${encodeURIComponent(original.storage_session_id!)}/objects/${encodeURIComponent(original.id!)}`, {
      status: 200,
      contentDisposition: 'attachment; filename="data.xlsx"',
      body: 'original bytes',
      delayMs: 75,
    });
    routes.set(`/sessions/${encodeURIComponent(aliased.storage_session_id!)}/objects/${encodeURIComponent(aliased.id!)}`, {
      status: 200,
      contentDisposition: 'attachment; filename="data.xlsx"',
      body: 'aliased bytes',
    });

    const job = makeJob(
      [original, aliased],
      sessionWorkspaceAt(tmpDir, 'rt_shared_original_filename'),
    );
    const originalPrimeConcurrency = config.prime_concurrency;
    config.prime_concurrency = 2;
    try {
      await job.prime();
      const submissionDir = asInternals(job).submissionDir;
      expect(await fsp.readFile(path.join(submissionDir, 'data.xlsx'), 'utf8'))
        .toBe('original bytes');
      expect(await fsp.readFile(path.join(submissionDir, 'data-3f9a2c.xlsx'), 'utf8'))
        .toBe('aliased bytes');
    } finally {
      config.prime_concurrency = originalPrimeConcurrency;
      await job.cleanup();
    }
  });

  it('keeps a Unicode requested name when the header is percent encoded', async () => {
    const file: TFile = {
      id: 'utf8-id',
      storage_session_id: 'prev-session',
      name: '你好.txt',
    };
    routes.set(`/sessions/${encodeURIComponent(file.storage_session_id!)}/objects/${encodeURIComponent(file.id!)}`, {
      status: 200,
      contentDisposition: "attachment; filename*=UTF-8''%E4%BD%A0%E5%A5%BD.txt",
      body: 'hi',
    });

    const job = makeJob([file]);
    asInternals(job).submissionDir = tmpDir;

    const writtenName = await job.downloadAndWriteFile(file);

    expect(writtenName).toBe('你好.txt');
    const contents = await fsp.readFile(path.join(tmpDir, '你好.txt'), 'utf8');
    expect(contents).toBe('hi');
  });

  it.each([401, 403])('does not retry an HTTP %i authorization denial', async status => {
    config.egress_gateway_url = `http://127.0.0.1:${serverPort}`;
    const file: TFile = { id: 'denied', storage_session_id: 'previous', name: 'denied.txt' };
    let requests = 0;
    routes.set('/sessions/previous/objects/denied', {
      status,
      headers: { 'X-CodeAPI-Error-Code': 'scope_mismatch' },
      onRequest: () => { requests++; },
    });
    const job = makeJob([file]);
    asInternals(job).submissionDir = tmpDir;

    await expect(job.downloadAndWriteFile(file, 5, 1)).rejects.toThrow(`HTTP error: ${status}`);
    expect(requests).toBe(1);
    expect(await fsp.readdir(tmpDir)).toEqual([]);
  });

  it.each([403, 404, 408, 429, 503])('still retries transient HTTP %i responses', async status => {
    config.egress_gateway_url = `http://127.0.0.1:${serverPort}`;
    const file: TFile = { id: 'transient', storage_session_id: 'previous', name: 'ready.txt' };
    let requests = 0;
    const route: Route = {
      status,
      body: 'ready',
      onRequest: () => { if (++requests === 2) route.status = 200; },
    };
    routes.set('/sessions/previous/objects/transient', route);
    const job = makeJob([file]);
    asInternals(job).submissionDir = tmpDir;

    await expect(job.downloadAndWriteFile(file, 5, 1)).resolves.toBe('ready.txt');
    expect(requests).toBe(2);
    expect(await fsp.readFile(path.join(tmpDir, 'ready.txt'), 'utf8')).toBe('ready');
  });

  it.each([false, true])('honors conflict retry hints with cancellation=%s', async cancel => {
    config.egress_gateway_url = `http://127.0.0.1:${serverPort}`;
    const controller = new AbortController();
    const timestamps: number[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const route: Route = {
      status: 503, body: 'ready',
      headers: { 'X-CodeAPI-Error-Code': 'ledger_conflict', 'Retry-After': '1' },
      onRequest: () => {
        timestamps.push(performance.now());
        if (timestamps.length === 2) route.status = 200;
        else if (cancel) timer = setTimeout(() => controller.abort(new Error('cancelled retry')), 25);
      },
    };
    routes.set('/sessions/previous/objects/retry-hint', route);
    const file: TFile = { id: 'retry-hint', storage_session_id: 'previous', name: 'ready.txt' };
    const job = makeJob([file]);
    asInternals(job).submissionDir = tmpDir;
    try {
      const result = job.downloadAndWriteFile(file, 5, 1, {
        submissionDir: tmpDir, identity: fallbackSandboxIdentity(), signal: controller.signal,
      });
      if (cancel) {
        await expect(result).rejects.toThrow('cancelled retry');
        expect(timestamps).toHaveLength(1);
        expect(await fsp.readdir(tmpDir)).toEqual([]);
      } else {
        await expect(result).resolves.toBe('ready.txt');
        expect(timestamps).toHaveLength(2);
        expect(timestamps[1] - timestamps[0]).toBeGreaterThanOrEqual(900);
      }
    } finally {
      clearTimeout(timer);
    }
  });

  it('reuses versioned bytes in fresh workspaces without bypassing a later denial', async () => {
    const previousCache = config.http_input_cache_enabled;
    const version = randomUUID();
    const cacheKey = createHash('sha256').update(version).digest('hex');
    const otherDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'codeapi-cache-second-'));
    config.http_input_cache_enabled = true;
    config.egress_gateway_url = `http://127.0.0.1:${serverPort}`;
    let reads = 0;
    let checks = 0;
    const meta: Route = { status: 200, body: JSON.stringify({ cacheable: true, cacheKey, version, size: 8, readOnly: false }),
      onRequest: () => { checks++; },
    };
    routes.set('/sessions/previous/objects/cached/metadata', meta);
    routes.set('/sessions/previous/objects/cached', { status: 200, body: 'original',
      headers: { 'X-CodeAPI-Input-Version': version },
      onRequest: request => { reads++; expect(request.headers.get('x-codeapi-input-version')).toBe(version); },
    });
    const file: TFile = { id: 'cached', storage_session_id: 'previous', name: 'data.txt', input_cache_key: cacheKey };
    try {
      const first = makeJob([file]);
      asInternals(first).submissionDir = tmpDir;
      await first.downloadAndWriteFile(file);
      await fsp.writeFile(path.join(tmpDir, 'data.txt'), 'sandbox changed this');
      const second = makeJob([file]);
      asInternals(second).submissionDir = otherDir;
      await second.downloadAndWriteFile(file);
      expect(await fsp.readFile(path.join(otherDir, 'data.txt'), 'utf8')).toBe('original');
      expect(reads).toBe(1);
      expect(checks).toBe(2);
      meta.status = 403;
      meta.headers = { 'X-CodeAPI-Error-Code': 'scope_mismatch' };
      await expect(second.downloadAndWriteFile(file)).rejects.toThrow('HTTP error: 403');
      expect(checks).toBe(3);
      expect(reads).toBe(1);
    } finally {
      config.http_input_cache_enabled = previousCache;
      await fsp.rm(otherDir, { recursive: true, force: true });
      await fsp.rm(path.join(SESSION_INPUT_CACHE_DIR, cacheKey), { force: true });
      await fsp.rm(path.join(SESSION_INPUT_CACHE_DIR, `${cacheKey}.json`), { force: true });
    }
  });

  it('does not retry an unclassified direct file-server denial', async () => {
    config.egress_gateway_url = '';
    let requests = 0;
    const file: TFile = { id: 'denied', storage_session_id: 'previous', name: 'denied.txt' };
    routes.set('/sessions/previous/objects/denied', {
      status: 403, onRequest: () => { requests++; },
    });
    const job = makeJob([file]);
    asInternals(job).submissionDir = tmpDir;
    await expect(job.downloadAndWriteFile(file, 5, 1)).rejects.toThrow('HTTP error: 403');
    expect(requests).toBe(1);
  });

  it.each(['legacy', 'classified', 'direct'])('handles %s marker denials before priming', async mode => {
    config.egress_gateway_url = mode === 'direct' ? '' : `http://127.0.0.1:${serverPort}`;
    let requests = 0;
    const route: Route = {
      status: 403, body: '[]',
      headers: mode === 'classified' ? { 'X-CodeAPI-Error-Code': 'scope_mismatch' } : {},
      onRequest: () => { if (++requests === 2) route.status = 200; },
    };
    routes.set('/sessions/previous/objects', route);
    const file: TFile = { id: 'ready', storage_session_id: 'previous', name: 'ready.txt' };
    routes.set('/sessions/previous/objects/ready', { status: 200, body: 'ready' });
    const job = makeJob([file], sessionWorkspaceAt(tmpDir, 'marker-retry'));
    if (mode === 'legacy') {
      await job.prime();
      expect(requests).toBe(2);
      expect(await fsp.readFile(path.join(tmpDir, 'ready.txt'), 'utf8')).toBe('ready');
    } else {
      await expect(job.prime()).rejects.toThrow('HTTP error loading .dirkeep markers: 403');
      expect(requests).toBe(1);
    }
  });

  it('accounts for a denied 240-file batch once and stops queued downloads', async () => {
    config.egress_gateway_url = `http://127.0.0.1:${serverPort}`;
    const files: TFile[] = Array.from({ length: 240 }, (_, index) => ({
      id: `file-${index}`, storage_session_id: 'previous', name: `file-${index}.txt`,
    }));
    let requests = 0;
    routes.set('/sessions/previous/objects', { status: 200, body: '[]' });
    for (const file of files) {
      routes.set(`/sessions/previous/objects/${file.id}`, {
        status: 403,
        headers: { 'X-CodeAPI-Error-Code': 'scope_mismatch' },
        delayMs: file.id === 'file-0' ? 0 : 30,
        onRequest: () => { requests++; },
      });
    }
    let dirty = false;
    const job = makeJob(files, sessionWorkspaceAt(tmpDir, 'batch-test', () => { dirty = true; }));
    const log = (job as unknown as { log: import('pino').Logger }).log;
    const errorLog = spyOn(log, 'error');
    const originalConcurrency = config.prime_concurrency;
    config.prime_concurrency = 8;
    try {
      await expect(job.prime()).rejects.toBeInstanceOf(SessionWorkspaceDirtyError);
      expect(dirty).toBe(true);
      expect(requests).toBeGreaterThan(0);
      expect(requests).toBeLessThanOrEqual(8);
      expect(errorLog).toHaveBeenCalledTimes(1);
      expect(errorLog).toHaveBeenCalledWith(expect.objectContaining({
        inputCount: 240, completed: 0, failed: 1, cancelled: 7, notStarted: 232,
      }), 'Input preparation batch failed');
      expect(await fsp.readdir(tmpDir)).toEqual([]);
    } finally {
      errorLog.mockRestore();
      config.prime_concurrency = originalConcurrency;
      await job.cleanup();
    }
  });

  it('fails when the server keeps 404-ing past the retry cap (no phantom write)', async () => {
    const file: TFile = {
      id: 'missing-id',
      storage_session_id: 'prev-session',
      name: 'should-not-exist.txt',
    };
    /* No route registered → listener returns 404 for every retry. */

    const job = makeJob([file]);
    asInternals(job).submissionDir = tmpDir;

    await expect(job.downloadAndWriteFile(file, 2, 1)).rejects.toThrow('HTTP error: 404');
    /* Defensive: confirm we did not leave a partial / phantom file on
     * disk after exhausting retries. */
    await expect(fsp.access(path.join(tmpDir, 'should-not-exist.txt'))).rejects.toThrow();
  });

  it('ignores a server-supplied filename that escapes the submission dir', async () => {
    const file: TFile = {
      id: 'evil-id',
      storage_session_id: 'prev-session',
      name: 'innocent.txt',
    };
    routes.set(`/sessions/${encodeURIComponent(file.storage_session_id!)}/objects/${encodeURIComponent(file.id!)}`, {
      status: 200,
      contentDisposition: "attachment; filename*=UTF-8''..%2F..%2Fescape.txt",
      body: 'safe bytes',
    });

    const job = makeJob([file]);
    asInternals(job).submissionDir = tmpDir;

    await expect(job.downloadAndWriteFile(file)).resolves.toBe('innocent.txt');
    expect(await fsp.readFile(path.join(tmpDir, 'innocent.txt'), 'utf8')).toBe('safe bytes');
    const parent = path.dirname(tmpDir);
    await expect(fsp.access(path.join(parent, 'escape.txt'))).rejects.toThrow();
  });
});
