import { randomBytes } from 'node:crypto';
import { Router, json } from 'express';
import type { Request as ExpressRequest, Response as ExpressResponse } from 'express';
import { internalServiceHeaders, requireInternalServiceAuth } from './internal-service-auth';

/**
 * The API and the file server it forwards uploads to must share one Redis:
 * the API registers each upload session there and the file server reads it
 * back to write the record that later authorizes the object (see
 * `upload-record.ts`). Nothing else ties the two together, so a file server
 * pointed at another Redis accepts requests and every upload is silently
 * unusable.
 *
 * The check: the API writes a short-lived random key to its Redis and asks the
 * file server whether it can see it. Only the random id travels; the file
 * server derives the key itself, so the route cannot be used to test for any
 * other key.
 */

export const STORE_PROBE_PATH = '/internal/store-probe';
export const STORE_PROBE_TTL_SECONDS = 60;
export const STORE_PROBE_TIMEOUT_MS = 5_000;

const PROBE_ID = /^[0-9a-f]{32}$/;
const probeKey = (id: string): string => `store-probe:${id}`;

/** Statuses an HTTP server answers with when it has no such route. */
const ENDPOINT_MISSING_STATUSES = new Set([404, 405, 501]);

/** File-server side: reports whether the caller's probe key exists in this server's Redis. */
export function createStoreProbeRouter(
  store: { exists(key: string): Promise<number> },
  onStoreError: (error: unknown) => void,
): Router {
  const router = Router();
  router.post(
    STORE_PROBE_PATH,
    requireInternalServiceAuth,
    json({ limit: '1kb' }),
    async (req: ExpressRequest, res: ExpressResponse) => {
      const probe: unknown = (req.body as { probe?: unknown } | undefined)?.probe;
      if (typeof probe !== 'string' || !PROBE_ID.test(probe)) {
        return res.status(400).json({ error: 'Invalid store probe' });
      }
      try {
        const visible = (await store.exists(probeKey(probe))) === 1;
        return res.status(200).json({ visible });
      } catch (error) {
        onStoreError(error);
        return res.status(503).json({ error: 'Store unavailable' });
      }
    },
  );
  return router;
}

/**
 * Why a check could not conclude. None of these means the stores differ:
 * - `endpoint_missing`: the file server predates the probe route.
 * - `unauthorized`: the internal service token differs between the two.
 * - `file_server_unavailable`: no answer in time, or a 5xx.
 * - `unexpected_response`: something other than a file server answered.
 * - `store_unavailable`: the API could not write the probe to its own Redis.
 */
export type StorePairingUnknownReason =
  | 'endpoint_missing'
  | 'unauthorized'
  | 'file_server_unavailable'
  | 'unexpected_response'
  | 'store_unavailable';

export type StorePairing =
  | { status: 'shared' }
  | { status: 'split' }
  | { status: 'unknown'; reason: StorePairingUnknownReason };

const inconclusive = (reason: StorePairingUnknownReason): StorePairing => ({ status: 'unknown', reason });

export interface StoreProbeWriter {
  set(key: string, value: string, expiryMode: 'EX', ttlSeconds: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

async function readProbeResponse(response: Response): Promise<StorePairing> {
  if (response.ok) {
    const body: unknown = await response.json().catch(() => undefined);
    const visible = (body as { visible?: unknown } | null | undefined)?.visible;
    if (typeof visible !== 'boolean') return inconclusive('unexpected_response');
    return { status: visible ? 'shared' : 'split' };
  }
  await response.body?.cancel().catch(() => undefined);
  if (ENDPOINT_MISSING_STATUSES.has(response.status)) return inconclusive('endpoint_missing');
  if (response.status === 401 || response.status === 403) return inconclusive('unauthorized');
  return inconclusive(response.status >= 500 ? 'file_server_unavailable' : 'unexpected_response');
}

/**
 * API side: one check, bounded by `timeoutMs` end to end. Never throws, and
 * never reports `split` unless the file server answered that its Redis does
 * not hold the key this call just wrote.
 */
export async function probeFileServerStore(opts: {
  store: StoreProbeWriter;
  fileServerUrl: string;
  timeoutMs?: number;
}): Promise<StorePairing> {
  const id = randomBytes(16).toString('hex');
  const key = probeKey(id);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? STORE_PROBE_TIMEOUT_MS);
  /* A Redis client that queues commands while disconnected would otherwise
   * hold the write, and with it startup, until Redis returns. */
  const timedOut = new Promise<never>((_, reject) => {
    controller.signal.addEventListener('abort', () => reject(new Error('Store probe timed out')), { once: true });
  });
  timedOut.catch(() => undefined);
  try {
    try {
      await Promise.race([opts.store.set(key, '1', 'EX', STORE_PROBE_TTL_SECONDS), timedOut]);
    } catch {
      return inconclusive('store_unavailable');
    }
    let response: Response;
    try {
      response = await fetch(`${opts.fileServerUrl.replace(/\/+$/, '')}${STORE_PROBE_PATH}`, {
        method: 'POST',
        redirect: 'error',
        headers: internalServiceHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ probe: id }),
        signal: controller.signal,
      });
    } catch {
      return inconclusive('file_server_unavailable');
    }
    return await readProbeResponse(response);
  } finally {
    clearTimeout(timer);
    /* Best effort and not awaited: the key expires on its own. */
    void opts.store.del(key).catch(() => undefined);
  }
}

export interface StorePairingLog {
  info(message: string, meta?: object): unknown;
  warn(message: string, meta?: object): unknown;
  error(message: string, meta?: object): unknown;
}

export interface StorePairingDelays {
  /** Wait before re-probing a first `split`, which is reported only once confirmed. */
  confirmMs: number;
  /** First retry after an inconclusive check; doubles up to `maxRetryMs`. */
  retryMs: number;
  maxRetryMs: number;
  /** Interval between checks while the stores are known to differ. */
  recheckMs: number;
}

const DEFAULT_DELAYS: StorePairingDelays = {
  confirmMs: 1_000,
  retryMs: 2_000,
  maxRetryMs: 60_000,
  recheckMs: 30_000,
};

const SPLIT_MESSAGE =
  'File server does not share this API\'s Redis: it cannot see the sessions this API registers, ' +
  'so uploads are refused and no stored file can be authorized for download, execution input or import. ' +
  'Point the API and the file server at the same Redis (REDIS_HOST/REDIS_PORT). ' +
  'Reporting unhealthy until they match.';

const UNKNOWN_MESSAGES: Record<StorePairingUnknownReason, string> = {
  endpoint_missing:
    'File server does not expose the store check (older version); ' +
    'cannot verify that it shares this API\'s Redis',
  unauthorized:
    'File server rejected the store check: CODEAPI_INTERNAL_SERVICE_TOKEN differs between the API and the file server',
  file_server_unavailable:
    'File server did not answer the store check; cannot yet verify that it shares this API\'s Redis',
  unexpected_response:
    'FILE_SERVER_URL answered the store check with an unexpected response; ' +
    'cannot verify that it shares this API\'s Redis',
  store_unavailable:
    'Could not write the store check to this API\'s Redis; cannot yet verify that the file server shares it',
};

export interface StorePairingMonitor {
  /** Resolves when the first result is in (or on `stop`); later checks run in the background. */
  start(): Promise<void>;
  stop(): void;
  status(): StorePairing['status'];
}

/**
 * Runs the check until it concludes. `shared` ends it: both ends fix their
 * Redis at process start, and a file server that later loses sight of a
 * session refuses that upload itself. `split` keeps re-checking so a corrected
 * file server clears the condition without an API restart. Anything
 * inconclusive retries with backoff and never counts as a failure.
 */
export function createStorePairingMonitor(opts: {
  probe: () => Promise<StorePairing>;
  log: StorePairingLog;
  /** Label for log lines; a host, never a URL with credentials. */
  fileServer: string;
  delays?: Partial<StorePairingDelays>;
}): StorePairingMonitor {
  const delays = { ...DEFAULT_DELAYS, ...opts.delays };
  const meta = { fileServer: opts.fileServer };
  let current: StorePairing = inconclusive('file_server_unavailable');
  let reported = false;
  let splitAwaitingConfirmation = false;
  let inconclusiveStreak = 0;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let first: Promise<void> | undefined;
  let resolveFirst: (() => void) | undefined;

  const schedule = (delayMs: number): void => {
    timer = setTimeout(() => void check(), delayMs);
    timer.unref();
  };

  const report = (result: StorePairing): void => {
    const previous = current;
    const changed = !reported ||
      previous.status !== result.status ||
      (previous.status === 'unknown' && result.status === 'unknown' && previous.reason !== result.reason);
    current = result;
    reported = true;
    resolveFirst?.();
    if (result.status === 'split') {
      opts.log.error(SPLIT_MESSAGE, meta);
      return;
    }
    if (!changed) return;
    if (result.status === 'shared') {
      opts.log.info('File server shares this API\'s Redis', meta);
      return;
    }
    opts.log.warn(UNKNOWN_MESSAGES[result.reason], { ...meta, reason: result.reason });
  };

  const check = async (): Promise<void> => {
    const result = await opts.probe().catch(() => inconclusive('file_server_unavailable'));
    if (stopped) return;
    if (result.status === 'split' && current.status !== 'split' && !splitAwaitingConfirmation) {
      splitAwaitingConfirmation = true;
      schedule(delays.confirmMs);
      return;
    }
    splitAwaitingConfirmation = false;
    /* A known split stands until a check proves otherwise. Only a file server
     * that no longer has the route (rolled back) returns it to unknown. */
    if (current.status === 'split' && result.status === 'unknown' && result.reason !== 'endpoint_missing') {
      schedule(delays.recheckMs);
      return;
    }
    report(result);
    if (result.status === 'shared') return;
    if (result.status === 'split') {
      inconclusiveStreak = 0;
      schedule(delays.recheckMs);
      return;
    }
    schedule(Math.min(delays.retryMs * 2 ** inconclusiveStreak, delays.maxRetryMs));
    inconclusiveStreak += 1;
  };

  return {
    start(): Promise<void> {
      first ??= new Promise<void>((resolve) => {
        resolveFirst = resolve;
        void check();
      });
      return first;
    },
    stop(): void {
      stopped = true;
      clearTimeout(timer);
      resolveFirst?.();
    },
    status: () => current.status,
  };
}
