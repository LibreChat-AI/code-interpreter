import fs from 'fs';
import path from 'path';
import express, { type Request, type Response } from 'express';
import { config } from '../config';
import { Job } from '../job';
import { getLatestRuntimeMatchingLanguageVersion } from '../runtime';
import {
  EXECUTION_MANIFEST_HEADER,
  ExecutionManifestError,
  executionManifestBodySha256,
  verifyExecutionManifestWithKey,
} from '../execution-manifest';
import { logger } from '../logger';

const router = express.Router();
const NPM_FETCH_TOKEN_HEADER = 'X-CodeAPI-Npm-Fetch-Token';
const KEEP = ['**/*.d.ts', 'package.json'] as const;

type NpmUnitSandboxBody = {
  execution_id: string;
  name: string;
  version: string;
  integrity: string;
  resolved: string;
  keep: string[];
  fetch_token: string;
  execution_manifest?: string;
};

function failure(
  res: Response,
  status: number,
  error: string,
  message: string,
  retryable: boolean,
  usage?: Record<string, number>,
): Response {
  return res.status(status).json({ error, message, retryable, ...(usage ? { usage } : {}) });
}

function parentObservedUsage(
  started: number,
  tarballBytes: number,
  cgroupPeakBytes: number | null | undefined,
): Record<string, number> {
  return {
    tarballBytes,
    ...(cgroupPeakBytes == null ? {} : { cgroupPeakBytes }),
    wallMs: Math.round(performance.now() - started),
  };
}

function validateBody(raw: unknown): NpmUnitSandboxBody {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Request body must be an object');
  }
  const body = raw as Record<string, unknown>;
  for (const field of ['execution_id', 'name', 'version', 'integrity', 'resolved', 'fetch_token'] as const) {
    if (typeof body[field] !== 'string' || body[field].length === 0) {
      throw new Error(`${field} is required as a non-empty string`);
    }
  }
  if ((body.execution_id as string).length > 256 || (body.fetch_token as string).length > 16_384) {
    throw new Error('Execution id or fetch token is too long');
  }
  if (
    !Array.isArray(body.keep) ||
    body.keep.length !== KEEP.length ||
    KEEP.some(value => !(body.keep as unknown[]).includes(value))
  ) {
    throw new Error(`keep must be exactly ${JSON.stringify(KEEP)}`);
  }
  return body as NpmUnitSandboxBody;
}

function verifyManifest(body: NpmUnitSandboxBody): void {
  if (!config.require_execution_manifest) return;
  const token = body.execution_manifest;
  if (!token) throw new ExecutionManifestError('missing_header', `${EXECUTION_MANIFEST_HEADER} is required`);
  const claims = verifyExecutionManifestWithKey(token, {
    publicKey: config.execution_manifest_public_key,
    secret: config.execution_manifest_secret,
  });
  if (claims.operation !== 'npm-unit' || claims.exec_id !== body.execution_id) {
    throw new ExecutionManifestError('scope_mismatch', 'Execution manifest does not authorize this npm unit');
  }
  if (claims.execute_body_sha256 !== executionManifestBodySha256(body)) {
    throw new ExecutionManifestError('scope_mismatch', 'Execution manifest body hash does not match request');
  }
}

async function readBoundedTarball(response: globalThis.Response): Promise<Buffer> {
  if (!response.body) throw new Error('Registry gateway response had no body');
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = response.body.getReader();
  try {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > config.npm_tarball_max_bytes) {
          throw new Error('npm_tarball_too_large');
        }
        chunks.push(Buffer.from(value));
      }
    } catch (error) {
      // A chunked upstream that crosses the gateway limit is terminated after
      // exactly maxBytes have reached this reader. Preserve the structured
      // too_large outcome instead of flattening that enforced cutoff into a
      // generic transport failure.
      if (total >= config.npm_tarball_max_bytes) throw new Error('npm_tarball_too_large');
      throw error;
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

async function gatewayError(response: globalThis.Response): Promise<{ error: string; message: string; retryable: boolean }> {
  try {
    const raw = await response.text();
    if (Buffer.byteLength(raw) > 8192) throw new Error('oversize');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      error: typeof parsed.error === 'string' ? parsed.error : 'registry_unavailable',
      message: typeof parsed.message === 'string' ? parsed.message : 'Registry request failed',
      retryable: parsed.retryable === true,
    };
  } catch {
    return { error: 'registry_unavailable', message: 'Registry request failed', retryable: true };
  }
}

function publicStatus(error: string, retryable: boolean): number {
  if (error === 'not_publicly_fetchable') return 404;
  if (error === 'unsupported_registry' || error === 'invalid_request') return 400;
  if (error === 'too_large' || error === 'decompression_limit') return 413;
  if (error === 'integrity_mismatch' || error === 'unsafe_entry' || error === 'parse_failed') return 422;
  if (error === 'timeout') return 504;
  return retryable ? 503 : 502;
}

router.post('/npm-unit', express.json({ limit: '64kb' }), async (req: Request, res: Response) => {
  const started = performance.now();
  let job: Job | undefined;
  try {
    if (!config.npm_unit_enabled) {
      return failure(res, 503, 'disabled', 'npm unit indexing is disabled', false);
    }
    let body: NpmUnitSandboxBody;
    try {
      body = validateBody(req.body);
      verifyManifest(body);
    } catch (error) {
      if (error instanceof ExecutionManifestError) {
        const status = error.reason === 'missing_header' ? 401 : 403;
        return failure(res, status, 'invalid_request', error.message, false);
      }
      return failure(res, 400, 'invalid_request', (error as Error).message, false);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.npm_unit_fetch_timeout);
    let gatewayResponse: globalThis.Response;
    try {
      gatewayResponse = await fetch(`${config.egress_gateway_url.replace(/\/+$/, '')}/npm/tarball`, {
        method: 'GET',
        headers: { [NPM_FETCH_TOKEN_HEADER]: body.fetch_token },
        signal: controller.signal,
      });
    } catch (error) {
      const timedOut = controller.signal.aborted || (error as Error)?.name === 'AbortError';
      return failure(
        res,
        503,
        'registry_unavailable',
        timedOut ? 'Registry request timed out' : 'Registry gateway was unavailable',
        true,
      );
    } finally {
      clearTimeout(timeout);
    }

    if (!gatewayResponse.ok) {
      const detail = await gatewayError(gatewayResponse);
      return failure(res, publicStatus(detail.error, detail.retryable), detail.error, detail.message, detail.retryable);
    }

    let tarball: Buffer;
    try {
      tarball = await readBoundedTarball(gatewayResponse);
    } catch (error) {
      const tooLarge = (error as Error).message === 'npm_tarball_too_large';
      return failure(
        res,
        tooLarge ? 413 : 503,
        tooLarge ? 'too_large' : 'registry_unavailable',
        tooLarge ? 'Package tarball exceeded the configured byte limit' : 'Registry response ended unexpectedly',
        !tooLarge,
      );
    }

    const runtime = getLatestRuntimeMatchingLanguageVersion('node', '*');
    if (!runtime) return failure(res, 500, 'sandbox_unavailable', 'Pinned Node runtime is unavailable', true);
    const workerPath = path.join(__dirname, 'npm-unit-worker.cjs');
    let workerSource: string;
    try {
      workerSource = fs.readFileSync(workerPath, 'utf8');
    } catch {
      return failure(res, 500, 'sandbox_unavailable', 'npm unit worker asset is unavailable', true);
    }

    const workerRequest = {
      name: body.name,
      version: body.version,
      integrity: body.integrity,
      keep: [...KEEP],
      limits: {
        maxUnpackedBytes: config.npm_unit_max_unpacked_bytes,
        maxKeptBytes: config.npm_unit_max_kept_bytes,
        maxFileBytes: config.npm_unit_max_file_bytes,
        maxEntries: config.npm_unit_max_entries,
      },
    };
    job = new Job({
      session_id: body.execution_id,
      output_session_id: body.execution_id,
      runtime: { ...runtime, output_max_size: config.npm_unit_max_response_bytes },
      files: [
        { name: 'npm-unit-worker.cjs', content: workerSource, encoding: 'utf8' },
        { name: 'request.json', content: JSON.stringify(workerRequest), encoding: 'utf8' },
        { name: 'package.tgz', content: tarball.toString('base64'), encoding: 'base64' },
      ],
      args: [],
      stdin: '',
      timeouts: { compile: 0, run: config.npm_unit_run_timeout },
      cpu_times: { compile: 0, run: config.npm_unit_cpu_time },
      memory_limits: { compile: config.npm_unit_memory_limit, run: config.npm_unit_memory_limit },
      report_memory_peak: true,
    });
    await job.prime();
    const result = await job.execute();
    const run = result.run ?? result.compile;
    const observedUsage = parentObservedUsage(started, tarball.length, run?.memory);
    if (run?.status === 'TO') {
      return failure(res, 504, 'timeout', 'Package parsing exceeded the wall-clock limit', false, observedUsage);
    }
    if (run?.message === 'Out of memory' || run?.signal === 'SIGKILL') {
      return failure(res, 413, 'too_large', 'Package parsing exceeded the sandbox resource limit', false, observedUsage);
    }
    if (!run || run.code !== 0) {
      logger.warn({ executionId: body.execution_id, status: run?.status, code: run?.code }, 'npm unit worker failed');
      return failure(res, 422, 'parse_failed', 'Package surface could not be parsed', false, observedUsage);
    }
    let response: Record<string, unknown>;
    try {
      response = JSON.parse(run.stdout) as Record<string, unknown>;
    } catch {
      return failure(res, 422, 'parse_failed', 'Package parser returned an invalid response', false);
    }
    const usage = response.usage;
    if (usage && typeof usage === 'object') {
      (usage as Record<string, unknown>).wallMs = Math.round(performance.now() - started);
      if (run.memory != null) {
        (usage as Record<string, unknown>).cgroupPeakBytes = run.memory;
      }
    }
    if (typeof response.error === 'string') {
      const retryable = response.retryable === true;
      return res.status(publicStatus(response.error, retryable)).json(response);
    }
    return res.status(200).json(response);
  } catch (error) {
    logger.error({ err: error }, 'npm unit route failed');
    return failure(res, 500, 'sandbox_unavailable', 'npm unit sandbox failed', true);
  } finally {
    await job?.cleanup().catch(error => logger.error({ err: error }, 'npm unit workspace cleanup failed'));
  }
});

export default router;
