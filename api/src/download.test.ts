import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'bun:test';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
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
 * listener. These exercise the cross-repo round-trip: the file-server
 * (codeapi/service) emits `Content-Disposition: attachment;
 * filename*=UTF-8''<percent-encoded-path>` for nested artifacts, and the
 * sandbox-side parser must recover the path so the file lands at the same
 * nested location on the next prime(). Hitting a real listener (not a
 * mocked Response) catches anything fetch-level that a unit test would miss.
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

describe('downloadAndWriteFile / RFC 5987 round-trip', () => {
  it('writes a nested-path artifact at the encoded location', async () => {
    /* Simulates the matplotlib-bug shape: codeapi previously returned a
     * flat `file.name` and the original path was carried only by the
     * server's `filename*=` header. The fix is: parser recovers the path,
     * `mkdir { recursive: true }` creates the parent dir, file ends up
     * where the user expects to `cat` it on the next turn. */
    const file: TFile = {
      id: 'nested-id',
      storage_session_id: 'prev-session',
      name: 'flat-fallback.txt',
    };
    routes.set(`/sessions/${encodeURIComponent(file.storage_session_id!)}/objects/${encodeURIComponent(file.id!)}`, {
      status: 200,
      contentDisposition: "attachment; filename*=UTF-8''proj%2Fnotes.txt",
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
      name: 'gateway-fallback.txt',
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

  it('falls back to the legacy filename= form when filename*= is absent', async () => {
    /* Backwards-compat: older file-servers (or proxies that strip RFC
     * 5987 extended-form headers) still send the legacy quoted form. The
     * parser must still find a name and write the file. */
    const file: TFile = {
      id: 'legacy-id',
      storage_session_id: 'prev-session',
      name: 'ignored.txt',
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

  it('resolves concurrent header destinations without provisional-name false conflicts', async () => {
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
      /* Make the other ref resolve `vacated.txt` while this ref's requested
       * name would still be provisional under the old reservation scheme. */
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
        .toBe('renamed bytes');
      expect(await fsp.readFile(path.join(submissionDir, 'vacated.txt'), 'utf8'))
        .toBe('replacement bytes');
    } finally {
      config.prime_concurrency = originalPrimeConcurrency;
      await job.cleanup();
    }
  });

  it('rejects concurrent refs that resolve to the same destination before either can overwrite', async () => {
    const slower: TFile = {
      id: 'same-slower-id',
      storage_session_id: 'prev-session',
      name: 'slower-fallback.txt',
    };
    const faster: TFile = {
      id: 'same-faster-id',
      storage_session_id: 'prev-session',
      name: 'faster-fallback.txt',
    };
    routes.set(`/sessions/${encodeURIComponent(slower.storage_session_id!)}/objects/${encodeURIComponent(slower.id!)}`, {
      status: 200,
      contentDisposition: 'attachment; filename="same.txt"',
      body: 'slower bytes',
      delayMs: 75,
    });
    routes.set(`/sessions/${encodeURIComponent(faster.storage_session_id!)}/objects/${encodeURIComponent(faster.id!)}`, {
      status: 200,
      contentDisposition: 'attachment; filename="same.txt"',
      body: 'faster bytes',
    });

    let dirty = false;
    const job = makeJob(
      [slower, faster],
      sessionWorkspaceAt(tmpDir, 'rt_concurrent_same_destination', () => { dirty = true; }),
    );
    const originalPrimeConcurrency = config.prime_concurrency;
    config.prime_concurrency = 2;
    let deadlockTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race([
        job.prime().then(
          () => ({ status: 'fulfilled' as const }),
          error => ({ status: 'rejected' as const, error }),
        ),
        new Promise<{ status: 'timeout' }>(resolve => {
          deadlockTimer = setTimeout(() => resolve({ status: 'timeout' }), 2_000);
        }),
      ]);
      if (deadlockTimer) clearTimeout(deadlockTimer);
      expect(outcome.status).toBe('rejected');
      if (outcome.status === 'rejected') {
        expect(outcome.error).toBeInstanceOf(SessionWorkspaceDirtyError);
      }
      expect(dirty).toBe(true);
      expect(await fsp.readFile(path.join(tmpDir, 'same.txt'), 'utf8')).toBe('faster bytes');
    } finally {
      if (deadlockTimer) clearTimeout(deadlockTimer);
      config.prime_concurrency = originalPrimeConcurrency;
      await job.cleanup();
    }
  });

  it('decodes UTF-8 percent-encoded names with non-ASCII characters', async () => {
    const file: TFile = {
      id: 'utf8-id',
      storage_session_id: 'prev-session',
      name: 'ignored.txt',
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

  it('rejects a server-supplied filename that escapes the submission dir', async () => {
    /* Companion guarantee for the path-preserving sanitizer on the
     * LibreChat side: if a malicious / misconfigured server tries to
     * smuggle a `..` traversal via Content-Disposition, the codeapi-side
     * `validateFilePath` aborts before any write happens. */
    const file: TFile = {
      id: 'evil-id',
      storage_session_id: 'prev-session',
      name: 'innocent.txt',
    };
    routes.set(`/sessions/${encodeURIComponent(file.storage_session_id!)}/objects/${encodeURIComponent(file.id!)}`, {
      status: 200,
      contentDisposition: "attachment; filename*=UTF-8''..%2F..%2Fescape.txt",
      body: 'should never be written',
    });

    const job = makeJob([file]);
    asInternals(job).submissionDir = tmpDir;

    /* downloadAndWriteFile rethrows ValidationError fast (no retries) so
     * `expect(...).rejects` is the right assertion. */
    await expect(job.downloadAndWriteFile(file)).rejects.toThrow();
    /* Defensive: nothing escaped to a parent dir. */
    const parent = path.dirname(tmpDir);
    await expect(fsp.access(path.join(parent, 'escape.txt'))).rejects.toThrow();
  });
});
