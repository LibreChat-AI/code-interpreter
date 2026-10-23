import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createBridgeIdentity } from './identity.js';
import { loadBridgeIdentity } from './storage.js';
import { loadWorkerProfile, saveWorkerProfile } from './worker-profile.js';
import {
  profileRunConfiguration,
  setupCodeApiUrl,
  setupWorker,
} from './setup.js';
import { parseSetupArguments } from './setup-cli.js';
import type { SetupWorkerOptions } from './setup.js';
import type { PairBridgeWorkerOptions } from './pairing.js';

const code = 'one-time-code-value-123456789';

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'worker-setup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options: SetupWorkerOptions = {
    codeApiUrl: 'https://code.example/v1/',
    workerId: 'setup-worker',
    code,
    profilePath: join(root, 'profiles', 'default.json'),
    identityPath: join(root, 'identity.json'),
    allowWorkspaceWrites: false,
    allowWorkspaceCommands: false,
  };
  const pair = async (input: PairBridgeWorkerOptions) => ({
    protocolVersion: 1 as const,
    workerId: input.workerId,
    codeApiUrl: input.codeApiUrl,
    ...createBridgeIdentity(),
    credential: 'issued-short-lived-credential-value',
    expiresAt: '2099-01-01T00:00:00Z',
  });
  return { root, options, pair };
}

test('setup saves separate identity and least-privilege profile after pairing', async t => {
  const { options, pair } = await fixture(t);
  let calls = 0;
  const saved = await setupWorker(options, {
    pair: async input => {
      calls++;
      assert.equal(input.codeApiUrl, 'https://code.example/v1');
      assert.equal(input.code, code);
      assert.ok(input.signal);
      return pair(input);
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(await loadWorkerProfile(saved.profilePath), saved.profile);
  assert.deepEqual(saved.profile.workspace, { type: 'private' });
  assert.equal(saved.profile.allowWorkspaceCommands, false);
  assert.equal(saved.profile.allowWorkspaceWrites, false);
  assert.equal(
    (await loadBridgeIdentity(saved.profile.identityPath)).workerId,
    'setup-worker',
  );
  const profileSource = await readFile(saved.profilePath, 'utf8');
  assert.ok(!profileSource.includes(code));
  assert.ok(!profileSource.includes('PRIVATE KEY'));
  assert.ok(!profileSource.includes('issued-short-lived'));
});

test('setup canonicalizes an explicitly selected project and preflights command dependencies', async t => {
  const { root, options, pair } = await fixture(t);
  const project = join(root, 'project with spaces');
  await mkdir(project);
  let checked = false;
  const saved = await setupWorker(
    { ...options, workspaceDirectory: project, allowWorkspaceCommands: true },
    {
      checkCommands: async () => {
        checked = true;
      },
      pair: async input => {
        assert.equal(checked, true);
        return pair(input);
      },
    },
  );
  assert.deepEqual(saved.profile.workspace, {
    type: 'directory',
    path: project,
  });
  assert.equal(saved.profile.allowWorkspaceCommands, true);
  assert.equal(saved.profile.allowWorkspaceWrites, false);
});

test('missing command prerequisites do not spend pairing code or create storage', async t => {
  const { root, options, pair } = await fixture(t);
  await assert.rejects(
    setupWorker(
      { ...options, allowWorkspaceCommands: true },
      {
        checkCommands: async () => {
          throw new Error('missing sandbox dependency');
        },
        pair: async input => {
          assert.fail('must not pair');
          return pair(input);
        },
      },
    ),
    /missing sandbox dependency/,
  );
  assert.deepEqual(await readdir(root), []);
});

test('denied or expired pairing releases only the new empty reservations', async t => {
  const { root, options } = await fixture(t);
  await assert.rejects(
    setupWorker(options, {
      pair: async () => {
        throw new Error('Pairing code is invalid or expired');
      },
    }),
    /invalid or expired/,
  );
  assert.deepEqual(await readdir(root), ['profiles']);
  assert.deepEqual(await readdir(join(root, 'profiles')), []);
});

test('existing identity is never replaced and code is not redeemed', async t => {
  const { options } = await fixture(t);
  await writeFile(options.identityPath!, 'keep this identity', { mode: 0o600 });
  await assert.rejects(
    setupWorker(options, {
      pair: async () => {
        assert.fail('must not pair');
      },
    }),
    /already exists/,
  );
  assert.equal(
    await readFile(options.identityPath!, 'utf8'),
    'keep this identity',
  );
  assert.equal(await loadWorkerProfile(options.profilePath!), undefined);
});

test('profile write failure preserves the paired identity for manual recovery', async t => {
  const { options, pair } = await fixture(t);
  await assert.rejects(
    setupWorker(options, {
      pair: async input => {
        await rm(options.profilePath!);
        await mkdir(options.profilePath!);
        return pair(input);
      },
    }),
    /Machine paired and identity saved.*profile could not be saved/,
  );
  assert.equal(
    (await loadBridgeIdentity(options.identityPath!)).workerId,
    options.workerId,
  );
});

test('setup rejects exposed control files even with read-only permissions', async t => {
  const { root, options } = await fixture(t);
  await assert.rejects(
    setupWorker(
      { ...options, workspaceDirectory: root },
      {
        pair: async () => {
          assert.fail('must not pair');
        },
      },
    ),
    /outside the workspace/,
  );
});

test('setup never admits home or a parent as a project', async t => {
  const { options } = await fixture(t);
  for (const workspaceDirectory of [homedir(), '/']) {
    await assert.rejects(
      setupWorker({ ...options, workspaceDirectory }),
      /Do not expose your home directory/,
    );
  }
});

test('setup stops before storage or pairing when cancelled', async t => {
  const { root, options } = await fixture(t);
  const controller = new AbortController();
  controller.abort(new Error('cancelled by owner'));
  await assert.rejects(
    setupWorker({ ...options, signal: controller.signal }),
    /cancelled by owner/,
  );
  assert.deepEqual(await readdir(root), []);
});

test('setup accepts HTTPS prefixes and only permits insecure HTTP on loopback', () => {
  assert.equal(
    setupCodeApiUrl('https://code.example/proxy/v1/'),
    'https://code.example/proxy/v1',
  );
  for (const host of ['localhost', '127.0.0.1', '[::1]']) {
    assert.equal(
      setupCodeApiUrl(`http://${host}:3000/v1`),
      `http://${host}:3000/v1`,
    );
  }
  for (const value of [
    'http://code.example/v1',
    'ftp://code.example',
    'https://user:secret@code.example/v1',
    'https://code.example/v1?token=secret',
    'https://code.example/v1#fragment',
    'https://code.example/\n',
  ]) {
    assert.throws(() => setupCodeApiUrl(value), /HTTPS|credentials/);
  }
});

test('saved profile startup never merges legacy identity or permission settings', async t => {
  const { options, pair } = await fixture(t);
  const saved = await setupWorker(options, { pair });
  const selected = await profileRunConfiguration(
    ['--profile', saved.profilePath],
    {},
  );
  assert.equal(selected.profilePath, saved.profilePath);
  assert.deepEqual(selected.args, ['--default-workspace']);
  assert.equal(selected.profile?.identityPath, options.identityPath);
  for (const key of [
    'LIBRECHAT_CODE_WORKER_TOKEN',
    'LIBRECHAT_CODE_IDENTITY_FILE',
    'LIBRECHAT_CODE_ALLOW_WORKSPACE_COMMANDS',
  ]) {
    await assert.rejects(
      profileRunConfiguration(['--profile', saved.profilePath], {
        [key]: 'configured',
      }),
      /cannot be combined/,
    );
    assert.deepEqual(
      await profileRunConfiguration(['--worker-dir', '/legacy'], {
        [key]: 'configured',
      }),
      { args: ['--worker-dir', '/legacy'] },
    );
  }
  await assert.rejects(
    profileRunConfiguration(
      ['--profile', saved.profilePath, '--allow-workspace-commands'],
      {},
    ),
    /cannot be combined with run options/,
  );
});

test('explicit profile parse rejects missing, repeated, absent, or corrupt profiles', async t => {
  const { options } = await fixture(t);
  await assert.rejects(
    profileRunConfiguration(['--profile'], {}),
    /requires a file/,
  );
  await assert.rejects(
    profileRunConfiguration(['--profile=a', '--profile=b'], {}),
    /only once/,
  );
  await assert.rejects(
    profileRunConfiguration(['--profile', options.profilePath!], {}),
    /not found/,
  );
  await mkdir(join(options.profilePath!, '..'), { recursive: true });
  await writeFile(options.profilePath!, '{}', { mode: 0o600 });
  await assert.rejects(
    profileRunConfiguration(['--profile', options.profilePath!], {}),
    /Invalid worker profile/,
  );
});

test('profile file environment variable selects the same profile without changing process environment', async t => {
  const { options } = await fixture(t);
  const profile = {
    version: 1 as const,
    identityPath: options.identityPath!,
    workspace: { type: 'private' as const },
    allowWorkspaceWrites: true,
    allowWorkspaceCommands: false,
  };
  await saveWorkerProfile(options.profilePath!, profile);
  const environment = { LIBRECHAT_CODE_PROFILE_FILE: options.profilePath! };
  const result = await profileRunConfiguration([], environment);
  assert.deepEqual(result.args, [
    '--default-workspace',
    '--allow-workspace-writes',
  ]);
  assert.deepEqual(environment, {
    LIBRECHAT_CODE_PROFILE_FILE: options.profilePath!,
  });
});

test('setup CLI parsing rejects ambiguity and requires explicit non-interactive access', () => {
  for (const args of [
    ['--worker-id'],
    ['--url', '--worker-id'],
    ['--unknown'],
    ['--url=a', '--url=b'],
    ['--default-workspace=true'],
    ['--worker-dir', '/project', '--default-workspace'],
    ['--non-interactive'],
    ['--code-stdin'],
  ]) {
    assert.throws(() => parseSetupArguments(args));
  }
  const parsed = parseSetupArguments([
    '--non-interactive',
    '--code-stdin',
    '--url=https://code.example/v1',
    '--worker-id=vm1',
    '--default-workspace',
  ]);
  assert.equal(parsed.get('--allow-workspace-commands'), undefined);
  assert.equal(parsed.get('--allow-workspace-writes'), undefined);
});
