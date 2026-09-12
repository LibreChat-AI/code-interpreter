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

/** Only OS discovery and conventional proxy settings cross into the executor.
 * In particular, never inherit NODE_OPTIONS, bridge identity, or app secrets. */
export function nativeExecutorEnvironment(
  source: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const allowed = new Set([
    'PATH',
    'HOME',
    'TMPDIR',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'LOGNAME',
    'USER',
    'SHELL',
    'TERM',
    'COLORTERM',
    'NO_COLOR',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'all_proxy',
    'no_proxy',
  ]);
  if (platform === 'win32') {
    for (const name of [
      'USERPROFILE',
      'SYSTEMROOT',
      'WINDIR',
      'COMSPEC',
      'TEMP',
      'TMP',
      'LOCALAPPDATA',
      'APPDATA',
      'PROGRAMDATA',
      'PROGRAMFILES',
      'PROGRAMFILES(X86)',
      'SYSTEMDRIVE',
      'PATHEXT',
      'HOMEDRIVE',
      'HOMEPATH',
    ]) {
      allowed.add(name);
    }
  }
  return Object.fromEntries(
    Object.entries(source).filter(
      ([name, value]) =>
        value != null &&
        allowed.has(platform === 'win32' ? name.toUpperCase() : name),
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
  private terminationTimer?: ReturnType<typeof setTimeout>;
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
        requiresQuarantine?: unknown;
        code?: unknown;
        errorMessage?: unknown;
        fatal?: unknown;
      };
      if (
        !message ||
        typeof message !== 'object' ||
        message.id !== this.pending?.id
      )
        return;
      const pending = this.pending;
      if (!pending) return;
      if (message.fatal === true) this.failed = true;
      if (message.ok === true) pending.resolve(message.result);
      else {
        const code =
          message.code === 'INVALID_PATH' ||
          message.code === 'INVALID_REQUEST' ||
          message.code === 'EXECUTION_ABORTED' ||
          message.code === 'REGISTRATION_INVALID'
            ? message.code
            : 'COMMAND_UNAVAILABLE';
        const processTerminationConfirmed =
          code === 'EXECUTION_ABORTED' &&
          message.requiresQuarantine === false;
        pending.reject(
          new WorkspaceToolError(
            typeof message.errorMessage === 'string' &&
            message.errorMessage.length <= 1024
              ? message.errorMessage
              : 'Native executor request failed',
            code,
            pending.mutation && message.mutation !== false,
            pending.mutation && !processTerminationConfirmed,
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
      commandPolicy,
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
          commandPolicy,
          protectedPaths,
          allowedDomains,
          homeDirectory,
          shellPath,
          variables: this.options.maskedEnvironment?.variables,
        },
      },
      30_000,
      false,
    ).catch((error) => {
      this.failed = true;
      this.terminate();
      throw error;
    });
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
    let credentials: Record<string, string> | undefined;
    let wrappedCommand: string | undefined;
    try {
      await this.prepare();
      if (signal?.aborted) throw new Error('aborted');
      credentials = await this.options.maskedEnvironment?.resolve(signal);
      if (signal?.aborted) throw new Error('aborted');
      wrappedCommand = this.options.maskedEnvironment?.wrapCommand?.(
        request.command,
        process.platform,
      );
      if (signal?.aborted) throw new Error('aborted');
    } catch (error) {
      // No execute RPC has been sent: setup, token refresh and wrapping cannot
      // have mutated the workspace. Do not quarantine it for setup failures.
      if (signal?.aborted)
        throw new WorkspaceToolError('Command aborted', 'EXECUTION_ABORTED');
      throw error instanceof WorkspaceToolError
        ? new WorkspaceToolError(error.message, error.code, false)
        : new WorkspaceToolError(
            'Native executor setup failed before dispatch',
            'COMMAND_UNAVAILABLE',
          );
    }
    const result = await this.rpc(
      'execute',
      { request, credentials, wrappedCommand },
      (request.timeoutMs ?? 30_000) + 5_000,
      true,
      signal,
    );
    if (signal?.aborted) {
      throw new WorkspaceToolError(
        'Command aborted',
        'EXECUTION_ABORTED',
        true,
      );
    }
    if (!isWorkspaceToolResult(request, result)) {
      this.failed = true;
      this.terminate();
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
      try {
        if (child.connected)
          child.send({ type: 'cancel', id }, () => undefined);
      } catch {
        this.failed = true;
        this.terminate();
      }
    };
    try {
      return await new Promise((resolve, reject) => {
        this.pending = { id, resolve, reject, mutation };
        timer = setTimeout(() => {
          this.failed = true;
          this.terminate();
          reject(this.unavailable(mutation));
        }, timeoutMs);
        signal?.addEventListener('abort', abort, { once: true });
        const sendFailed = () => {
          this.failed = true;
          this.terminate();
          reject(this.unavailable(mutation));
        };
        try {
          child.send({ type, id, ...payload }, (error) => {
            if (error) sendFailed();
          });
        } catch {
          sendFailed();
        }
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
      this.terminate();
    }
  }

  private terminate(): void {
    const child = this.child;
    if (!child || this.terminationTimer) return;
    // Give SRT time to abort/reap its command, then bound executor shutdown.
    this.terminationTimer = setTimeout(() => child.kill('SIGKILL'), 6000);
    this.terminationTimer.unref();
    child.once('exit', () => clearTimeout(this.terminationTimer));
    child.kill('SIGTERM');
  }
}
