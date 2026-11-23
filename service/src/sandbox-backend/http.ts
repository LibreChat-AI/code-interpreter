import axios, { type AxiosError, type AxiosResponse } from 'axios';
import type { SandboxBackend, SandboxExecuteContext, SandboxRawResponse, SandboxTransportRequest } from './types';
import { injectTraceHeaders, withSpan } from '../telemetry';
import { Jobs } from '../enum';
import { env } from '../config';
import { MAX_RUNNER_DRAIN_RETRIES, MAX_RUNNER_DRAIN_RETRY_DELAY_MS } from '../../../shared/drain-contract';

function isRunnerDrainingError(error: unknown): error is AxiosError {
  if (!axios.isAxiosError(error) || error.response?.status !== 503) return false;
  const data = error.response.data;
  return typeof data === 'object'
    && data !== null
    && (data as { error?: unknown }).error === 'runner_draining';
}

function retryAfterMillis(error: AxiosError): number {
  const raw = error.response?.headers['retry-after'];
  const seconds = Number(Array.isArray(raw) ? raw[0] : raw);
  if (!Number.isFinite(seconds) || seconds < 0) return 1_000;
  return Math.min(seconds * 1_000, MAX_RUNNER_DRAIN_RETRY_DELAY_MS);
}

async function delayWithSignal(timeoutMillis: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw signal.reason ?? new Error('Aborted');
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, timeoutMillis);
    const onAbort = (): void => {
      clearTimeout(timeout);
      reject(signal.reason ?? new Error('Aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** POST the signed request to SANDBOX_ENDPOINT. An explicit runner_draining
 * response is safe to retry because the runner rejects it before execution.
 * All ambiguous failures remain untouched so code with side effects is never
 * replayed after a connection loss. */
export class HttpSandboxBackend implements SandboxBackend {
  readonly name = 'http' as const;

  async execute(req: SandboxTransportRequest, ctx: SandboxExecuteContext): Promise<SandboxRawResponse> {
    const response = await withSpan('codeapi.sandbox.execute', {
      'http.request.method': 'POST',
      'url.path': `/${Jobs.execute}`,
      'codeapi.language': ctx.language,
      'codeapi.sandbox.backend': this.name,
    }, async (): Promise<AxiosResponse<SandboxRawResponse>> => {
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await axios.post<SandboxRawResponse>(
            `${env.SANDBOX_ENDPOINT}/${Jobs.execute}`,
            req.body,
            {
              maxRedirects: 0,
              headers: injectTraceHeaders(req.headers),
              signal: ctx.signal,
            },
          );
        } catch (error) {
          if (!isRunnerDrainingError(error) || attempt >= MAX_RUNNER_DRAIN_RETRIES) {
            throw error;
          }
          await delayWithSignal(retryAfterMillis(error), ctx.signal);
        }
      }
    }, 'CLIENT');

    if (response.status !== 200) {
      throw new Error('Error from sandbox');
    }

    return response.data;
  }
}
