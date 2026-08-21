import { describe, expect, test } from 'bun:test';
import {
  applyHostedAppPreviewSecurityHeaders,
  hostedAppProxyRequestHeaders,
  hostedAppProxyResponseHeaders,
} from './proxy-policy';

describe('hosted app preview proxy policy', () => {
  test('constrains browser fetches and disables persistent workers', () => {
    const headers = new Map<string, string>();
    applyHostedAppPreviewSecurityHeaders({
      setHeader(name, value) {
        headers.set(name.toLowerCase(), value);
      },
    });

    expect(headers.get('content-security-policy')).toContain("connect-src 'self'");
    expect(headers.get('content-security-policy')).toContain("worker-src 'none'");
    expect(headers.get('content-security-policy')).toContain("form-action 'self'");
    expect(headers.get('permissions-policy')).toContain('camera=()');
    expect(headers.get('x-dns-prefetch-control')).toBe('off');
    expect(headers.get('cross-origin-opener-policy')).toBe('same-origin');
  });

  test('keeps CodeAPI identity and caller-supplied AWS headers out of the app', () => {
    const headers = hostedAppProxyRequestHeaders({
      authorization: 'Bearer codeapi-secret',
      cookie: 'librechat=session-secret',
      'x-api-key': 'api-secret',
      'x-forwarded-user': 'user-1',
      'x-aws-proxy-auth': 'attacker-token',
      accept: 'text/event-stream',
      'x-app-action': 'move',
    }, {
      headerName: 'X-aws-proxy-auth',
      token: 'worker-minted-token',
      expiresAtMs: Date.now() + 60_000,
    }, 3000, {
      host: 'happ-safe.apps.example.test',
      protocol: 'https',
    });

    expect(Object.fromEntries(headers)).toEqual({
      accept: 'text/event-stream',
      'x-app-action': 'move',
      'x-aws-proxy-auth': 'worker-minted-token',
      'x-aws-proxy-port': '3000',
      'x-forwarded-host': 'happ-safe.apps.example.test',
      'x-forwarded-proto': 'https',
    });
  });

  test('does not let a hosted app set origin cookies, redirects, or security policy', () => {
    const headers = hostedAppProxyResponseHeaders(new Headers({
      'content-type': 'text/html',
      'cache-control': 'no-cache',
      'set-cookie': 'session=owned',
      location: 'https://internal-microvm.example/secret',
      'content-security-policy': "default-src *",
      'access-control-allow-origin': '*',
    }));

    expect(Object.fromEntries(headers)).toEqual({
      'cache-control': 'no-cache',
      'content-type': 'text/html',
    });
  });
});
