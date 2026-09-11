import { Readable } from 'node:stream';
import { createGzip } from 'node:zlib';
import { httpInputCacheEvents } from './metrics';
import { cachedInputResponse, openCachedInput, storeCachedInputs } from './session-inputs';

type Metadata = { cacheable: true; cacheKey: string; version: string; size: number; name?: string; readOnly: boolean };
type FillResult = { stored: boolean; status?: number; headers?: Headers };
type Fill = { controller: AbortController; users: number; result: Promise<FillResult> };
const fills = new Map<string, Fill>();

function validMetadata(value: unknown, maxBytes: number): value is Metadata {
  if (!value || typeof value !== 'object') return false;
  const m = value as Metadata;
  return m.cacheable === true && typeof m.cacheKey === 'string' && /^[0-9a-f]{64}$/.test(m.cacheKey) &&
    typeof m.version === 'string' && /^[0-9a-f-]{36}$/.test(m.version) &&
    Number.isSafeInteger(m.size) && m.size >= 0 && m.size + 1024 <= maxBytes &&
    typeof m.readOnly === 'boolean' && (m.name === undefined || (typeof m.name === 'string' && m.name.length <= 4096));
}

function tarHeader(name: string, bytes: number): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write('0000600\0', 100, 8, 'ascii');
  header.write(bytes.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
  header.fill(32, 148, 156);
  header[156] = 48;
  header.write('ustar\0', 257, 6, 'ascii');
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return header;
}

/** Reuse the pushed-cache writer's staging, quota, no-follow and atomic commit
 * rules. No workspace pathname or sandbox-visible file is used as cache input. */
async function fillCache(response: Response, meta: Metadata, maxBytes: number, maxObjects: number): Promise<void> {
  if (!response.body) throw new Error('Input response has no body');
  const body = response.body;
  const sidecar = Buffer.from(JSON.stringify({ readOnly: meta.readOnly, source: 'http' }));
  async function* archive(): AsyncGenerator<Buffer> {
    yield tarHeader(meta.cacheKey, meta.size);
    const reader = body.getReader();
    let bytes = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > meta.size) throw new Error('Input exceeded its authorized metadata size');
        yield Buffer.from(part.value);
      }
      if (bytes !== meta.size) throw new Error('Input size changed during preparation');
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    yield Buffer.alloc((512 - meta.size % 512) % 512);
    yield tarHeader(`${meta.cacheKey}.json`, sidecar.length);
    yield sidecar;
    yield Buffer.alloc((512 - sidecar.length % 512) % 512);
    yield Buffer.alloc(1024);
  }
  const source = Readable.from(archive());
  const compressed = createGzip();
  compressed.on('error', () => {}); // Queue admission checks an already-failed stream.
  source.on('error', error => compressed.destroy(error));
  source.pipe(compressed);
  try {
    await storeCachedInputs(compressed, maxBytes, meta.size + sidecar.length, maxObjects);
  } finally {
    source.destroy();
    compressed.destroy();
    await body.cancel().catch(() => {});
  }
}

async function waitForFill(fill: Fill, signal?: AbortSignal): Promise<FillResult> {
  if (signal?.aborted) {
    if (fill.users === 0) fill.controller.abort(signal.reason);
    signal.throwIfAborted();
  }
  fill.users++;
  let abort: (() => void) | undefined;
  try {
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal?.reason ?? new Error('Input preparation cancelled'));
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
    return await Promise.race([fill.result, cancelled]);
  } finally {
    if (abort) signal?.removeEventListener('abort', abort);
    if (--fill.users === 0) fill.controller.abort(new Error('No input-cache consumers remain'));
  }
}

/** Every caller performs its own scoped preflight, even for hits or shared fills.
 * Only opaque version keys returned by that authorized gateway enter this cache. */
export async function fetchCachedHttpInput(args: {
  metadata(): Promise<Response>;
  download(version: string, signal: AbortSignal): Promise<Response>;
  signal?: AbortSignal;
  maxBytes: number;
  maxFileBytes: number;
  maxInflight: number;
  maxObjects: number;
}): Promise<Response | undefined> {
  args.signal?.throwIfAborted();
  const preflight = await args.metadata();
  if (preflight.status === 404 || preflight.status === 405) {
    await preflight.body?.cancel();
    httpInputCacheEvents.inc({ event: 'legacy_bypass' });
    return undefined; // Older gateway/relay: retain the uncached protocol.
  }
  if (!preflight.ok) { httpInputCacheEvents.inc({ event: 'preflight_failure' }); return preflight; }
  const value: unknown = await preflight.json();
  if (!validMetadata(value, args.maxBytes) || value.size > args.maxFileBytes) {
    httpInputCacheEvents.inc({ event: 'uncacheable' });
    return undefined;
  }
  const meta = value;
  args.signal?.throwIfAborted();
  let cached = await openCachedInput('', '', meta.cacheKey, 'http');
  if (cached) httpInputCacheEvents.inc({ event: 'hit' });
  if (!cached) {
    let fill = fills.get(meta.cacheKey);
    if (fill) httpInputCacheEvents.inc({ event: 'coalesced' });
    if (!fill) {
      if (fills.size >= args.maxInflight) {
        httpInputCacheEvents.inc({ event: 'capacity_bypass' });
        return undefined;
      }
      httpInputCacheEvents.inc({ event: 'fill' });
      const controller = new AbortController();
      fill = { controller, users: 0, result: Promise.resolve({ stored: false }) };
      const ownFill = fill;
      fills.set(meta.cacheKey, ownFill);
      ownFill.result = (async (): Promise<FillResult> => {
        const response = await args.download(meta.version, controller.signal);
        if (!response.ok) {
          await response.body?.cancel();
          return { stored: false, status: response.status, headers: response.headers };
        }
        if (response.headers.get('x-codeapi-input-version') !== meta.version ||
          (response.headers.get('x-read-only')?.toLowerCase() === 'true') !== meta.readOnly) {
          await response.body?.cancel();
          return { stored: false }; // Old file server or inconsistent metadata: never publish.
        }
        await fillCache(response, meta, args.maxBytes, args.maxObjects);
        return { stored: true };
      })().finally(() => {
        if (fills.get(meta.cacheKey) === ownFill) fills.delete(meta.cacheKey);
      });
      // A caller can cancel between admission and waiting; avoid an unhandled rejection.
      void ownFill.result.catch(() => {});
    }
    const result = await waitForFill(fill, args.signal);
    if (result.status) {
      const headers = new Headers(result.headers);
      headers.delete('content-length');
      return new Response(null, { status: result.status, headers });
    }
    if (!result.stored) return undefined;
    cached = await openCachedInput('', '', meta.cacheKey, 'http');
  }
  if (!cached) return undefined; // Evicted between commit and open: normal download remains correct.
  if (args.signal?.aborted) {
    await cached.handle.close();
    args.signal.throwIfAborted();
  }
  const response = cachedInputResponse(cached);
  if (meta.name) response.headers.set('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(meta.name)}`);
  return response;
}
