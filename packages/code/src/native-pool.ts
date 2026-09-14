import { NativeProcessWorkspaceCommandSandbox } from './native-process.js';
import { WorkspaceToolError } from './workspace.js';
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
    Partial<
      Pick<NativeProcessWorkspaceCommandSandbox, 'executeProgrammatic'>
    >;
  busy: boolean;
}

/** Bounded persistent executor cache. Each child owns one root's SRT policy;
 * only idle children may be evicted, and ambiguous failures are never retried.
 */
export class NativeWorkspaceCommandPool {
  readonly mutationFailuresAreAtomic = true as const;
  private readonly entries = new Map<string, Entry>();
  private allocation: Promise<unknown> = Promise.resolve();
  private closing = false;
  constructor(
    private readonly roots: ReadonlyMap<string, NativeProcessSandboxOptions>,
    private readonly capacity: number,
    private readonly createSandbox: (
      options: NativeProcessSandboxOptions,
    ) => Entry['sandbox'] = (options) =>
      new NativeProcessWorkspaceCommandSandbox(options),
  ) {
    if (
      !Number.isSafeInteger(capacity) ||
      capacity < 1 ||
      capacity > 8 ||
      roots.size === 0
    ) {
      throw new Error('Native executor capacity must be between 1 and 8');
    }
  }

  private allocate(root: string): Promise<Entry> {
    const pending = this.allocation.then(async () => {
      const options = this.roots.get(root);
      if (this.closing || !options)
        throw new WorkspaceToolError(
          'Native workspace unavailable',
          'REGISTRATION_INVALID',
        );
      let entry = this.entries.get(root);
      if (entry?.busy)
        throw new WorkspaceToolError(
          'Native workspace already executing',
          'COMMAND_UNAVAILABLE',
        );
      if (!entry) {
        if (this.entries.size >= this.capacity) {
          const idle = [...this.entries].find(
            ([, candidate]) => !candidate.busy,
          );
          if (!idle)
            throw new WorkspaceToolError(
              'Native executor capacity reached',
              'COMMAND_UNAVAILABLE',
            );
          await idle[1].sandbox.close();
          this.entries.delete(idle[0]);
        }
        entry = {
          sandbox: this.createSandbox(options),
          busy: false,
        };
      }
      entry.busy = true;
      // Map insertion order is the idle eviction order.
      this.entries.delete(root);
      this.entries.set(root, entry);
      return entry;
    });
    const checked = pending.catch((error) => {
      // Allocation/idle eviction precedes dispatch into the requested root.
      // Do not turn a pool resource failure into an uncertain mutation there.
      if (error instanceof WorkspaceToolError) throw error;
      throw new WorkspaceToolError(
        'Native executor allocation failed',
        'COMMAND_UNAVAILABLE',
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
        },
      ),
    );
  }

  async execute(
    request: WorkspaceExecuteCommandRequest,
    signal?: AbortSignal,
  ): Promise<WorkspaceExecuteCommandResult> {
    const entry = await this.allocate(request.workspaceId);
    let enteredExecutor = false;
    try {
      if (signal?.aborted)
        throw new WorkspaceToolError(
          'Command cancelled before dispatch',
          'EXECUTION_ABORTED',
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
    signal?: AbortSignal,
  ): Promise<object> {
    const entry = await this.allocate(workspaceId);
    let enteredExecutor = false;
    try {
      if (signal?.aborted)
        throw new WorkspaceToolError(
          'Programmatic execution cancelled before dispatch',
          'EXECUTION_ABORTED',
        );
      enteredExecutor = true;
      if (!entry.sandbox.executeProgrammatic) {
        throw new WorkspaceToolError(
          'Native programmatic executor is unavailable',
          'COMMAND_UNAVAILABLE',
        );
      }
      return await entry.sandbox.executeProgrammatic(
        workspaceId,
        request,
        signal,
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
      [...this.entries.values()].map((entry) => entry.sandbox.close()),
    );
    this.entries.clear();
    const errors = results
      .filter((result) => result.status === 'rejected')
      .map((result) => result.reason);
    if (errors.length)
      throw new AggregateError(errors, 'Native executor pool shutdown failed');
  }
}
