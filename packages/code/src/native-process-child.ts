import { NativeSrtWorkspaceCommandSandbox } from './native-sandbox.js';
import { NativeWorkspaceProgrammaticExecutor } from './native-programmatic.js';
import { WorkspaceToolError } from './workspace.js';
import type { NativeSrtWorkspaceCommandSandboxOptions } from './native-sandbox.js';
import type {
  BridgeWorkspaceProgrammaticRequest,
  WorkspaceExecuteCommandRequest,
} from './protocol.js';

// This entrypoint is private to a forked trusted executor. No HTTP listener,
// argv credentials, bridge token, or persisted pairing material is required.
let sandbox: NativeSrtWorkspaceCommandSandbox | undefined;
let programmaticExecutor: NativeWorkspaceProgrammaticExecutor | undefined;
let programmaticReady: Promise<void> | undefined;
let programmaticFileUpstream: string | undefined;
let active: { id: string; controller: AbortController } | undefined;
let commitAcknowledgement:
  | { id: string; acknowledge(): void }
  | undefined;
let busy = false;
let credentials: Record<string, string> = {};
let wrappedCommand: string | undefined;

if (!process.send) throw new Error('Native executor requires IPC');
function reply(message: object): void {
  if (!process.connected) return;
  try {
    process.send?.({ ...message, fatal: shuttingDown }, () => undefined);
  } catch {
    /* Parent was lost. */
  }
}
async function awaitCommitAcknowledgement(
  id: string,
  signal: AbortSignal,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      commitAcknowledgement = undefined;
      reject(
        new WorkspaceToolError(
          'Programmatic execution aborted before commit',
          'EXECUTION_ABORTED',
        ),
      );
    };
    commitAcknowledgement = {
      id,
      acknowledge() {
        signal.removeEventListener('abort', abort);
        commitAcknowledgement = undefined;
        resolve();
      },
    };
    signal.addEventListener('abort', abort, { once: true });
    reply({ id, phase: 'commit' });
    if (signal.aborted) abort();
  });
}
let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  active?.controller.abort();
  void (sandbox?.close() ?? Promise.resolve()).then(
    () => process.exit(0),
    () => process.exit(1),
  );
  setTimeout(() => process.exit(1), 5000);
};
process.on('disconnect', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('SIGHUP', shutdown);
process.on('message', async (raw: unknown) => {
  if (shuttingDown) return;
  const message = raw as {
    id: string;
    type: string;
    options: Omit<
      NativeSrtWorkspaceCommandSandboxOptions,
      'maskedEnvironment'
    > & {
      programmaticFileUpstream?: string;
      variables?: NonNullable<
        NativeSrtWorkspaceCommandSandboxOptions['maskedEnvironment']
      >['variables'];
    };
    request: WorkspaceExecuteCommandRequest;
    programmaticRequest?: BridgeWorkspaceProgrammaticRequest;
    workspaceId?: string;
    credentials?: Record<string, string>;
    wrappedCommand?: string;
    programmaticShellPath?: string;
    programmaticJqPath?: string;
  };
  if (!message || typeof message.id !== 'string') return;
  if (message.type === 'cancel') {
    if (active?.id === message.id) active.controller.abort();
    return;
  }
  if (message.type === 'commit-ack') {
    if (commitAcknowledgement?.id === message.id) {
      commitAcknowledgement.acknowledge();
    }
    return;
  }
  if (busy) return;
  busy = true;
  let mutationStarted = false;
  try {
    let result: unknown;
    if (message.type === 'prepare' && !sandbox) {
      const { variables, programmaticFileUpstream: upstream, ...options } =
        message.options;
      programmaticFileUpstream = upstream;
      sandbox = new NativeSrtWorkspaceCommandSandbox({
        ...options,
        ...(variables
          ? {
              maskedEnvironment: {
                variables,
                async resolve() {
                  return credentials;
                },
                wrapCommand(command) {
                  return wrappedCommand ?? command;
                },
              },
            }
          : {}),
      });
      await sandbox.prepare();
    } else if (message.type === 'execute' && sandbox) {
      active = { id: message.id, controller: new AbortController() };
      credentials = message.credentials ?? {};
      wrappedCommand = message.wrappedCommand;
      mutationStarted = true;
      result = await sandbox.execute(message.request, active.controller.signal);
    } else if (
      message.type === 'programmatic' &&
      sandbox &&
      programmaticFileUpstream &&
      message.programmaticRequest &&
      typeof message.workspaceId === 'string' &&
      typeof message.programmaticShellPath === 'string' &&
      typeof message.programmaticJqPath === 'string'
    ) {
      active = { id: message.id, controller: new AbortController() };
      credentials = message.credentials ?? {};
      wrappedCommand = message.wrappedCommand;
      if (!programmaticExecutor) {
        programmaticExecutor = new NativeWorkspaceProgrammaticExecutor({
          sandbox,
          upstreamUrl: programmaticFileUpstream,
          shellPath: message.programmaticShellPath,
          jqPath: message.programmaticJqPath,
        });
        programmaticReady = programmaticExecutor.prepare(
          active.controller.signal,
        );
      }
      try {
        await programmaticReady;
      } catch (error) {
        programmaticExecutor = undefined;
        programmaticReady = undefined;
        throw error;
      }
      result = await programmaticExecutor.execute(
        message.programmaticRequest,
        message.workspaceId,
        active.controller.signal,
        {
          async beforeCommit() {
            await awaitCommitAcknowledgement(
              message.id,
              active!.controller.signal,
            );
            mutationStarted = true;
          },
        },
      );
    } else if (message.type === 'close' && sandbox) {
      await sandbox.close();
    } else throw new Error('Invalid executor state');
    reply({ id: message.id, ok: true, result });
  } catch (error) {
    reply({
      id: message.id,
      ok: false,
      code:
        error instanceof WorkspaceToolError
          ? error.code
          : 'COMMAND_UNAVAILABLE',
      ...(error instanceof WorkspaceToolError
        ? { errorMessage: error.message.slice(0, 1024) }
        : {}),
      mutation:
        error instanceof WorkspaceToolError
          ? error.mutationMayHaveCommitted
          : mutationStarted,
      requiresQuarantine:
        error instanceof WorkspaceToolError
          ? error.requiresQuarantine
          : mutationStarted,
    });
  } finally {
    active = undefined;
    credentials = {};
    wrappedCommand = undefined;
    busy = false;
  }
});
