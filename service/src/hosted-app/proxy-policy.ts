import type { IncomingHttpHeaders } from 'node:http';
import { microvmPortHeaders, type MicrovmAuthToken } from '../runtime-session/lambda-client';

const SAFE_REQUEST_HEADERS = new Set([
  'accept',
  'accept-language',
  'cache-control',
  'content-type',
  'if-match',
  'if-modified-since',
  'if-none-match',
  'if-range',
  'if-unmodified-since',
  'range',
  'user-agent',
]);

const SAFE_RESPONSE_HEADERS = new Set([
  'accept-ranges',
  'cache-control',
  'content-disposition',
  'content-language',
  'content-range',
  'content-type',
  'etag',
  'expires',
  'last-modified',
  'vary',
]);

/** Build a capability-minimal upstream request. In particular, never expose
 * LibreChat/CodeAPI auth cookies, API keys, forwarded identity, or an
 * attacker-supplied AWS proxy credential to the untrusted hosted app. */
export function hostedAppProxyRequestHeaders(
  source: IncomingHttpHeaders,
  token: MicrovmAuthToken,
  previewPort: number,
): Headers {
  const headers = new Headers({
    [token.headerName]: token.token,
    ...microvmPortHeaders(previewPort),
  });
  for (const [name, value] of Object.entries(source)) {
    const lower = name.toLowerCase();
    if (!SAFE_REQUEST_HEADERS.has(lower) && !lower.startsWith('x-app-')) continue;
    if (value == null) continue;
    headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  headers.delete('content-length');
  return headers;
}
/** Cookies, redirects, CORS, and security-policy headers from user code must
 * not mutate the CodeAPI/LibreChat origin. The narrow representation headers
 * below are sufficient for HTML, assets, ranges, and SSE. */
export function hostedAppProxyResponseHeaders(source: Headers): Headers {
  const headers = new Headers();
  source.forEach((value, name) => {
    if (SAFE_RESPONSE_HEADERS.has(name.toLowerCase())) headers.set(name, value);
  });
  return headers;
}
