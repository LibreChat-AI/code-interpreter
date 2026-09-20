import { createHash } from 'node:crypto';

import { NativeWorkspaceCommandPool } from './native-pool.js';
import { GitWorktreeManager } from './worktrees.js';
import { LocalWorkspaceTools, WorkspaceToolError } from './workspace.js';

import type { NativeProcessSandboxOptions } from './native-process.js';
import type { WorkspaceRootIdentity } from './root-identity.js';
import type {
  BridgeWorkspaceProgrammaticRequest,
  WorkspaceExecuteCommandRequest,
  WorkspaceToolRequest,
  WorkspaceToolResult,
} from './protocol.js';
import type { WorkspaceToolExecutor } from './workspace.js';

interface WorkspaceInstanceSource {
  command?: NativeProcessSandboxOptions;
  repositoryInstructions: boolean;
  writable: boolean;
}

export interface GitWorktreeWorkspaceToolsOptions {
  commandPool?: NativeWorkspaceCommandPool;
  delegate: WorkspaceToolExecutor;
  manager: GitWorktreeManager;
  onResolve?: (workspaceId: string, root: string) => void;
  sources: ReadonlyMap<string, WorkspaceInstanceSource>;
}

export function internalWorkspaceId(workspaceId: string, instanceId: string): string {
  return `instance-${createHash('sha256')
    .update(`${workspaceId}\0${instanceId}`)
    .digest('hex')}`;
}

function publicResult(
  result: WorkspaceToolResult,
  workspaceId: string,
): WorkspaceToolResult {
  return { ...result, workspaceId };
}

/** Resolve an opaque conversation binding into an isolated Git worktree. */
export class GitWorktreeWorkspaceTools implements WorkspaceToolExecutor {
  readonly mutationFailuresAreAtomic?: true;
  readonly capabilities: WorkspaceToolExecutor['capabilities'];
  private readonly executors = new Map<
    string,
    { identity: WorkspaceRootIdentity; value: Promise<LocalWorkspaceTools> }
  >();

  constructor(private readonly options: GitWorktreeWorkspaceToolsOptions) {
    this.mutationFailuresAreAtomic = options.delegate.mutationFailuresAreAtomic;
    this.capabilities = {
      ...options.delegate.capabilities,
      workspaces: options.delegate.capabilities.workspaces.map((workspace) => ({
        ...workspace,
        ...(options.sources.has(workspace.id)
          ? { workspaceInstances: ['git_worktree' as const] }
          : {}),
      })),
    };
  }

  private async executor(
    workspaceId: string,
    instanceId: string,
    signal?: AbortSignal,
  ): Promise<{
    executor: LocalWorkspaceTools;
    identity: WorkspaceRootIdentity;
    internalId: string;
    root: string;
  }> {
    const source = this.options.sources.get(workspaceId);
    if (!source) {
      throw new WorkspaceToolError(
        'Workspace does not allow conversation worktrees',
        'INVALID_REQUEST',
      );
    }
    let instance;
    try {
      instance = await this.options.manager.resolve(
        workspaceId,
        instanceId,
        signal,
      );
    } catch (error) {
      if (error instanceof WorkspaceToolError) throw error;
      if (
        signal?.aborted ||
        (error instanceof Error && error.name === 'AbortError')
      ) {
        throw new WorkspaceToolError(
          'Conversation worktree provisioning aborted',
          'EXECUTION_ABORTED',
        );
      }
      throw new WorkspaceToolError(
        error instanceof Error
          ? error.message
          : 'Conversation worktree provisioning failed',
        'WRITE_UNAVAILABLE',
      );
    }
    this.options.onResolve?.(workspaceId, instance.root);
    const internalId = internalWorkspaceId(workspaceId, instanceId);
    const key = `${workspaceId}\0${instanceId}`;
    let cached = this.executors.get(key);
    if (
      cached == null ||
      cached.identity.dev !== instance.identity.dev ||
      cached.identity.ino !== instance.identity.ino ||
      cached.identity.path !== instance.identity.path
    ) {
      cached = {
        identity: instance.identity,
        value: LocalWorkspaceTools.create({
          repositoryInstructions: source.repositoryInstructions,
          workspaces: [
            {
              id: internalId,
              identity: instance.identity,
              root: instance.root,
              writable: source.writable,
            },
          ],
        }),
      };
      this.executors.set(key, cached);
    }
    return {
      executor: await cached.value,
      identity: instance.identity,
      internalId,
      root: instance.root,
    };
  }

  async execute(
    request: WorkspaceToolRequest,
    signal?: AbortSignal,
  ): Promise<WorkspaceToolResult> {
    if (!request.workspaceInstanceId) {
      return await this.options.delegate.execute(request, signal);
    }
    if (
      request.operation === 'read_file' &&
      request.instructionSha256 !== undefined
    ) {
      const { workspaceInstanceId: _workspaceInstanceId, ...sourceRequest } =
        request;
      return await this.options.delegate.execute(sourceRequest, signal);
    }
    const { workspaceInstanceId, ...baseRequest } = request;
    const source = this.options.sources.get(request.workspaceId);
    const resolved = await this.executor(
      request.workspaceId,
      workspaceInstanceId,
      signal,
    );
    const isolatedRequest = {
      ...baseRequest,
      workspaceId: resolved.internalId,
    } as WorkspaceToolRequest;
    if (request.operation === 'execute_command') {
      if (!source?.command || !this.options.commandPool) {
        throw new WorkspaceToolError(
          'Conversation worktree commands are unavailable',
          'COMMAND_DISABLED',
        );
      }
      await this.options.commandPool.registerRoot(resolved.internalId, {
        ...source.command,
        workspaceIdentity: resolved.identity,
        workspaceRoot: resolved.root,
      });
      return publicResult(
        await this.options.commandPool.execute(
          isolatedRequest as WorkspaceExecuteCommandRequest,
          signal,
        ),
        request.workspaceId,
      );
    }
    return publicResult(
      await resolved.executor.execute(isolatedRequest, signal),
      request.workspaceId,
    );
  }

  async executeProgrammatic(
    workspaceId: string,
    request: BridgeWorkspaceProgrammaticRequest,
    signal?: AbortSignal,
  ): Promise<object> {
    const instanceId = request.body.workspace_instance_id;
    if (!instanceId) {
      if (!this.options.commandPool) {
        throw new WorkspaceToolError(
          'Workspace programmatic execution is unavailable',
          'COMMAND_DISABLED',
        );
      }
      return await this.options.commandPool.executeProgrammatic(
        workspaceId,
        request,
        signal,
      );
    }
    const source = this.options.sources.get(workspaceId);
    if (!source?.command || !this.options.commandPool) {
      throw new WorkspaceToolError(
        'Conversation worktree programmatic execution is unavailable',
        'COMMAND_DISABLED',
      );
    }
    const resolved = await this.executor(workspaceId, instanceId, signal);
    await this.options.commandPool.registerRoot(resolved.internalId, {
      ...source.command,
      workspaceIdentity: resolved.identity,
      workspaceRoot: resolved.root,
    });
    return await this.options.commandPool.executeProgrammatic(
      resolved.internalId,
      request,
      signal,
    );
  }
}
