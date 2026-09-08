import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { WorkspaceToolError } from './workspace.js';
import { isWorkspaceToolRequest, isWorkspaceToolResult } from './protocol.js';
import type { ChildProcess, ForkOptions } from 'node:child_process';
import type { NativeSrtWorkspaceCommandSandboxOptions } from './native-sandbox.js';
import type { WorkspaceCommandSandbox } from './workspace.js';
import type {
  WorkspaceExecuteCommandRequest,
  WorkspaceExecuteCommandResult,
} from './protocol.js';

export type NativeProcessSandboxOptions = Omit<
  NativeSrtWorkspaceCommandSandboxOptions,
  'manager' | 'spawnCommand' | 'platform'
>;

/** Only operating-system discovery variables cross into the trusted executor.
 * In particular, never inherit NODE_OPTIONS, bridge identity, or app secrets. */
export function nativeExecutorEnvironment(
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const allowed = new Set([
    'PATH',
    'HOME',
    'USERPROFILE',
    'SYSTEMROOT',
    'WINDIR',
    'COMSPEC',
    'TEMP',
    'TMP',
    'TMPDIR',
    'LOCALAPPDATA',
    'APPDATA',
    'PROGRAMDATA',
    'PROGRAMFILES',
    'PROGRAMFILES(X86)',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
  ]);
  return Object.fromEntries(
    Object.entries(source).filter(
      ([name, value]) => value != null && allowed.has(name.toUpperCase()),
    ),
  );
}

/** One persistent, process-isolated SRT manager per workspace. No automatic
 * restart/replay: losing IPC after execution starts is an ambiguous mutation. */
export class NativeProcessWorkspaceCommandSandbox
  implements WorkspaceCommandSandbox
{
  readonly mutationFailuresAreAtomic = true as const;
  private child?: ChildProcess;
  private ready?: Promise<void>;
  private active?: Promise<WorkspaceExecuteCommandResult>;
  private closing?: Promise<void>;
  private failed = false;
  private pending?: {
    id: string;
    resolve(value: unknown): void;
    reject(error: Error): void;
    mutation: boolean;
  };

  constructor(
    private readonly options: NativeProcessSandboxOptions,
    private readonly forkExecutor: (
      path: URL,
      args: string[],
      options: ForkOptions,
    ) => ChildProcess = fork,
  ) {}

  async prepare(): Promise<void> {
    if (this.failed || this.closing) throw this.unavailable(false);
    if (this.ready) return this.ready;
    this.ready = this.start();
    return this.ready;
  }

  private unavailable(mutation: boolean): WorkspaceToolError {
    return new WorkspaceToolError(
      'Native executor is unavailable',
      'COMMAND_UNAVAILABLE',
      mutation,
    );
  }

  private async start(): Promise<void> {
    const child = this.forkExecutor(
      new URL('./native-process-child.js', import.meta.url),
      [],
      {
        execArgv: [],
        env: nativeExecutorEnvironment(this.options.environment ?? process.env),
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        serialization: 'json',
      },
    );
    this.child = child;
    child.on('message', (raw: unknown) => {
      const message = raw as {
        id?: unknown;
        ok?: unknown;
        result?: unknown;
        mutation?: unknown;
        code?: unknown;
      };
      if (
        !message ||
        typeof message !== 'object' ||
        message.id !== this.pending?.id
      )
        return;
      const pending = this.pending;
      if (!pending) return;
      if (message.ok === true) pending.resolve(message.result);
      else {
        const code =
          message.code === 'INVALID_PATH' ||
          message.code === 'INVALID_REQUEST' ||
          message.code === 'EXECUTION_ABORTED' ||
          message.code === 'REGISTRATION_INVALID'
            ? message.code
            : 'COMMAND_UNAVAILABLE';
        pending.reject(
          new WorkspaceToolError(
            'Native executor request failed',
            code,
            pending.mutation && message.mutation !== false,
          ),
        );
      }
    });
    const lost = () => {
      this.failed = true;
      this.pending?.reject(this.unavailable(this.pending.mutation));
    };
    child.on('error', lost);
    child.on('exit', lost);
    child.on('disconnect', lost);
    const {
      workspaceRoot,
      protectedPaths,
      allowedDomains,
      homeDirectory,
      shellPath,
    } = this.options;
    await this.rpc(
      'prepare',
      {
        options: {
          workspaceRoot,
          protectedPaths,
          allowedDomains,
          homeDirectory,
          shellPath,
          variables: this.options.maskedEnvironment?.variables,
        },
      },
      30_000,
      false,
    );
  }

  async execute(
    request: WorkspaceExecuteCommandRequest,
    signal?: AbortSignal,
  ): Promise<WorkspaceExecuteCommandResult> {
    if (
      !isWorkspaceToolRequest(request) ||
      request.operation !== 'execute_command'
    ) {
      throw new WorkspaceToolError('Invalid native command', 'INVALID_REQUEST');
    }
    if (this.active || this.closing || this.failed)
      throw this.unavailable(false);
    const active = this.executeOnce(request, signal);
    this.active = active;
    try {
      return await active;
    } finally {
      this.active = undefined;
    }
  }

  private async executeOnce(
    request: WorkspaceExecuteCommandRequest,
    signal?: AbortSignal,
  ): Promise<WorkspaceExecuteCommandResult> {
    if (signal?.aborted)
      throw new WorkspaceToolError('Command aborted', 'EXECUTION_ABORTED');
    await this.prepare();
    const credentials = await this.options.maskedEnvironment?.resolve(signal);
    if (signal?.aborted)
      throw new WorkspaceToolError('Command aborted', 'EXECUTION_ABORTED');
    const wrappedCommand = this.options.maskedEnvironment?.wrapCommand?.(
      request.command,
      process.platform,
    );
    const result = await this.rpc(
      'execute',
      { request, credentials, wrappedCommand },
      (request.timeoutMs ?? 30_000) + 5_000,
      true,
      signal,
    );
    if (!isWorkspaceToolResult(request, result)) {
      this.failed = true;
      this.child?.kill();
      throw this.unavailable(true);
    }
    return result as WorkspaceExecuteCommandResult;
  }

  private async rpc(
    type: string,
    payload: object,
    timeoutMs: number,
    mutation: boolean,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (this.pending || !this.child?.connected || this.failed)
      throw this.unavailable(false);
    const id = randomUUID();
    const child = this.child;
    let timer: ReturnType<typeof setTimeout>;
    const abort = () => {
      if (child.connected) child.send({ type: 'cancel', id }, () => undefined);
    };
    try {
      return await new Promise((resolve, reject) => {
        this.pending = { id, resolve, reject, mutation };
        timer = setTimeout(() => {
          this.failed = true;
          child.kill();
          reject(this.unavailable(mutation));
        }, timeoutMs);
        signal?.addEventListener('abort', abort, { once: true });
        child.send({ type, id, ...payload }, (error) => {
          if (error) {
            this.failed = true;
            reject(this.unavailable(mutation));
          }
        });
        if (signal?.aborted) abort();
      });
    } finally {
      clearTimeout(timer!);
      signal?.removeEventListener('abort', abort);
      this.pending = undefined;
    }
  }

  async close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = this.stop();
    return this.closing;
  }

  private async stop(): Promise<void> {
    await this.active?.catch(() => undefined);
    await this.ready?.catch(() => undefined);
    try {
      if (this.child?.connected && !this.failed)
        await this.rpc('close', {}, 10_000, false);
    } finally {
      this.failed = true;
      this.child?.kill();
    }
  }
}
