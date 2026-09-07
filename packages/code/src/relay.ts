import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FileRelayOptions {
  host: string;
  port: number;
  upstreamUrl: string;
  token: string;
  maxBytes: number;
  timeoutMs: number;
  maxConcurrentRequests?: number;
}

export interface FileRelayHandle {
  url: string;
  close(): Promise<void>;
}

const OBJECT_PATH = /^\/sessions\/[^/]+\/objects\/[^/]+$/;
const OBJECT_LIST_PATH = /^\/sessions\/[^/]+\/objects$/;
const MAX_RELAY_HEADER_BYTES = 512 * 1024;
const LOCAL_HTTP_HOSTS = new Set([
  '127.0.0.1',
  '[::1]',
  'localhost',
  'host.docker.internal',
  'gateway.docker.internal',
]);

class RelayPayloadTooLargeError extends Error {}
class UpstreamPayloadTooLargeError extends Error {}

export function validateFileRelayUpstream(value: string): URL {
  const upstream = new URL(value);
  if (
    (upstream.protocol !== 'http:' && upstream.protocol !== 'https:') ||
    upstream.username ||
    upstream.password ||
    upstream.search ||
    upstream.hash
  ) {
    throw new Error(
      'File relay upstream must be an HTTP URL without credentials, query, or fragment',
    );
  }
  if (
    upstream.protocol !== 'https:' &&
    !LOCAL_HTTP_HOSTS.has(upstream.hostname.toLowerCase())
  ) {
    throw new Error(
      'File relay upstream must use HTTPS unless it is a local development host',
    );
  }
  return upstream;
}

function positiveInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function tokenMatches(
  expected: string,
  supplied: string | string[] | undefined,
): boolean {
  if (typeof supplied !== 'string') return false;
  return timingSafeEqual(
    createHash('sha256').update(expected).digest(),
    createHash('sha256').update(supplied).digest(),
  );
}

async function readRequestBody(
  request: IncomingMessage,
  maxBytes: number,
): Promise<Buffer> {
  const declaredLength = request.headers['content-length'];
  if (
    typeof declaredLength === 'string' &&
    (!/^\d+$/.test(declaredLength) || Number(declaredLength) > maxBytes)
  ) {
    throw new RelayPayloadTooLargeError();
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxBytes) throw new RelayPayloadTooLargeError();
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function readResponseBody(
  response: Response,
  maxBytes: number,
): Promise<Buffer> {
  const declaredLength = response.headers.get('content-length');
  if (
    declaredLength != null &&
    (!/^\d+$/.test(declaredLength) || Number(declaredLength) > maxBytes)
  ) {
    await response.body?.cancel();
    throw new UpstreamPayloadTooLargeError();
  }
  if (response.body == null) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new UpstreamPayloadTooLargeError();
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  return Buffer.concat(chunks);
}

export async function startFileRelay(
  options: FileRelayOptions,
): Promise<FileRelayHandle> {
  const upstream = validateFileRelayUpstream(options.upstreamUrl);
  if (!options.token.trim()) throw new Error('File relay token is required');
  positiveInteger('File relay maxBytes', options.maxBytes);
  positiveInteger('File relay timeoutMs', options.timeoutMs);
  const maxConcurrentRequests = positiveInteger(
    'File relay maxConcurrentRequests',
    options.maxConcurrentRequests ?? 8,
  );
  let activeRequests = 0;
  const server = createServer(
    { maxHeaderSize: MAX_RELAY_HEADER_BYTES },
    async (request, response) => {
      let admitted = false;
      try {
        if (
          !tokenMatches(
            options.token,
            request.headers['x-librechat-code-relay-token'],
          )
        ) {
          response.writeHead(401).end();
          return;
        }
        const requestUrl = new URL(request.url ?? '/', 'http://relay.invalid');
        if (request.method === 'GET' && requestUrl.pathname === '/health') {
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end('{"status":"ok"}');
          return;
        }
        const objectRequest =
          OBJECT_PATH.test(requestUrl.pathname) && requestUrl.search.length === 0;
        const normalizedListRequest =
          request.method === 'GET' &&
          OBJECT_LIST_PATH.test(requestUrl.pathname) &&
          requestUrl.searchParams.size === 1 &&
          requestUrl.searchParams.get('detail') === 'normalized';
        if (
          (request.method !== 'GET' && request.method !== 'PUT') ||
          (!objectRequest && !normalizedListRequest)
        ) {
          response.writeHead(404).end();
          return;
        }
        const grant = request.headers['x-codeapi-egress-grant'];
        if (typeof grant !== 'string' || grant.length === 0) {
          response.writeHead(403).end();
          return;
        }
        if (activeRequests >= maxConcurrentRequests) {
          response.writeHead(503, { 'Retry-After': '1' }).end();
          return;
        }
        activeRequests += 1;
        admitted = true;
        const target = new URL(upstream);
        target.pathname = `${upstream.pathname.replace(/\/$/, '')}${
          requestUrl.pathname
        }`;
        target.search = requestUrl.search;
        const requestBody =
          request.method === 'PUT'
            ? await readRequestBody(request, options.maxBytes)
            : undefined;
        const upstreamResponse = await fetch(target, {
          method: request.method,
          headers: {
            ...(typeof grant === 'string'
              ? { 'X-CodeAPI-Egress-Grant': grant }
              : {}),
            ...(request.method === 'PUT'
              ? {
                  'Content-Length': String(requestBody?.length ?? 0),
                  ...(typeof request.headers['content-type'] === 'string'
                    ? {
                        'Content-Type': request.headers['content-type'],
                      }
                    : {}),
                  ...(typeof request.headers['x-original-filename'] === 'string'
                    ? {
                        'X-Original-Filename':
                          request.headers['x-original-filename'],
                      }
                    : {}),
                }
              : {}),
          },
          body: requestBody ? new Uint8Array(requestBody) : undefined,
          redirect: 'manual',
          signal: AbortSignal.timeout(options.timeoutMs),
        });
        const body = await readResponseBody(upstreamResponse, options.maxBytes);
        response.writeHead(upstreamResponse.status, {
          ...(upstreamResponse.headers.get('content-type')
            ? {
                'Content-Type': upstreamResponse.headers.get('content-type')!,
              }
            : {}),
          ...(upstreamResponse.headers.get('x-read-only')
            ? {
                'X-Read-Only': upstreamResponse.headers.get('x-read-only')!,
              }
            : {}),
          ...(upstreamResponse.headers.get('content-disposition')
            ? {
                'Content-Disposition': upstreamResponse.headers.get(
                  'content-disposition',
                )!,
              }
            : {}),
          'Content-Length': String(body.length),
        });
        response.end(body);
      } catch (error) {
        if (error instanceof RelayPayloadTooLargeError) {
          if (!response.headersSent) response.writeHead(413);
          response.end();
          return;
        }
        if (!response.headersSent) response.writeHead(502);
        response.end();
      } finally {
        if (admitted) activeRequests -= 1;
      }
    },
  );
  server.requestTimeout = options.timeoutMs;
  server.headersTimeout = options.timeoutMs;
  server.keepAliveTimeout = Math.min(options.timeoutMs, 5_000);
  server.maxRequestsPerSocket = 100;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://${options.host}:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
