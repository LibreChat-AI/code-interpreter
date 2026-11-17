import { NativeProcessWorkspaceCommandSandbox } from './native-process.js';
import { WorkspaceToolError } from './workspace.js';
import { commandFailureDiagnostic } from './command-diagnostics.js';
import type { NativeProcessSandboxOptions } from './native-process.js';
import type {
  BridgeWorkspaceProgrammaticRequest,
  WorkspaceExecuteCommandRequest,
  WorkspaceExecuteCommandResult,
} from './protocol.js';

interface Entry {
  sandbox: Pick<
    NativeProcessWorkspaceCommandSandbox,
    'prepare' | 'execute' | 'close'
  > &
    Partial<Pick<NativeProcessWorkspaceCommandSandbox, 'executeProgrammatic'>>;
  busy: boolean;
  /** Set on a dedicated executor: the root whose detached command it runs. */
  root?: string;
}

/** Dedicated executors are keyed apart from every root, whose IDs never contain NUL. */
const DETACHED_EXECUTOR_KEY_PREFIX = '\0detached\0';

/**
 * Whether this worker offers detached commands. On by default wherever it holds:
 * a native executor pool with more than one lease slot, so a dedicated executor
 * can run beside its root's own. `--no-detached-commands` or
 * `LIBRECHAT_CODE_DETACHED_COMMANDS=false` opts out; any other value of that
 * variable fails startup rather than silently choosing either way.
 */
export function detachedCommandsEnabled(input: {
  optOut: boolean;
  enabled?: string;
  pooled: boolean;
  workspaceLeaseSlots: number;
}): boolean {
  const enabled = input.enabled?.trim().toLowerCase() ?? '';
  if (enabled !== '' && enabled !== 'true' && enabled !== 'false') {
    throw new Error('LIBRECHAT_CODE_DETACHED_COMMANDS must be true or false');
  }
  return (
    !input.optOut &&
    enabled !== 'false' &&
    input.pooled &&
    input.workspaceLeaseSlots > 1
  );
}

/** Bounded persistent executor cache. Each child owns one root's SRT policy;
 * only idle children may be evicted, and ambiguous failures are never retried.
 * A detached command runs in a dedicated executor for its root, created for the
 * command and closed after it, so the root's own executor stays free for other work.
 */
export class NativeWorkspaceCommandPool {
  readonly mutationFailuresAreAtomic = true as const;
  private readonly entries = new Map<string, Entry>();
  private allocation: Promise<unknown> = Promise.resolve();
  private closing = false;
  private detachedSequence = 0;
  constructor(
    roots: ReadonlyMap<string, NativeProcessSandboxOptions>,
    private readonly capacity: number,
    private readonly createSandbox: (
      options: NativeProcessSandboxOptions
    ) => Entry['sandbox'] = (options) =>
      new NativeProcessWorkspaceCommandSandbox(options)
  ) {
    if (
      !Number.isSafeInteger(capacity) ||
      capacity < 1 ||
      capacity > 8 ||
      roots.size === 0
    ) {
      throw new Error('Native executor capacity must be between 1 and 8');
    }
    this.roots = new Map(roots);
  }

  private readonly roots: Map<string, NativeProcessSandboxOptions>;

  /** Confirm executor cleanup before a failed provisioning attempt removes its root. */
  async unregisterRoot(id: string): Promise<void> {
    const pending = this.allocation.then(async () => {
      const owned = this.executors(id);
      if (owned.some(([, entry]) => entry.busy)) {
        throw new WorkspaceToolError(
          'Native workspace still executing',
          'COMMAND_UNAVAILABLE'
        );
      }
      await this.closeExecutors(owned);
      this.roots.delete(id);
    });
    this.allocation = pending.catch(() => undefined);
    await pending;
  }

  /** Add or safely replace a worker-owned isolated root. */
  async registerRoot(
    id: string,
    options: NativeProcessSandboxOptions
  ): Promise<void> {
    const pending = this.allocation.then(async () => {
      if (this.closing) {
        throw new WorkspaceToolError(
          'Native workspace unavailable',
          'REGISTRATION_INVALID'
        );
      }
      const existing = this.roots.get(id);
      if (!existing) {
        this.roots.set(id, options);
        return;
      }
      if (existing.workspaceRoot !== options.workspaceRoot) {
        throw new WorkspaceToolError(
          'Native workspace identity changed',
          'REGISTRATION_INVALID'
        );
      }
      if (
        existing.workspaceIdentity?.dev === options.workspaceIdentity?.dev &&
        existing.workspaceIdentity?.ino === options.workspaceIdentity?.ino &&
        existing.workspaceIdentity?.path === options.workspaceIdentity?.path
      ) {
        return;
      }
      const owned = this.executors(id);
      if (owned.some(([, entry]) => entry.busy)) {
        throw new WorkspaceToolError(
          'Native workspace changed during execution',
          'REGISTRATION_INVALID'
        );
      }
      await this.closeExecutors(owned);
      this.roots.set(id, options);
    });
    this.allocation = pending.catch(() => undefined);
    await pending;
  }

  /** A root's own executor and any dedicated executor still open for it. */
  private executors(root: string): [string, Entry][] {
    return [...this.entries].filter(
      ([key, entry]) => key === root || entry.root === root
    );
  }

  private async closeExecutors(owned: [string, Entry][]): Promise<void> {
    for (const [key, entry] of owned) {
      await entry.sandbox.close();
      this.entries.delete(key);
    }
  }

  /** `key` defaults to the root's own executor; any other key names a dedicated one. */
  private allocate(root: string, key = root): Promise<Entry> {
    const pending = this.allocation.then(async () => {
      const options = this.roots.get(root);
      if (this.closing || !options)
        throw new WorkspaceToolError(
          'Native workspace unavailable',
          'REGISTRATION_INVALID'
        );
      let entry = this.entries.get(key);
      if (entry?.busy)
        throw new WorkspaceToolError(
          'Native workspace already executing',
          'COMMAND_UNAVAILABLE', false, false,
          commandFailureDiagnostic('allocation', 'workspace_busy'),
        );
      if (!entry) {
        if (this.entries.size >= this.capacity) {
          const idle = [...this.entries].find(
            ([, candidate]) => !candidate.busy
          );
          if (!idle)
            throw new WorkspaceToolError(
              'Native executor capacity reached',
              'COMMAND_UNAVAILABLE', false, false,
              commandFailureDiagnostic('allocation', 'capacity_exhausted'),
            );
          try {
            await idle[1].sandbox.close();
          } catch (error) {
            const diagnostic = commandFailureDiagnostic('cleanup', 'cleanup_failed', error);
            throw error instanceof WorkspaceToolError
              ? new WorkspaceToolError(error.message, error.code, error.mutationMayHaveCommitted,
                  error.requiresQuarantine, error.commandDiagnostic ?? diagnostic)
              : new WorkspaceToolError('Native executor allocation failed', 'COMMAND_UNAVAILABLE', false, false, diagnostic);
          }
          this.entries.delete(idle[0]);
        }
        entry = {
          sandbox: this.createSandbox(options),
          busy: false,
          ...(key === root ? {} : { root }),
        };
      }
      entry.busy = true;
      // Map insertion order is the idle eviction order.
      this.entries.delete(key);
      this.entries.set(key, entry);
      return entry;
    });
    const checked = pending.catch((error) => {
      // Allocation/idle eviction precedes dispatch into the requested root.
      // Do not turn a pool resource failure into an uncertain mutation there.
      if (error instanceof WorkspaceToolError) {
        if (error.commandDiagnostic) throw error;
        throw new WorkspaceToolError(error.message, error.code, error.mutationMayHaveCommitted,
          error.requiresQuarantine, commandFailureDiagnostic('allocation', 'allocation_failed', error));
      }
      throw new WorkspaceToolError(
        'Native executor allocation failed',
        'COMMAND_UNAVAILABLE', false, false,
        commandFailureDiagnostic('allocation', 'allocation_failed', error),
      );
    });
    this.allocation = checked.catch(() => undefined);
    return checked;
  }

  async prepare(): Promise<void> {
    const workspaceIds = [...this.roots.keys()];
    let next = 0;
    await Promise.all(
      Array.from(
        { length: Math.min(this.capacity, workspaceIds.length) },
        async () => {
          for (;;) {
            const index = next++;
            if (index >= workspaceIds.length) return;
            const entry = await this.allocate(workspaceIds[index]!);
            try {
              await entry.sandbox.prepare();
            } finally {
              entry.busy = false;
            }
          }
        }
      )
    );
  }

  /**
   * The executor never sees `detached`: it is this pool's routing decision. The
   * result is returned as soon as the command ends; closing the executor queues
   * ahead of later allocations, which therefore still find capacity accounted for.
   */
  private async executeDetached(
    request: WorkspaceExecuteCommandRequest,
    signal?: AbortSignal
  ): Promise<WorkspaceExecuteCommandResult> {
    const { detached: _detached, ...command } = request;
    const key = `${DETACHED_EXECUTOR_KEY_PREFIX}${++this.detachedSequence}`;
    const entry = await this.allocate(request.workspaceId, key);
    try {
      if (signal?.aborted)
        throw new WorkspaceToolError(
          'Command cancelled before dispatch',
          'EXECUTION_ABORTED'
        );
      return await entry.sandbox.execute(command, signal);
    } finally {
      this.allocation = this.allocation.then(async () => {
        try {
          await entry.sandbox.close();
          this.entries.delete(key);
        } catch {
          /* Retain ownership for subsequent cleanup/shutdown. */
        } finally {
          entry.busy = false;
        }
      });
    }
  }

  async execute(
    request: WorkspaceExecuteCommandRequest,
    signal?: AbortSignal
  ): Promise<WorkspaceExecuteCommandResult> {
    if (request.detached === true) return this.executeDetached(request, signal);
    const entry = await this.allocate(request.workspaceId);
    let enteredExecutor = false;
    try {
      if (signal?.aborted)
        throw new WorkspaceToolError(
          'Command cancelled before dispatch',
          'EXECUTION_ABORTED'
        );
      enteredExecutor = true;
      return await entry.sandbox.execute(request, signal);
    } catch (error) {
      if (
        enteredExecutor &&
        error instanceof WorkspaceToolError &&
        !error.mutationMayHaveCommitted
      ) {
        // Never retry the command here. Retire a failed executor only after
        // close succeeds, allowing a later assignment to create a fresh child.
        try {
          await entry.sandbox.close();
          if (this.entries.get(request.workspaceId) === entry)
            this.entries.delete(request.workspaceId);
        } catch {
          /* Retain ownership for subsequent cleanup/shutdown. */
        }
      }
      throw error;
    } finally {
      entry.busy = false;
    }
  }

  async executeProgrammatic(
    workspaceId: string,
    request: BridgeWorkspaceProgrammaticRequest,
    signal?: AbortSignal
  ): Promise<object> {
    const entry = await this.allocate(workspaceId);
    let enteredExecutor = false;
    try {
      if (signal?.aborted)
        throw new WorkspaceToolError(
          'Programmatic execution cancelled before dispatch',
          'EXECUTION_ABORTED'
        );
      enteredExecutor = true;
      if (!entry.sandbox.executeProgrammatic) {
        throw new WorkspaceToolError(
          'Native programmatic executor is unavailable',
          'COMMAND_UNAVAILABLE', false, false,
          commandFailureDiagnostic('programmatic_preflight', 'prerequisite_failed'),
        );
      }
      return await entry.sandbox.executeProgrammatic(
        workspaceId,
        request,
        signal
      );
    } catch (error) {
      if (
        enteredExecutor &&
        error instanceof WorkspaceToolError &&
        !error.mutationMayHaveCommitted
      ) {
        try {
          await entry.sandbox.close();
          if (this.entries.get(workspaceId) === entry)
            this.entries.delete(workspaceId);
        } catch {
          /* Retain ownership for subsequent cleanup/shutdown. */
        }
      }
      throw error;
    } finally {
      entry.busy = false;
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    await this.allocation;
    const results = await Promise.allSettled(
      [...this.entries.values()].map((entry) => entry.sandbox.close())
    );
    this.entries.clear();
    const errors = results
      .filter((result) => result.status === 'rejected')
      .map((result) => result.reason);
    if (errors.length)
      throw new AggregateError(errors, 'Native executor pool shutdown failed');
  }
}
