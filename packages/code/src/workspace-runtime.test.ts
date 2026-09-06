import assert from 'node:assert/strict';
import test from 'node:test';

import { RuntimeWorkspaceCommandSandbox } from './workspace-runtime.js';
import { WorkspaceToolError } from './workspace.js';

import type { RuntimeSupervisor } from './runtime.js';

const request = {
  protocolVersion: 1 as const,
  operation: 'execute_command' as const,
  workspaceId: 'primary',
  command: 'pwd',
  cwd: 'src',
  timeoutMs: 1234,
  maxOutputBytes: 64,
};

test('executes a command through a stable stateful runtime session', async () => {
  const requests: object[] = [];
  const assignments: object[] = [];
  const supervisor: RuntimeSupervisor = {
    async acquire(assignment) {
      assignments.push(assignment);
      return {
        sessionId: assignment.runtimeSessionId,
        async execute(runtimeRequest) {
          requests.push(runtimeRequest);
          return {
            status: 200,
            body: JSON.stringify({
              exitCode: 0,
              stdout: '/mnt/data/src\n',
              stderr: '',
              truncated: false,
              timedOut: false,
            }),
          };
        },
      };
    },
    async reset() {},
    async quarantine() { throw new Error('must not quarantine'); },
  };
  const sandbox = new RuntimeWorkspaceCommandSandbox({
    runtimeSupervisor: supervisor,
    workerId: 'worker-1',
    incarnationId: 'incarnation-1',
  });

  assert.equal(sandbox.mutationFailuresAreAtomic, true);
  assert.deepEqual(await sandbox.execute(request), {
    protocolVersion: 1,
    operation: 'execute_command',
    workspaceId: 'primary',
    exitCode: 0,
    stdout: '/mnt/data/src\n',
    stderr: '',
    truncated: false,
    timedOut: false,
  });
  const assignment = assignments[0] as { runtimeSessionId?: string };
  assert.match(assignment.runtimeSessionId ?? '', /^workspace-[0-9a-f]{40}$/);
  assert.deepEqual(requests, [{
    path: '/api/v2/workspace/execute',
    body: JSON.stringify({
      command: 'pwd', cwd: 'src', timeoutMs: 1234, maxOutputBytes: 64,
    }),
    headers: {
      'Content-Type': 'application/json',
      'X-Runtime-Session-Id': assignment.runtimeSessionId,
    },
    signal: undefined,
  }]);
});

test('quarantines the runtime and hides malformed sandbox responses', async () => {
  const quarantined: string[] = [];
  const supervisor: RuntimeSupervisor = {
    async acquire(assignment) {
      return {
        sessionId: assignment.runtimeSessionId,
        async execute() {
          return { status: 200, body: '{"stdout":"host secret"}' };
        },
      };
    },
    async reset() {},
    async quarantine(sessionId) { quarantined.push(sessionId); },
  };
  const sandbox = new RuntimeWorkspaceCommandSandbox({
    runtimeSupervisor: supervisor,
    workerId: 'worker-1',
    incarnationId: 'incarnation-1',
  });

  await assert.rejects(
    sandbox.execute(request),
    (error: unknown) =>
      error instanceof WorkspaceToolError &&
      error.code === 'COMMAND_UNAVAILABLE' &&
      error.mutationMayHaveCommitted === true &&
      !error.message.includes('host secret'),
  );
  assert.equal(quarantined.length, 1);
});

test('keeps definite pre-execution request rejections clean', async () => {
  let quarantined = false;
  const supervisor: RuntimeSupervisor = {
    async acquire(assignment) {
      return {
        sessionId: assignment.runtimeSessionId,
        async execute() {
          return { status: 400, body: '{"message":"Command working directory is unavailable"}' };
        },
      };
    },
    async reset() {},
    async quarantine() { quarantined = true; },
  };
  const sandbox = new RuntimeWorkspaceCommandSandbox({
    runtimeSupervisor: supervisor,
    workerId: 'worker-1',
    incarnationId: 'incarnation-1',
  });

  await assert.rejects(
    sandbox.execute(request),
    (error: unknown) =>
      error instanceof WorkspaceToolError &&
      error.code === 'INVALID_REQUEST' &&
      error.mutationMayHaveCommitted === false &&
      !error.message.includes('working directory'),
  );
  assert.equal(quarantined, false);
});

test('refuses a runtime lease that is not bound to the requested workspace', async () => {
  let quarantined = false;
  const supervisor: RuntimeSupervisor = {
    async acquire() { return { sessionId: 'wrong', async execute() { throw new Error(); } }; },
    async reset() {},
    async quarantine() { quarantined = true; },
  };
  const sandbox = new RuntimeWorkspaceCommandSandbox({
    runtimeSupervisor: supervisor,
    workerId: 'worker-1',
    incarnationId: 'incarnation-1',
  });
  await assert.rejects(sandbox.execute(request), /unavailable/i);
  assert.equal(quarantined, true);
});
