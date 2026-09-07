import { describe, expect, test } from 'bun:test';
import type { Request, Response } from 'express';
import { httpMetricPath } from './httpMetrics';

describe('HTTP metric path overrides', () => {
  test('collapses arbitrary hosted-app routes to one bounded label', () => {
    const req = { path: '/generated/assets/nonce-123.js' } as Request;
    const res = {
      locals: { codeapiMetricPath: '/hosted-app-preview/*' },
    } as unknown as Response;

    expect(httpMetricPath(req, res)).toBe('/hosted-app-preview/*');
    expect(httpMetricPath(req, { locals: {} } as unknown as Response)).toBe(req.path);
  });
});
