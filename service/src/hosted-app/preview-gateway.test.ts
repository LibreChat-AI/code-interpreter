import { describe, expect, test } from 'bun:test';
import type { Response } from 'express';
import { sendHostedAppPreviewAuthorizationHandoff } from './preview-gateway';

describe('hosted app preview authorization handoff', () => {
  test('ends the cross-site redirect chain before starting a same-origin navigation', () => {
    const headers = new Map<string, string>();
    let status: number | undefined;
    let type: string | undefined;
    let body: string | undefined;
    let redirects = 0;
    const response = {
      setHeader(name: string, value: string) {
        headers.set(name.toLowerCase(), value);
        return this;
      },
      status(value: number) {
        status = value;
        return this;
      },
      type(value: string) {
        type = value;
        return this;
      },
      send(value: string) {
        body = value;
        return this;
      },
      redirect() {
        redirects += 1;
        return this;
      },
    } as unknown as Response;

    sendHostedAppPreviewAuthorizationHandoff(response, 'signed.token/value', 300);

    expect(status).toBe(200);
    expect(type).toBe('html');
    expect(redirects).toBe(0);
    expect(headers.get('cache-control')).toBe('no-store');
    expect(headers.has('location')).toBe(false);
    expect(headers.get('set-cookie')).toBe(
      '__Host-codeapi-app=signed.token%2Fvalue; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=300',
    );
    expect(body).toContain('<script>location.replace("/")</script>');
    expect(body).toContain('<meta http-equiv="refresh" content="0;url=/">');
    expect(body).not.toContain('__codeapi/authorize');
    expect(body).not.toContain('token');
  });
});
