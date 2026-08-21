import { describe, expect, test } from 'bun:test';
import {
  hostedAppProxyRequestHeaders,
  hostedAppProxyResponseHeaders,
} from './proxy-policy';

describe('hosted app preview proxy policy', () => {
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
    }, 3000);

    expect(Object.fromEntries(headers)).toEqual({
      accept: 'text/event-stream',
      'x-app-action': 'move',
      'x-aws-proxy-auth': 'worker-minted-token',
      'x-aws-proxy-port': '3000',
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
