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

function internalWorkspaceId(workspaceId: string, instanceId: string): string {
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
  private readonly executors = new Map<string, Promise<LocalWorkspaceTools>>();

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
    gitSharedObjectDirectory: string;
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
    const instance = await this.options.manager.resolve(
      workspaceId,
      instanceId,
      signal,
    );
    this.options.onResolve?.(workspaceId, instance.root);
    const internalId = internalWorkspaceId(workspaceId, instanceId);
    const key = `${workspaceId}\0${instanceId}`;
    let executor = this.executors.get(key);
    if (!executor) {
      executor = LocalWorkspaceTools.create({
        repositoryInstructions: source.repositoryInstructions,
        workspaces: [
          {
            id: internalId,
            identity: instance.identity,
            root: instance.root,
            writable: source.writable,
          },
        ],
      });
      this.executors.set(key, executor);
    }
    return {
      executor: await executor,
      gitSharedObjectDirectory: instance.gitSharedObjectDirectory,
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
      this.options.commandPool.registerRoot(resolved.internalId, {
        ...source.command,
        gitSharedObjectDirectory: resolved.gitSharedObjectDirectory,
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
    this.options.commandPool.registerRoot(resolved.internalId, {
      ...source.command,
      gitSharedObjectDirectory: resolved.gitSharedObjectDirectory,
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
