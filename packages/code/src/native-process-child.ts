import { NativeSrtWorkspaceCommandSandbox } from './native-sandbox.js';
import { WorkspaceToolError } from './workspace.js';
import type { NativeSrtWorkspaceCommandSandboxOptions } from './native-sandbox.js';
import type { WorkspaceExecuteCommandRequest } from './protocol.js';

// This entrypoint is private to a forked trusted executor. No HTTP listener,
// argv credentials, bridge token, or persisted pairing material is required.
let sandbox: NativeSrtWorkspaceCommandSandbox | undefined;
let active: { id: string; controller: AbortController } | undefined;
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
let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  active?.controller.abort();
  void (sandbox?.close() ?? Promise.resolve()).finally(() => process.exit(1));
  setTimeout(() => process.exit(1), 5000);
};
process.on('disconnect', shutdown);
process.on('SIGTERM', shutdown);
process.on('message', async (raw: unknown) => {
  if (shuttingDown) return;
  const message = raw as {
    id: string;
    type: string;
    options: Omit<
      NativeSrtWorkspaceCommandSandboxOptions,
      'maskedEnvironment'
    > & {
      variables?: NonNullable<
        NativeSrtWorkspaceCommandSandboxOptions['maskedEnvironment']
      >['variables'];
    };
    request: WorkspaceExecuteCommandRequest;
    credentials?: Record<string, string>;
    wrappedCommand?: string;
  };
  if (!message || typeof message.id !== 'string') return;
  if (message.type === 'cancel') {
    if (active?.id === message.id) active.controller.abort();
    return;
  }
  if (busy) return;
  busy = true;
  try {
    let result: unknown;
    if (message.type === 'prepare' && !sandbox) {
      const { variables, ...options } = message.options;
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
      result = await sandbox.execute(message.request, active.controller.signal);
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
          : true,
    });
  } finally {
    active = undefined;
    credentials = {};
    wrappedCommand = undefined;
    busy = false;
  }
});
