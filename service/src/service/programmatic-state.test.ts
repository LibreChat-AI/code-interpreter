import { describe, expect, test } from 'bun:test';
import type { CodeApiAuthContext, RequestFile } from '../types';
import type { LCTool } from '../preamble';
import {
  buildReplayExecutionState,
  resolveReplayStateSandboxBackend,
} from './programmatic-state';

const TOOLS = [
  {
    name: 'lookup_user',
    description: 'Lookup a user',
    parameters: { type: 'object', properties: {} },
  },
] as LCTool[];

const FILES = [
  {
    id: 'file_123',
    resource_id: 'skill_123',
    storage_session_id: 'session_storage',
    name: 'skill/input.txt',
    kind: 'skill',
    version: 7,
  },
] as RequestFile[];

function build(
  overrides: Partial<Parameters<typeof buildReplayExecutionState>[0]> = {},
): ReturnType<typeof buildReplayExecutionState> {
  return buildReplayExecutionState({
    executionId: 'exec_123',
    sessionId: 'session_123',
    sessionKey: 'tenant_a:user:user_canonical',
    userId: 'user_legacy',
    apiKeyId: 'key_legacy',
    code: 'print("hello")',
    tools: TOOLS,
    files: FILES,
    isPyPlot: false,
    timeout: 300000,
    language: 'python',
    now: 1778250000000,
    ...overrides,
  });
}

describe('buildReplayExecutionState', () => {
  test('persists the resolved queue consumer backend for split stateful deployments', () => {
    expect(
      resolveReplayStateSandboxBackend({
        executionProfile: 'stateful',
        executionProfileSource: 'explicit',
        apiSandboxBackend: 'http',
      }),
    ).toBe('lambda-microvm');
  });

  test('pins bridge replay state to the remote bridge backend', () => {
    expect(
      resolveReplayStateSandboxBackend({
        executionProfile: 'stateful',
        executionProfileSource: 'explicit',
        apiSandboxBackend: 'http',
        bridgeWorkerId: 'worker-1',
      }),
    ).toBe('remote-bridge');
  });

  test('persists canonical LibreChat auth context for replay continuations', () => {
    const authContext: CodeApiAuthContext = {
      userId: 'user_canonical',
      tenantId: 'tenant_a',
      orgId: 'org_123',
      serviceId: 'service_123',
      externalUserId: 'chc_user_123',
      principalSource: 'openid_reuse',
      authContextHash: 'hash_123',
    };

    const state = build({
      authContext,
      bridgeWorkerId: 'code-user_123',
      sandboxBackend: 'remote-bridge',
    });

    expect(state).toMatchObject({
      execution_id: 'exec_123',
      session_id: 'session_123',
      sessionKey: 'tenant_a:user:user_canonical',
      userId: 'user_legacy',
      tenantId: 'tenant_a',
      canonicalUserId: 'user_canonical',
      orgId: 'org_123',
      serviceId: 'service_123',
      externalUserId: 'chc_user_123',
      principalSource: 'openid_reuse',
      authContextHash: 'hash_123',
      apiKeyId: 'key_legacy',
      bridgeWorkerId: 'code-user_123',
      sandboxBackend: 'remote-bridge',
      mode: 'replay',
      userCode: 'print("hello")',
      tools: TOOLS,
      files: FILES,
      timeout: 300000,
      callCount: 0,
      language: 'python',
      startTime: 1778250000000,
      lastActivity: 1778250000000,
    });
  });

  test('falls back to JWT identity only when no managed auth context exists', () => {
    const state = build({ authContext: undefined, userId: 'user_api_key' });

    expect(state.tenantId).toBe('legacy');
    expect(state.canonicalUserId).toBe('user_api_key');
    expect(state.principalSource).toBe('librechat_jwt');
    expect(state.authContextHash).toBeUndefined();
  });
});
