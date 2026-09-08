import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type { ChildProcess, ForkOptions } from 'node:child_process';
import {
  NativeProcessWorkspaceCommandSandbox,
  nativeExecutorEnvironment,
} from './native-process.js';
import { WorkspaceToolError } from './workspace.js';

const request = {
  protocolVersion: 1 as const,
  operation: 'execute_command' as const,
  workspaceId: 'primary',
  command: 'printf ok',
  timeoutMs: 1000,
  maxOutputBytes: 64,
};
const result = {
  protocolVersion: 1,
  operation: 'execute_command',
  workspaceId: 'primary',
  stdout: 'ok',
  stderr: '',
  exitCode: 0,
  truncated: false,
  timedOut: false,
};

function fixture(
  execute?: (child: EventEmitter, message: Record<string, any>) => void,
  prepare?: (child: EventEmitter, message: Record<string, any>) => void,
) {
  const child = new EventEmitter() as ChildProcess;
  let options: ForkOptions | undefined;
  const messages: Record<string, any>[] = [];
  Object.assign(child, {
    connected: true,
    send(message: Record<string, any>, callback: (error: null) => void) {
      messages.push(message);
      callback(null);
      queueMicrotask(() => {
        if (message.type === 'prepare' && prepare)
          return prepare(child, message);
        if (message.type === 'execute' && execute)
          return execute(child, message);
        if (message.type === 'cancel') return;
        child.emit('message', {
          id: message.id,
          ok: true,
          ...(message.type === 'execute' ? { result } : {}),
        });
      });
      return true;
    },
    kill() {
      child.emit('exit', 1);
      return true;
    },
  });
  return {
    child,
    messages,
    get options() {
      return options;
    },
    fork(_path: URL, args: string[], value: ForkOptions) {
      assert.deepEqual(args, []);
      options = value;
      return child;
    },
  };
}

test('executor bootstrap excludes bridge credentials and Node injection variables', async () => {
  assert.deepEqual(
    nativeExecutorEnvironment({
      PATH: '/bin',
      HOME: '/home/user',
      NODE_OPTIONS: '--require bad.js',
      LIBRECHAT_CODE_WORKER_TOKEN: 'secret',
      GITHUB_TOKEN: 'secret',
      AWS_SECRET_ACCESS_KEY: 'secret',
    }),
    { PATH: '/bin', HOME: '/home/user' },
  );
  const fake = fixture();
  const sandbox = new NativeProcessWorkspaceCommandSandbox(
    {
      workspaceRoot: '/workspace',
      environment: {
        PATH: '/bin',
        NODE_OPTIONS: 'secret',
        LIBRECHAT_CODE_WORKER_TOKEN: 'secret',
      },
    },
    fake.fork,
  );
  await sandbox.prepare();
  assert.deepEqual(fake.options?.execArgv, []);
  assert.deepEqual(fake.options?.env, { PATH: '/bin' });
  assert.equal(JSON.stringify(fake.messages).includes('secret'), false);
  await sandbox.close();
});

test('executor hands credentials over IPC only for the current command', async () => {
  const fake = fixture();
  const sandbox = new NativeProcessWorkspaceCommandSandbox(
    {
      workspaceRoot: '/workspace',
      maskedEnvironment: {
        variables: [{ name: 'TOKEN', injectHosts: ['github.com'] }],
        async resolve() {
          return { TOKEN: 'per-command-secret' };
        },
        wrapCommand(command) {
          return `wrapped ${command}`;
        },
      },
    },
    fake.fork,
  );
  assert.deepEqual(await sandbox.execute(request), result);
  assert.equal(
    JSON.stringify(fake.options).includes('per-command-secret'),
    false,
  );
  assert.equal(
    JSON.stringify(fake.messages[0]).includes('per-command-secret'),
    false,
  );
  assert.deepEqual(fake.messages[1].credentials, {
    TOKEN: 'per-command-secret',
  });
  assert.equal(fake.messages[1].wrappedCommand, 'wrapped printf ok');
  await sandbox.close();
});

test('executor loss after dispatch is an uncertain mutation and is never replayed', async () => {
  const fake = fixture((child) => child.emit('exit', 1));
  const sandbox = new NativeProcessWorkspaceCommandSandbox(
    { workspaceRoot: '/workspace' },
    fake.fork,
  );
  await assert.rejects(
    sandbox.execute(request),
    (error: unknown) =>
      error instanceof WorkspaceToolError && error.mutationMayHaveCommitted,
  );
  await assert.rejects(sandbox.execute(request), /unavailable/);
  assert.equal(fake.messages.filter((m) => m.type === 'execute').length, 1);
  await sandbox.close();
});

test('executor cancellation targets the active request and preserves mutation certainty', async () => {
  let dispatched!: () => void;
  const dispatch = new Promise<void>((resolve) => {
    dispatched = resolve;
  });
  const fake = fixture(() => dispatched());
  const sandbox = new NativeProcessWorkspaceCommandSandbox(
    { workspaceRoot: '/workspace' },
    fake.fork,
  );
  const controller = new AbortController();
  const execution = sandbox.execute(request, controller.signal);
  await dispatch;
  await assert.rejects(sandbox.execute(request), /unavailable/);
  controller.abort();
  const command = fake.messages.find((m) => m.type === 'execute')!;
  assert.deepEqual(fake.messages.at(-1), { type: 'cancel', id: command.id });
  fake.child.emit('message', {
    id: command.id,
    ok: false,
    code: 'EXECUTION_ABORTED',
    mutation: true,
  });
  await assert.rejects(
    execution,
    (error: unknown) =>
      error instanceof WorkspaceToolError &&
      error.code === 'EXECUTION_ABORTED' &&
      error.mutationMayHaveCommitted,
  );
  await sandbox.close();
});

test('executor rejects mismatched results as uncertain and fences subsequent commands', async () => {
  const fake = fixture((child, message) =>
    child.emit('message', {
      id: message.id,
      ok: true,
      result: { ...result, workspaceId: 'another-workspace' },
    }),
  );
  const sandbox = new NativeProcessWorkspaceCommandSandbox(
    { workspaceRoot: '/workspace' },
    fake.fork,
  );
  await assert.rejects(
    sandbox.execute(request),
    (error: unknown) =>
      error instanceof WorkspaceToolError && error.mutationMayHaveCommitted,
  );
  await assert.rejects(sandbox.execute(request), /unavailable/);
  await sandbox.close();
});

test('executor close drains an active command before closing IPC', async () => {
  let dispatched!: () => void;
  const dispatch = new Promise<void>((resolve) => {
    dispatched = resolve;
  });
  const fake = fixture(() => dispatched());
  const sandbox = new NativeProcessWorkspaceCommandSandbox(
    { workspaceRoot: '/workspace' },
    fake.fork,
  );
  const execution = sandbox.execute(request);
  await dispatch;
  const closing = sandbox.close();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(
    fake.messages.some((m) => m.type === 'close'),
    false,
  );
  const command = fake.messages.find((m) => m.type === 'execute')!;
  fake.child.emit('message', { id: command.id, ok: true, result });
  assert.deepEqual(await execution, result);
  await closing;
  assert.equal(fake.messages.filter((m) => m.type === 'close').length, 1);
  await assert.rejects(sandbox.execute(request), /unavailable/);
});

test('executor startup loss is not reported as an applied mutation', async () => {
  const fake = fixture();
  const sandbox = new NativeProcessWorkspaceCommandSandbox(
    { workspaceRoot: '/workspace' },
    (path, args, options) => {
      const child = fake.fork(path, args, options);
      queueMicrotask(() => child.emit('error', new Error('startup failed')));
      return child;
    },
  );
  await assert.rejects(
    sandbox.execute(request),
    (error: unknown) =>
      error instanceof WorkspaceToolError && !error.mutationMayHaveCommitted,
  );
  assert.equal(
    fake.messages.some((m) => m.type === 'execute'),
    false,
  );
  await sandbox.close();
});

test('executor shutdown receipt fences reuse before the OS exit event', async () => {
  const fake = fixture((child, message) =>
    child.emit('message', {
      id: message.id,
      ok: false,
      fatal: true,
      mutation: true,
      code: 'EXECUTION_ABORTED',
    }),
  );
  const sandbox = new NativeProcessWorkspaceCommandSandbox(
    { workspaceRoot: '/workspace' },
    fake.fork,
  );
  await assert.rejects(sandbox.execute(request));
  await assert.rejects(sandbox.execute(request), /unavailable/);
  assert.equal(fake.messages.filter((m) => m.type === 'execute').length, 1);
  await sandbox.close();
});

test('executor preserves bounded startup diagnostics and conventional host settings', async () => {
  assert.deepEqual(
    nativeExecutorEnvironment(
      {
        HTTPS_PROXY: 'http://proxy:8080',
        PATHEXT: '.EXE',
        NODE_OPTIONS: 'unsafe',
      },
      'win32',
    ),
    { HTTPS_PROXY: 'http://proxy:8080', PATHEXT: '.EXE' },
  );
  const fake = fixture(undefined, (child, message) =>
    child.emit('message', {
      id: message.id,
      ok: false,
      mutation: false,
      code: 'COMMAND_UNAVAILABLE',
      errorMessage: 'Native sandbox dependencies are unavailable: bubblewrap',
    }),
  );
  const sandbox = new NativeProcessWorkspaceCommandSandbox(
    { workspaceRoot: '/workspace' },
    fake.fork,
  );
  await assert.rejects(
    sandbox.prepare(),
    /dependencies are unavailable: bubblewrap/,
  );
  await sandbox.close();
});

test('executor matches POSIX names exactly and folds names only on Windows', () => {
  const env = {
    PATH: '/bin',
    Path: 'private',
    home: 'private',
    Temp: 'private',
    PATHEXT: 'private',
    https_proxy: 'http://proxy:8080',
    custom_PROXY: 'private',
  };
  assert.deepEqual(nativeExecutorEnvironment(env, 'linux'), {
    PATH: '/bin',
    https_proxy: 'http://proxy:8080',
  });
  assert.deepEqual(
    nativeExecutorEnvironment({ Path: 'C:\\bin', Temp: 'C:\\temp' }, 'win32'),
    { Path: 'C:\\bin', Temp: 'C:\\temp' },
  );
});

test('executor classifies every pre-dispatch setup failure as mutation-atomic', async () => {
  for (const failure of ['fork', 'credential', 'wrapper', 'abort'] as const) {
    const fake = fixture();
    const controller = new AbortController();
    const sandbox = new NativeProcessWorkspaceCommandSandbox(
      {
        workspaceRoot: '/workspace',
        maskedEnvironment: {
          variables: [],
          async resolve() {
            if (failure === 'abort') controller.abort();
            if (failure === 'credential' || failure === 'abort')
              throw new Error('private provider error');
            return {};
          },
          wrapCommand(command) {
            if (failure === 'wrapper') throw new Error('wrapper failed');
            return command;
          },
        },
      },
      failure === 'fork'
        ? () => {
            throw new Error('fork failed');
          }
        : fake.fork,
    );
    await assert.rejects(
      sandbox.execute(request, controller.signal),
      (error: unknown) =>
        error instanceof WorkspaceToolError &&
        !error.mutationMayHaveCommitted &&
        error.code ===
          (failure === 'abort' ? 'EXECUTION_ABORTED' : 'COMMAND_UNAVAILABLE'),
    );
    assert.equal(
      fake.messages.some((m) => m.type === 'execute'),
      false,
    );
    await sandbox.close();
  }
});
