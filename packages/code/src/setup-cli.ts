import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { resolve } from 'node:path';

import {
  setupCodeApiUrl,
  setupWorker,
  setupWorkspaceDirectory,
} from './setup.js';
import { defaultWorkerProfilePath } from './worker-profile.js';
import { isValidBridgeWorkerId } from './protocol.js';
import { runBrowserSetupCommand } from './browser-setup-cli.js';

export const SETUP_HELP = `Usage: librechat-code setup [options]

Enroll with browser approval:
  librechat-code setup --instance https://chat.example.com

The browser uses LibreChat's normal login, including configured OAuth/OIDC.
SSH/headless machines display a URL and matching verification code. No inbound
listener or CLI identity-provider integration is needed. Interrupted setup
resumes the same saved key and attempt. Never delete it to retry an enrollment.

Existing manual pairing:
Create a private worker profile using a one-time pairing from LibreChat.
Open Settings > Code Environments in LibreChat to add the machine first.
Use its Code API URL, worker ID, and pairing code. This command does not
sign in to LibreChat or bypass its enrollment policy.

  --instance <url>          LibreChat instance URL for browser approval
  --machine-name <name>     Display name (default: host name)
  --no-browser             Display approval instructions without opening a browser
  --start                  Start the saved worker in the foreground after setup
  --cancel                 Cancel this profile's pending browser setup
  --url <url>               Manual Code API URL, including its /v1 prefix
  --worker-id <id>          Worker ID supplied by LibreChat
  --worker-dir <directory>  Expose one existing project directory
  --default-workspace      Create a private workspace when the worker starts
  --allow-workspace-writes  Explicitly enable file writes (default: off)
  --allow-workspace-commands Explicitly enable sandboxed commands (default: off)
  --profile <file>          Profile destination (default: profiles/default.json)
  --identity <file>         Separate private identity destination
  --non-interactive        Require explicit inputs instead of prompting
  --code-stdin             Read the pairing code from stdin, never an argument
  --help                   Show this help

Existing profiles and identities are never replaced. Choose another profile
and identity for a second machine. Setup does not install OS dependencies,
start a background service, or change the restricted command policy.
`;

const VALUE_FLAGS = new Set([
  '--instance',
  '--machine-name',
  '--url',
  '--worker-id',
  '--worker-dir',
  '--profile',
  '--identity',
]);
const BOOLEAN_FLAGS = new Set([
  '--no-browser',
  '--start',
  '--cancel',
  '--default-workspace',
  '--allow-workspace-writes',
  '--allow-workspace-commands',
  '--non-interactive',
  '--code-stdin',
]);

export function parseSetupArguments(
  args: string[],
): Map<string, string | true> {
  const options = new Map<string, string | true>();
  for (let i = 0; i < args.length; i++) {
    const [flag, ...inline] = args[i].split('=');
    if (
      (!VALUE_FLAGS.has(flag) && !BOOLEAN_FLAGS.has(flag)) ||
      options.has(flag)
    ) {
      throw new Error(
        'Unknown or repeated setup option; use librechat-code setup --help',
      );
    }
    if (BOOLEAN_FLAGS.has(flag)) {
      if (inline.length)
        throw new Error(
          'Setup switches do not accept a value; use setup --help',
        );
      options.set(flag, true);
    } else {
      const value = inline.length ? inline.join('=') : args[++i];
      if (
        !value?.trim() ||
        value.startsWith('--') ||
        /[\x00-\x1f\x7f]/.test(value)
      ) {
        throw new Error(
          'A setup option is missing its value; use setup --help',
        );
      }
      options.set(flag, value);
    }
  }
  if (options.has('--worker-dir') && options.has('--default-workspace')) {
    throw new Error('Choose --worker-dir or --default-workspace, not both');
  }
  if (options.has('--instance') && ['--url', '--worker-id', '--code-stdin'].some(flag => options.has(flag)))
    throw new Error('Browser approval cannot be combined with manual pairing options');
  if (!options.has('--instance') && ['--machine-name', '--no-browser', '--start', '--cancel'].some(flag => options.has(flag)))
    throw new Error('Browser setup options require --instance');
  if (options.has('--non-interactive') && options.has('--instance') && !options.has('--cancel') &&
      !options.has('--worker-dir') && !options.has('--default-workspace'))
    throw new Error('Non-interactive browser setup requires --worker-dir or --default-workspace');
  if (
    options.has('--non-interactive') && !options.has('--instance') &&
    (!options.has('--url') ||
      !options.has('--worker-id') ||
      !options.has('--code-stdin') ||
      (!options.has('--worker-dir') && !options.has('--default-workspace')))
  ) {
    throw new Error(
      'Non-interactive setup requires --url, --worker-id, --code-stdin, and --worker-dir or --default-workspace',
    );
  }
  if (options.has('--code-stdin') && !options.has('--non-interactive')) {
    throw new Error('--code-stdin requires --non-interactive');
  }
  return options;
}

async function pairingCodeFromStdin(signal: AbortSignal): Promise<string> {
  let code = '';
  const abort = () => process.stdin.destroy(new Error('Setup cancelled'));
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    for await (const chunk of process.stdin) {
      code += String(chunk);
      if (Buffer.byteLength(code) > 1024)
        throw new Error('Pairing code input is too large');
      signal.throwIfAborted();
    }
    return code.trim();
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

export async function runSetupCommand(args: string[]): Promise<void> {
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write(SETUP_HELP);
    return;
  }
  const options = parseSetupArguments(args);
  const interactive = !options.has('--non-interactive');
  if (interactive && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    throw new Error(
      'Guided setup requires a terminal. For automation use --non-interactive and --code-stdin; see setup --help',
    );
  }
  const controller = new AbortController();
  const abort = () => controller.abort(new Error('Setup cancelled'));
  process.once('SIGINT', abort);
  let muted = false;
  const output = new Writable({
    write(chunk, _encoding, callback) {
      if (!muted) process.stdout.write(chunk);
      callback();
    },
  });
  const ask = async (message: string, secret = false): Promise<string> => {
    controller.signal.throwIfAborted();
    muted = secret;
    // Readline retains more than history (including a kill ring). Never reuse prompt state.
    const terminal = createInterface({
      input: process.stdin,
      output,
      terminal: true,
      historySize: 0,
    });
    terminal.on('SIGINT', abort);
    terminal.once('close', abort);
    process.stdout.write(message);
    try {
      return (
        await terminal.question('', { signal: controller.signal })
      ).trim();
    } finally {
      terminal.off('close', abort);
      terminal.off('SIGINT', abort);
      terminal.close();
      muted = false;
      if (secret) process.stdout.write('\n');
    }
  };
  const yesNo = async (message: string): Promise<boolean> => {
    for (;;) {
      const value = (await ask(`${message} [y/N]: `)).toLowerCase();
      if (value === '' || value === 'n' || value === 'no') return false;
      if (value === 'y' || value === 'yes') return true;
      process.stdout.write('Enter yes or no.\n');
    }
  };
  try {
    if (options.has('--instance')) {
      await runBrowserSetupCommand(options, { interactive, ask, yesNo, signal: controller.signal });
      return;
    }
    if (interactive)
      process.stdout.write(
        'Connect a machine using the pairing supplied by LibreChat.\nOnly selected folders and permissions will be exposed.\n\n',
      );
    const codeApiUrl = setupCodeApiUrl(
      String(
        options.get('--url') ?? (await ask('Code API URL (including /v1): ')),
      ),
    );
    const workerId = String(
      options.get('--worker-id') ?? (await ask('Worker ID from LibreChat: ')),
    );
    if (!isValidBridgeWorkerId(workerId))
      throw new Error('Enter the worker ID supplied by LibreChat');
    let workspaceDirectory = options.get('--worker-dir') as string | undefined;
    if (
      interactive &&
      !workspaceDirectory &&
      !options.has('--default-workspace')
    ) {
      workspaceDirectory =
        (await ask(
          'Project directory (Enter for a new private workspace): ',
        )) || undefined;
    }
    if (workspaceDirectory != null)
      workspaceDirectory = await setupWorkspaceDirectory(workspaceDirectory);
    const allowWorkspaceWrites =
      options.has('--allow-workspace-writes') ||
      (interactive &&
        (await yesNo('Allow file writes within this workspace?')));
    const allowWorkspaceCommands =
      options.has('--allow-workspace-commands') ||
      (interactive &&
        (await yesNo(
          'Allow sandboxed commands within this workspace? Commands can modify workspace files',
        )));
    const profilePath = resolve(
      String(options.get('--profile') ?? defaultWorkerProfilePath()),
    );
    const code = interactive
      ? await ask('One-time pairing code (hidden): ', true)
      : await pairingCodeFromStdin(controller.signal);
    process.stdout.write(
      `\nCode API: ${codeApiUrl}\nWorker: ${workerId}\nWorkspace: ${workspaceDirectory ?? 'new private workspace'}\nFile writes: ${allowWorkspaceWrites ? 'enabled' : 'disabled'}\nCommands: ${allowWorkspaceCommands ? 'enabled, restricted sandbox policy' : 'disabled'}\nProfile: ${profilePath}\n`,
    );
    if (
      interactive &&
      !(await yesNo('Pair this machine and save these choices?'))
    ) {
      process.stdout.write('Setup cancelled. No pairing was redeemed.\n');
      return;
    }
    await setupWorker({
      codeApiUrl,
      workerId,
      code,
      profilePath,
      identityPath: options.get('--identity') as string | undefined,
      workspaceDirectory,
      allowWorkspaceWrites,
      allowWorkspaceCommands,
      signal: controller.signal,
    });
    const defaultProfile = profilePath === resolve(defaultWorkerProfilePath());
    const quotedProfile = `'${profilePath.replace(/'/g, "'\\''")}'`;
    process.stdout.write(
      `\nSetup saved. Start the worker with:\n  librechat-code run${defaultProfile ? '' : ` --profile ${quotedProfile}`}\n\nPairing is complete. The worker still needs to start, prepare its sandbox,\nand register before LibreChat can report it ready.\n`,
    );
  } finally {
    process.off('SIGINT', abort);
    output.destroy();
  }
}
