import { spawn } from 'node:child_process';
import { createHash, createPublicKey } from 'node:crypto';
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { cancelBrowserSetup, loadBrowserSetupAttempt, setupBrowserWorker, setupInstanceUrl } from './browser-setup.js';
import { defaultWorkerProfilePath } from './worker-profile.js';
import { setupWorkspaceDirectory } from './setup.js';

/** No shell, token, or inbound callback listener is involved. */
export async function openSetupBrowser(url: string): Promise<boolean> {
  if (process.env.SSH_CONNECTION || process.env.SSH_TTY ||
      (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY)) return false;
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'linux' ? 'xdg-open' : undefined;
  if (!command) return false;
  return new Promise<boolean>(resolve => {
    const child = spawn(command, [url], { stdio: 'ignore', shell: false });
    const timer = setTimeout(() => { child.kill(); resolve(false); }, 5000);
    child.once('error', () => { clearTimeout(timer); resolve(false); });
    child.once('exit', code => { clearTimeout(timer); resolve(code === 0); });
  });
}

export async function runBrowserSetupCommand(
  options: Map<string, string | true>,
  prompts: {
    interactive: boolean;
    ask(message: string): Promise<string>;
    yesNo(message: string): Promise<boolean>;
    signal: AbortSignal;
  },
): Promise<void> {
  const profilePath = resolve(String(options.get('--profile') ?? defaultWorkerProfilePath()));
  const instance = setupInstanceUrl(String(options.get('--instance')));
  const saved = await loadBrowserSetupAttempt(profilePath);
  if (saved && saved.request.instance !== instance) throw new Error('This profile has a setup attempt for another LibreChat instance. Resume the original instance or choose another profile');
  if (options.has('--cancel')) {
    await cancelBrowserSetup(profilePath, prompts.signal);
    process.stdout.write('Setup cancellation recorded. The local machine key and attempt were preserved.\n');
    return;
  }
  let workspaceDirectory = options.get('--worker-dir') as string | undefined;
  if (saved) {
    if (workspaceDirectory && (saved.profile.workspace.type !== 'directory' || await setupWorkspaceDirectory(workspaceDirectory) !== saved.profile.workspace.path))
      throw new Error('The workspace differs from the saved setup attempt');
    if (options.has('--default-workspace') && saved.profile.workspace.type !== 'private') throw new Error('The workspace differs from the saved setup attempt');
    if ((options.has('--allow-workspace-writes') && !saved.profile.allowWorkspaceWrites) ||
        (options.has('--allow-workspace-commands') && !saved.profile.allowWorkspaceCommands)) throw new Error('Permissions differ from the saved setup attempt');
    workspaceDirectory = saved.profile.workspace.type === 'directory' ? saved.profile.workspace.path : undefined;
    process.stdout.write('Resuming the saved setup attempt with its original machine key and access choices.\n');
  } else if (prompts.interactive && !workspaceDirectory && !options.has('--default-workspace')) {
    workspaceDirectory = (await prompts.ask('Project directory (Enter for a new private workspace): ')) || undefined;
  }
  if (workspaceDirectory !== undefined) workspaceDirectory = await setupWorkspaceDirectory(workspaceDirectory);
  const machineName = String(options.get('--machine-name') ?? saved?.request.machineName ?? hostname().replace(/[^A-Za-z0-9 ._()-]/g, '-').slice(0, 80));
  const allowWorkspaceWrites = saved?.profile.allowWorkspaceWrites ?? (options.has('--allow-workspace-writes') ||
    (prompts.interactive && await prompts.yesNo('Allow file writes within this workspace?')));
  const allowWorkspaceCommands = saved?.profile.allowWorkspaceCommands ?? (options.has('--allow-workspace-commands') ||
    (prompts.interactive && await prompts.yesNo('Allow sandboxed commands? Commands can modify workspace files independently of file-write tooling')));
  process.stdout.write(`\nLibreChat: ${instance}\nMachine: ${machineName}\nWorkspace: ${workspaceDirectory ?? 'new private workspace'}\nFile writes: ${allowWorkspaceWrites ? 'enabled' : 'disabled'}\nCommands: ${allowWorkspaceCommands ? 'enabled, restricted sandbox policy' : 'disabled'}\nProfile: ${profilePath}\nPairing does not attest this host or replace tool approvals.\n`);
  if (!saved && prompts.interactive && !await prompts.yesNo('Request browser approval with these choices?')) {
    process.stdout.write('Setup cancelled before enrollment.\n');
    return;
  }
  await setupBrowserWorker({
    instance, machineName, profilePath,
    identityPath: options.get('--identity') as string | undefined ?? saved?.profile.identityPath,
    workspaceDirectory, allowWorkspaceWrites, allowWorkspaceCommands,
    signal: prompts.signal,
  }, {
    onVerification: async status => {
      const attempt = (await loadBrowserSetupAttempt(profilePath))!;
      const fingerprint = createHash('sha256').update(createPublicKey(attempt.request.publicKey).export({ type: 'spki', format: 'der' })).digest('hex');
      process.stdout.write(`Machine key: SHA256:${fingerprint}\n`);
      // Always show both, even when opening a browser succeeds.
      process.stdout.write(`\nApprove this machine in LibreChat:\n  ${status.verificationUrl}\nVerification code: ${status.verificationCode}\nExpires: ${status.expiresAt}\nCheck the matching code and key identity before approving. Waiting for your explicit decision.\n`);
      if (!options.has('--no-browser') && prompts.interactive && !await openSetupBrowser(status.verificationUrl))
        process.stdout.write('Could not open a browser here. Open the URL on another device and compare the code.\n');
    },
  });
  process.stdout.write('\nMachine enrolled. Profile saved. It is not connected or ready until the worker starts and readiness is confirmed.\n');
  prompts.signal.throwIfAborted();
  const start = options.has('--start') || (prompts.interactive && await prompts.yesNo('Start the worker in the foreground now?'));
  if (start) {
    prompts.signal.throwIfAborted();
    process.stdout.write('Starting the saved profile in the foreground. Stop with Ctrl-C.\n');
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [fileURLToPath(new URL('./cli.js', import.meta.url)), 'run', '--profile', profilePath], { stdio: 'inherit' });
      const abort = () => child.kill('SIGINT');
      prompts.signal.addEventListener('abort', abort, { once: true });
      child.once('error', reject);
      child.once('exit', code => {
        prompts.signal.removeEventListener('abort', abort);
        if (code === 0 || prompts.signal.aborted) resolve();
        else reject(new Error('Worker stopped before a successful foreground session; enrollment and profile remain saved'));
      });
    });
  } else {
    const quoted = `'${profilePath.replace(/'/g, "'\\''")}'`;
    process.stdout.write(`Start it with:\n  librechat-code run${profilePath === resolve(defaultWorkerProfilePath()) ? '' : ` --profile ${quoted}`}\n`);
  }
}
