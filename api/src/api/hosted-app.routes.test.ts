import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import express from 'express';
import type { Server } from 'node:http';
import { config } from '../config';
import { resetSessionWorkspaceStateForTests } from '../session-workspace';
import v2Router from './v2';

let server: Server;
let baseUrl: string;
const savedHostedAppsEnabled = config.hosted_apps_enabled;
const savedSessionWorkspaceEnabled = config.session_workspace_enabled;

beforeAll(async () => {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use('/api/v2', v2Router);
  await new Promise<void>(resolve => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

afterEach(() => {
  config.hosted_apps_enabled = false;
  config.session_workspace_enabled = false;
  resetSessionWorkspaceStateForTests();
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  config.hosted_apps_enabled = savedHostedAppsEnabled;
  config.session_workspace_enabled = savedSessionWorkspaceEnabled;
  resetSessionWorkspaceStateForTests();
});

const post = (path: string, body: unknown = {}) => fetch(`${baseUrl}/api/v2${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

describe('hosted-app route isolation', () => {
  test('ordinary runner images do not expose hosted-app controls', async () => {
    config.hosted_apps_enabled = false;
    config.session_workspace_enabled = true;

    const response = await post('/hosted-app/start');

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ message: 'Not Found' });
  });

  test('dedicated app hosts require the authenticated runtime-session binding', async () => {
    config.hosted_apps_enabled = true;
    config.session_workspace_enabled = true;

    const response = await post('/hosted-app/start');

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ message: 'Missing runtime session header' });
  });

  test('dedicated app hosts refuse ordinary execution requests', async () => {
    config.hosted_apps_enabled = true;
    config.session_workspace_enabled = true;

    const response = await post('/execute', {});

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ message: 'Not Found' });
  });

  test('status is session-bound and reports absence without starting a process', async () => {
    config.hosted_apps_enabled = true;
    config.session_workspace_enabled = true;

    const response = await fetch(`${baseUrl}/api/v2/hosted-app/status`, {
      headers: { 'X-Runtime-Session-Id': 'rt_hosted_demo' },
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: 'hosted_app_not_running',
      message: 'No hosted app has been started',
    });
  });
});
