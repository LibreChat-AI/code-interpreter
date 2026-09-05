import type { IncomingHttpHeaders } from 'node:http';
import { microvmPortHeaders, type MicrovmAuthToken } from '../runtime-session/lambda-client';

export interface HostedAppPreviewHeaderWriter {
  setHeader(name: string, value: string): unknown;
}

/** Browser-enforced guardrails owned by the trusted gateway, not user code. */
export function applyHostedAppPreviewSecurityHeaders(
  response: HostedAppPreviewHeaderWriter,
): void {
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-DNS-Prefetch-Control', 'off');
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  /* The app origin and browser cache outlive an individual capability and app
   * revision. User-controlled caching could otherwise replay old HTML/JS after
   * the revision-bound cookie has expired or a replacement has landed. */
  response.setHeader('Cache-Control', 'private, no-store');
  /* User code has no server-side egress and should not regain it through the
   * owner's browser. Disabling workers also prevents a service worker from one
   * revision persisting on this stable app origin into a later revision. */
  response.setHeader('Content-Security-Policy', [
    "default-src 'self' data: blob:",
    "connect-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "font-src 'self' data:",
    "worker-src 'none'",
    "child-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'self'",
  ].join('; '));
  response.setHeader(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  );
}

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
  'content-disposition',
  'content-language',
  'content-range',
  'content-type',
  'etag',
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
  publicOrigin?: { host: string; protocol: 'https' | 'http' },
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
  if (publicOrigin) {
    headers.set('X-Forwarded-Host', publicOrigin.host);
    headers.set('X-Forwarded-Proto', publicOrigin.protocol);
  }
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
