import { generateKeyPairSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  chmod,
  mkdtemp,
  mkdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GITHUB_ALLOWED_DOMAINS,
  GITHUB_AUTHOR_EMAIL_ENV_NAME,
  GITHUB_AUTHOR_NAME_ENV_NAME,
  GitHubAppCredentialProvider,
  StaticGitHubCredentialProvider,
  gitHubAuthenticationPolicyIdentity,
  gitHubCliTokenEnvironmentName,
  gitHubCommandCredentialEnvironment,
  gitHubMaskedCredentialVariables,
  GITHUB_CREDENTIAL_ENV_NAME,
  gitHubCredentialEnvironment,
  gitHubRepositoryForAdmittedDirectory,
  gitHubRepositoryForCommand,
  gitHubRepositoryForDirectory,
  normalizeGitHubHost,
  wrapGitHubCredentialCommand,
} from './github.js';

test('normalizes GitHub DNS hostnames before policy and allowlist use', () => {
  assert.equal(normalizeGitHubHost('GitHub.COM'), 'github.com');
  assert.throws(() => normalizeGitHubHost('.github.com'), /DNS hostname/);
});

test('binds the GitHub App installation to the public policy identity', () => {
  assert.equal(
    gitHubAuthenticationPolicyIdentity({
      mode: 'app',
      host: 'github.com',
      appId: '123',
      installationId: '456',
    }),
    'github-auth:app:github.com:app:123:installation:456',
  );
  assert.notEqual(
    gitHubAuthenticationPolicyIdentity({
      mode: 'app',
      host: 'github.com',
      appId: '123',
      installationId: '456',
    }),
    gitHubAuthenticationPolicyIdentity({
      mode: 'app',
      host: 'github.com',
      appId: '123',
      installationId: '789',
    }),
  );
});

test('binds token credentials to policy identity without exposing the token', () => {
  const firstToken = 'github_pat_abcdefghijklmnopqrstuvwxyz';
  const secondToken = 'github_pat_zyxwvutsrqponmlkjihgfedcba';
  const first = gitHubAuthenticationPolicyIdentity({
    mode: 'token',
    host: 'github.com',
    token: firstToken,
  });
  const second = gitHubAuthenticationPolicyIdentity({
    mode: 'token',
    host: 'github.com',
    token: secondToken,
  });

  assert.notEqual(first, second);
  assert.ok(!first.includes(firstToken));
});

test('rejects GitHub App authentication where key ACLs cannot be validated', () => {
  assert.throws(
    () =>
      new GitHubAppCredentialProvider({
        appId: '123',
        installationId: '456',
        privateKeyPath: 'C:\\secure\\app.pem',
        platform: 'win32',
      }),
    /private key ACLs cannot be validated securely/,
  );
});

test('mints and caches a short-lived GitHub App installation token', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'librechat-code-github-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const privateKeyPath = join(directory, 'app.pem');
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  await writeFile(
    privateKeyPath,
    privateKey.export({ type: 'pkcs8', format: 'pem' }),
    { mode: 0o600 },
  );
  await chmod(privateKeyPath, 0o600);
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const request = async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = String(input);
    const authorization = new Headers(init?.headers).get('authorization');
    calls.push({ url, authorization });
    if (url.endsWith('/app')) {
      assert.match(String(authorization), /^Bearer eyJ/);
      return Response.json({ slug: 'lia' });
    }
    if (url.endsWith('/app/installations/456/access_tokens')) {
      assert.match(String(authorization), /^Bearer eyJ/);
      return Response.json({
        token: 'ghs_abcdefghijklmnopqrstuvwxyz',
        expires_at: '2030-01-01T01:00:00Z',
      }, { status: 201 });
    }
    if (url.endsWith('/users/lia%5Bbot%5D')) {
      assert.equal(authorization, 'Bearer ghs_abcdefghijklmnopqrstuvwxyz');
      return Response.json({ id: 1234, login: 'lia[bot]', type: 'Bot' });
    }
    return Response.json({}, { status: 404 });
  };
  const provider = new GitHubAppCredentialProvider({
    appId: '123',
    installationId: '456',
    privateKeyPath,
    fetch: request as typeof fetch,
    now: () => new Date('2030-01-01T00:00:00Z'),
  });

  assert.equal(
    (await provider.getCredential()).value,
    'ghs_abcdefghijklmnopqrstuvwxyz',
  );
  assert.equal(
    (await provider.getCredential()).value,
    'ghs_abcdefghijklmnopqrstuvwxyz',
  );
  assert.equal(calls.filter(call => call.url.endsWith('/app')).length, 1);
  assert.equal(
    calls.filter(call => call.url.endsWith('/access_tokens')).length,
    1,
  );
  assert.equal(
    calls.filter(call => call.url.endsWith('/users/lia%5Bbot%5D')).length,
    1,
  );
});

test('routes and scopes GitHub App tokens per repository installation', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'librechat-code-github-routing-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const privateKeyPath = join(directory, 'app.pem');
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  await writeFile(
    privateKeyPath,
    privateKey.export({ type: 'pkcs8', format: 'pem' }),
    { mode: 0o600 },
  );
  const calls: Array<{ url: string; body?: string }> = [];
  const provider = new GitHubAppCredentialProvider({
    appId: '123',
    privateKeyPath,
    now: () => new Date('2030-01-01T00:00:00Z'),
    fetch: (async (input, init) => {
      const url = String(input);
      calls.push({ url, body: typeof init?.body === 'string' ? init.body : undefined });
      if (url.endsWith('/app')) {
        return Response.json({ slug: 'lia-by-librechat' });
      }
      if (url.endsWith('/users/lia-by-librechat%5Bbot%5D')) {
        return Response.json({
          id: 328778573,
          login: 'lia-by-librechat[bot]',
          type: 'Bot',
        });
      }
      if (url.endsWith('/repos/danny-avila/LibreChat/installation')) {
        return Response.json({ id: 111 });
      }
      if (url.endsWith('/repos/LibreChat-AI/code-interpreter/installation')) {
        return Response.json({ id: 222 });
      }
      const installation = /\/app\/installations\/(\d+)\/access_tokens$/.exec(url)?.[1];
      if (installation) {
        return Response.json(
          {
            token: `ghs_${installation}_abcdefghijklmnopqrstuvwxyz`,
            expires_at: '2030-01-01T01:00:00Z',
          },
          { status: 201 },
        );
      }
      return Response.json({}, { status: 404 });
    }) as typeof fetch,
  });

  await provider.validate();
  const [personal, organization] = await Promise.all([
    provider.getCredential(undefined, 'danny-avila/LibreChat'),
    provider.getCredential(undefined, 'LibreChat-AI/code-interpreter'),
  ]);
  assert.equal(
    (await provider.getCredential(undefined, 'danny-avila/LibreChat')).value,
    personal.value,
  );
  assert.equal(personal.value, 'ghs_111_abcdefghijklmnopqrstuvwxyz');
  assert.equal(organization.value, 'ghs_222_abcdefghijklmnopqrstuvwxyz');
  assert.deepEqual(personal.actor, {
    name: 'lia-by-librechat[bot]',
    email:
      '328778573+lia-by-librechat[bot]@users.noreply.github.com',
  });
  assert.equal(
    calls.filter(call => call.url.includes('/repos/danny-avila/')).length,
    1,
  );
  assert.deepEqual(
    calls
      .filter(call => call.url.endsWith('/access_tokens'))
      .map(call => JSON.parse(call.body ?? '{}'))
      .map(body => body.repositories[0])
      .sort(),
    [
      'LibreChat',
      'code-interpreter',
    ],
  );
});

test('keeps a shared token refresh alive when one waiter is cancelled', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'librechat-code-github-cancel-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const privateKeyPath = join(directory, 'app.pem');
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  await writeFile(
    privateKeyPath,
    privateKey.export({ type: 'pkcs8', format: 'pem' }),
    { mode: 0o600 },
  );
  let releaseToken!: (response: Response) => void;
  const tokenResponse = new Promise<Response>(resolve => {
    releaseToken = resolve;
  });
  let mintCount = 0;
  const provider = new GitHubAppCredentialProvider({
    appId: '123',
    privateKeyPath,
    now: () => new Date('2030-01-01T00:00:00Z'),
    fetch: (async (input) => {
      const url = String(input);
      if (url.endsWith('/app')) return Response.json({ slug: 'lia' });
      if (url.endsWith('/users/lia%5Bbot%5D')) {
        return Response.json({ id: 1234, login: 'lia[bot]', type: 'Bot' });
      }
      if (url.endsWith('/repos/acme/project/installation')) {
        return Response.json({ id: 111 });
      }
      if (url.endsWith('/app/installations/111/access_tokens')) {
        mintCount += 1;
        return tokenResponse;
      }
      return Response.json({}, { status: 404 });
    }) as typeof fetch,
  });
  await provider.validate();
  const firstController = new AbortController();
  const first = provider.getCredential(
    firstController.signal,
    'acme/project',
  );
  const second = provider.getCredential(undefined, 'acme/project');
  firstController.abort(new Error('first command cancelled'));
  await assert.rejects(first, /first command cancelled/);
  const third = provider.getCredential(undefined, 'acme/project');
  releaseToken(
    Response.json({
      token: 'ghs_shared_abcdefghijklmnopqrstuvwxyz',
      expires_at: '2030-01-01T01:00:00Z',
    }),
  );
  assert.equal(
    (await second).value,
    'ghs_shared_abcdefghijklmnopqrstuvwxyz',
  );
  assert.equal((await third).value, 'ghs_shared_abcdefghijklmnopqrstuvwxyz');
  assert.equal(mintCount, 1);
});

test('refreshes a cached repository installation after App reinstallation', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'librechat-code-github-reinstall-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const privateKeyPath = join(directory, 'app.pem');
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  await writeFile(
    privateKeyPath,
    privateKey.export({ type: 'pkcs8', format: 'pem' }),
    { mode: 0o600 },
  );
  let now = new Date('2030-01-01T00:00:00Z');
  let lookupCount = 0;
  let oldMintCount = 0;
  const provider = new GitHubAppCredentialProvider({
    appId: '123',
    privateKeyPath,
    now: () => now,
    fetch: (async (input) => {
      const url = String(input);
      if (url.endsWith('/app')) return Response.json({ slug: 'lia' });
      if (url.endsWith('/users/lia%5Bbot%5D')) {
        return Response.json({ id: 1234, login: 'lia[bot]', type: 'Bot' });
      }
      if (url.endsWith('/repos/acme/project/installation')) {
        lookupCount += 1;
        return Response.json({ id: lookupCount === 1 ? 111 : 222 });
      }
      if (url.endsWith('/app/installations/111/access_tokens')) {
        oldMintCount += 1;
        return oldMintCount === 1
          ? Response.json({
              token: 'ghs_old_abcdefghijklmnopqrstuvwxyz',
              expires_at: '2030-01-01T01:00:00Z',
            })
          : Response.json({}, { status: 404 });
      }
      if (url.endsWith('/app/installations/222/access_tokens')) {
        return Response.json({
          token: 'ghs_new_abcdefghijklmnopqrstuvwxyz',
          expires_at: '2030-01-01T02:00:00Z',
        });
      }
      return Response.json({}, { status: 404 });
    }) as typeof fetch,
  });
  await provider.validate();
  assert.equal(
    (await provider.getCredential(undefined, 'acme/project')).value,
    'ghs_old_abcdefghijklmnopqrstuvwxyz',
  );
  now = new Date('2030-01-01T00:56:00Z');
  assert.equal(
    (await provider.getCredential(undefined, 'acme/project')).value,
    'ghs_new_abcdefghijklmnopqrstuvwxyz',
  );
  assert.equal(lookupCount, 2);
});

test('validates a configured fixed installation by minting its token', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'librechat-code-github-fixed-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const privateKeyPath = join(directory, 'app.pem');
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  await writeFile(
    privateKeyPath,
    privateKey.export({ type: 'pkcs8', format: 'pem' }),
    { mode: 0o600 },
  );
  let minted = false;
  const provider = new GitHubAppCredentialProvider({
    appId: '123',
    installationId: '456',
    privateKeyPath,
    now: () => new Date('2030-01-01T00:00:00Z'),
    fetch: (async (input) => {
      const url = String(input);
      if (url.endsWith('/app')) return Response.json({ slug: 'lia' });
      if (url.endsWith('/users/lia%5Bbot%5D')) {
        return Response.json({ id: 1234, login: 'lia[bot]', type: 'Bot' });
      }
      if (url.endsWith('/app/installations/456/access_tokens')) {
        minted = true;
        return Response.json({
          token: 'ghs_fixed_abcdefghijklmnopqrstuvwxyz',
          expires_at: '2030-01-01T01:00:00Z',
        });
      }
      return Response.json({}, { status: 404 });
    }) as typeof fetch,
  });
  await provider.validate();
  assert.equal(minted, true);
});

test('discovers the GitHub repository from a command working directory', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'librechat-code-github-repo-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  execFileSync('git', ['init', directory]);
  execFileSync('git', [
    '-C',
    directory,
    'remote',
    'add',
    'origin',
    'git@github.com:LibreChat-AI/code-interpreter.git',
  ]);
  assert.equal(
    await gitHubRepositoryForDirectory(directory),
    'LibreChat-AI/code-interpreter',
  );
  assert.equal(
    await gitHubRepositoryForDirectory(directory, 'github.example.test'),
    undefined,
  );
  execFileSync('git', [
    '-C',
    directory,
    'remote',
    'set-url',
    'origin',
    'https://github.example.test:8443/acme/project.git',
  ]);
  assert.equal(
    await gitHubRepositoryForDirectory(directory, 'github.example.test'),
    'acme/project',
  );
});

test('keeps repository authorization bound to the admitted workspace root', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'librechat-code-github-binding-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const nested = join(directory, 'packages', 'app');
  await mkdir(nested, { recursive: true });
  execFileSync('git', ['init', directory]);
  execFileSync('git', [
    '-C',
    directory,
    'remote',
    'add',
    'origin',
    'git@github.com:acme/allowed.git',
  ]);
  const admitted = new Map([
    [directory, await gitHubRepositoryForDirectory(directory)],
  ]);
  execFileSync('git', [
    '-C',
    directory,
    'remote',
    'set-url',
    'origin',
    'git@github.com:acme/not-authorized.git',
  ]);
  assert.equal(
    gitHubRepositoryForAdmittedDirectory(nested, admitted),
    'acme/allowed',
  );
  assert.equal(
    gitHubRepositoryForAdmittedDirectory(dirname(directory), admitted),
    undefined,
  );
});

test('checkout routing follows nested repositories only inside an admitted root', async (t) => {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), 'librechat-code-github-checkout-')),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const nested = join(directory, 'worktrees', 'other');
  await mkdir(nested, { recursive: true });
  execFileSync('git', ['init', directory]);
  execFileSync('git', [
    '-C', directory, 'remote', 'add', 'origin', 'git@github.com:acme/outer.git',
  ]);
  execFileSync('git', ['init', nested]);
  execFileSync('git', [
    '-C', nested, 'remote', 'add', 'origin', 'git@github.com:acme/inner.git',
  ]);
  const admitted = new Map([[directory, 'acme/outer']]);

  assert.equal(
    await gitHubRepositoryForCommand(nested, admitted, 'admitted'),
    'acme/outer',
  );
  assert.equal(
    await gitHubRepositoryForCommand(nested, admitted, 'checkout'),
    'acme/inner',
  );
  execFileSync('git', [
    '-C', nested, 'remote', 'set-url', 'origin', 'git@github.com:acme/changed.git',
  ]);
  assert.equal(
    await gitHubRepositoryForCommand(nested, admitted, 'checkout'),
    'acme/changed',
  );
  assert.equal(
    await gitHubRepositoryForCommand(dirname(directory), admitted, 'checkout'),
    undefined,
  );
  const outside = await realpath(
    await mkdtemp(join(tmpdir(), 'librechat-code-github-outside-')),
  );
  t.after(() => rm(outside, { recursive: true, force: true }));
  execFileSync('git', ['init', outside]);
  execFileSync('git', [
    '-C', outside, 'remote', 'add', 'origin', 'git@github.com:acme/outside.git',
  ]);
  const escaped = join(directory, 'worktrees', 'escaped');
  await symlink(outside, escaped);
  assert.equal(
    await gitHubRepositoryForCommand(escaped, admitted, 'checkout'),
    undefined,
  );
  admitted.set(outside, 'acme/outside');
  assert.equal(
    await gitHubRepositoryForCommand(escaped, admitted, 'checkout'),
    undefined,
  );
  assert.equal(
    await gitHubRepositoryForCommand(nested, admitted, 'checkout', 'github.example.test'),
    undefined,
  );

  const linked = join(directory, 'worktrees', 'linked');
  execFileSync('git', [
    '-C', nested, '-c', 'user.name=Test', '-c', 'user.email=test@example.com',
    'commit', '--allow-empty', '-m', 'initial',
  ]);
  execFileSync('git', ['-C', nested, 'worktree', 'add', '--detach', linked]);
  assert.equal(
    await gitHubRepositoryForCommand(linked, admitted, 'checkout'),
    'acme/changed',
  );
  admitted.set(linked, 'acme/linked');
  assert.equal(
    await gitHubRepositoryForCommand(linked, admitted, 'admitted'),
    'acme/linked',
  );
});

test('uses the configured GHES host for the App bot no-reply identity', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'librechat-code-ghes-identity-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const privateKeyPath = join(directory, 'app.pem');
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  await writeFile(
    privateKeyPath,
    privateKey.export({ type: 'pkcs8', format: 'pem' }),
    { mode: 0o600 },
  );
  const provider = new GitHubAppCredentialProvider({
    appId: '123',
    installationId: '456',
    privateKeyPath,
    host: 'github.example.test',
    now: () => new Date('2030-01-01T00:00:00Z'),
    fetch: (async (input) => {
      const url = String(input);
      if (url.endsWith('/app')) return Response.json({ slug: 'lia' });
      if (url.endsWith('/users/lia%5Bbot%5D')) {
        return Response.json({ id: 1234, login: 'lia[bot]', type: 'Bot' });
      }
      if (url.endsWith('/app/installations/456/access_tokens')) {
        return Response.json({
          token: 'ghs_enterprise_abcdefghijklmnopqrstuvwxyz',
          expires_at: '2030-01-01T01:00:00Z',
        });
      }
      return Response.json({}, { status: 404 });
    }) as typeof fetch,
  });
  await provider.validate();
  const credential = await provider.getCredential();
  assert.deepEqual(credential.actor, {
    name: 'lia[bot]',
    email: '1234+lia[bot]@users.noreply.github.example.test',
  });
  const wrapped = wrapGitHubCredentialCommand(
    'git commit -m test',
    'github.example.test',
    'linux',
    gitHubCommandCredentialEnvironment(credential, 'github.example.test'),
  );
  assert.match(
    wrapped,
    /user\.email=1234\+lia\[bot\]@users\.noreply\.github\.example\.test/,
  );
});

test('builds process-scoped Git HTTPS authorization without embedding credentials in URLs', async () => {
  const provider = new StaticGitHubCredentialProvider(
    'github_pat_abcdefghijklmnopqrstuvwxyz',
  );
  const encodedCredential = Buffer.from(
    'x-access-token:github_pat_abcdefghijklmnopqrstuvwxyz',
    'utf8',
  ).toString('base64');
  assert.deepEqual(
    gitHubCredentialEnvironment(await provider.getCredential()),
    {
      [GITHUB_CREDENTIAL_ENV_NAME]: encodedCredential,
    },
  );
  assert.ok(!encodedCredential.includes('github_pat_'));
});

test('adds a GitHub CLI token only to the command-sandbox credential bundle', async () => {
  const provider = new StaticGitHubCredentialProvider(
    'github_pat_abcdefghijklmnopqrstuvwxyz',
  );
  const credential = await provider.getCredential();
  assert.deepEqual(gitHubCommandCredentialEnvironment(credential), {
    [GITHUB_CREDENTIAL_ENV_NAME]: Buffer.from(
      'x-access-token:github_pat_abcdefghijklmnopqrstuvwxyz',
      'utf8',
    ).toString('base64'),
    GH_TOKEN: 'github_pat_abcdefghijklmnopqrstuvwxyz',
  });
  assert.deepEqual(
    gitHubCommandCredentialEnvironment(credential, 'github.example.test'),
    {
      [GITHUB_CREDENTIAL_ENV_NAME]: Buffer.from(
        'x-access-token:github_pat_abcdefghijklmnopqrstuvwxyz',
        'utf8',
      ).toString('base64'),
      GH_ENTERPRISE_TOKEN: 'github_pat_abcdefghijklmnopqrstuvwxyz',
    },
  );
});

test('binds Git commits to the GitHub App bot identity', () => {
  const environment = gitHubCommandCredentialEnvironment({
    value: 'ghs_abcdefghijklmnopqrstuvwxyz',
    actor: {
      name: 'lia-by-librechat[bot]',
      email:
        '328778573+lia-by-librechat[bot]@users.noreply.github.com',
    },
  });
  assert.equal(environment[GITHUB_AUTHOR_NAME_ENV_NAME], 'lia-by-librechat[bot]');
  assert.equal(
    environment[GITHUB_AUTHOR_EMAIL_ENV_NAME],
    '328778573+lia-by-librechat[bot]@users.noreply.github.com',
  );
  const variables = gitHubMaskedCredentialVariables('github.com');
  assert.ok(!variables.some(variable => variable.name === GITHUB_AUTHOR_NAME_ENV_NAME));
  assert.ok(!variables.some(variable => variable.name === GITHUB_AUTHOR_EMAIL_ENV_NAME));
  const wrapped = wrapGitHubCredentialCommand(
    'git commit -m test',
    'github.com',
    'linux',
    environment,
  );
  assert.match(wrapped, /user\.name=/);
  assert.match(wrapped, /user\.email=/);
});

test('records the canonical App bot as Git author and committer', async (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX command wrapper integration is unavailable on Windows');
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), 'librechat-code-github-author-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  execFileSync('git', ['init', directory]);
  const environment = gitHubCommandCredentialEnvironment({
    value: 'ghs_abcdefghijklmnopqrstuvwxyz',
    actor: {
      name: 'lia-by-librechat[bot]',
      email:
        '328778573+lia-by-librechat[bot]@users.noreply.github.com',
    },
  });
  const wrapped = wrapGitHubCredentialCommand(
    'git commit --allow-empty -m test',
    'github.com',
    process.platform,
    environment,
  );
  execFileSync('/bin/bash', ['-lc', wrapped], {
    cwd: directory,
    env: { PATH: process.env.PATH, ...environment },
  });
  assert.equal(
    execFileSync(
      'git',
      [
        '-C',
        directory,
        'show',
        '-s',
        '--format=%an|%ae|%cn|%ce',
        'HEAD',
      ],
      { encoding: 'utf8' },
    ).trim(),
    'lia-by-librechat[bot]|328778573+lia-by-librechat[bot]@users.noreply.github.com|lia-by-librechat[bot]|328778573+lia-by-librechat[bot]@users.noreply.github.com',
  );
});

test('selects the GitHub CLI token variable for public and enterprise hosts', () => {
  assert.equal(gitHubCliTokenEnvironmentName('github.com'), 'GH_TOKEN');
  assert.equal(
    gitHubCliTokenEnvironmentName('github.example.test'),
    'GH_ENTERPRISE_TOKEN',
  );
});

test('restricts Git and GitHub CLI credential substitution to their respective hosts', () => {
  assert.deepEqual(gitHubMaskedCredentialVariables('github.com'), [
    {
      name: GITHUB_CREDENTIAL_ENV_NAME,
      extract: '^(.+)$',
      injectHosts: ['github.com'],
    },
    {
      name: 'GH_TOKEN',
      extract: '^(.+)$',
      injectHosts: ['api.github.com'],
    },
  ]);
  assert.deepEqual(gitHubMaskedCredentialVariables('github.example.test'), [
    {
      name: GITHUB_CREDENTIAL_ENV_NAME,
      extract: '^(.+)$',
      injectHosts: ['github.example.test'],
    },
    {
      name: 'GH_ENTERPRISE_TOKEN',
      extract: '^(.+)$',
      injectHosts: ['github.example.test'],
    },
  ]);
});

test('composes the masked credential with SRT Git configuration inside the sandbox', () => {
  const wrapped = wrapGitHubCredentialCommand(
    'git push',
    'github.com',
    'darwin',
    {
      [GITHUB_CREDENTIAL_ENV_NAME]: 'masked-authorization',
    },
  );
  assert.match(wrapped, /http\.proxyAuthMethod=basic/);
  assert.match(wrapped, /http\.https:\/\/github\.com\/\.extraheader/);
  assert.match(wrapped, /\$\{LIBRECHAT_CODE_GITHUB_AUTHORIZATION\}/);
  assert.match(wrapped, /unset LIBRECHAT_CODE_GITHUB_AUTHORIZATION/);
  assert.doesNotMatch(wrapped, /unset GH_TOKEN/);
  assert.equal(wrapped.match(/Authorization: Basic/g)?.length, 1);
  assert.ok(!wrapped.includes('github_pat_'));
});

test('omits Git authorization when repository routing resolves no credential', () => {
  const wrapped = wrapGitHubCredentialCommand(
    'git clone https://github.com/LibreChat-AI/LibreChat.git',
    'github.com',
    'linux',
    {},
  );
  assert.doesNotMatch(wrapped, /Authorization: Basic/);
});

test('targets GitHub CLI at an enterprise host without exposing its token', () => {
  const wrapped = wrapGitHubCredentialCommand(
    'gh pr create',
    'github.example.test',
    'linux',
  );
  assert.match(wrapped, /GH_HOST=github\.example\.test/);
  assert.doesNotMatch(wrapped, /GH_ENTERPRISE_TOKEN=/);
});

test('rejects an insecure GitHub App API endpoint before reading the private key', () => {
  assert.throws(
    () =>
      new GitHubAppCredentialProvider({
        appId: '123',
        installationId: '456',
        privateKeyPath: '/does/not/matter',
        apiUrl: 'http://github.example.test/api/v3',
      }),
    /must be an HTTPS URL/,
  );
});

test('rejects a GitHub App key in a shared writable directory', async (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX directory permissions are unavailable on Windows');
    return;
  }
  const root = await mkdtemp(join(tmpdir(), 'librechat-code-github-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'shared');
  await mkdir(directory, { mode: 0o700 });
  const privateKeyPath = join(directory, 'app.pem');
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  await writeFile(
    privateKeyPath,
    privateKey.export({ type: 'pkcs8', format: 'pem' }),
    { mode: 0o600 },
  );
  await chmod(directory, 0o777);
  const provider = new GitHubAppCredentialProvider({
    appId: '123',
    installationId: '456',
    privateKeyPath,
  });

  await assert.rejects(
    provider.getCredential(),
    /writable by other accounts/,
  );
});

test('rejects a symlinked GitHub App key without reopening its target', async (t) => {
  if (process.platform === 'win32') {
    t.skip('O_NOFOLLOW is unavailable on Windows');
    return;
  }
  const root = await mkdtemp(join(tmpdir(), 'librechat-code-github-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = join(root, 'target.pem');
  const link = join(root, 'app.pem');
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  await writeFile(target, privateKey.export({ type: 'pkcs8', format: 'pem' }), {
    mode: 0o600,
  });
  await symlink(target, link);
  const provider = new GitHubAppCredentialProvider({
    appId: '123',
    installationId: '456',
    privateKeyPath: link,
  });

  await assert.rejects(provider.getCredential(), /ELOOP|symbolic link/i);
});

test('allows the GitHub LFS object delivery hosts', () => {
  assert.ok(GITHUB_ALLOWED_DOMAINS.includes('objects.githubusercontent.com'));
  assert.ok(GITHUB_ALLOWED_DOMAINS.includes('*.githubusercontent.com'));
  assert.ok(GITHUB_ALLOWED_DOMAINS.includes('github-cloud.s3.amazonaws.com'));
});

test('App JWT requests use the resolved public or enterprise endpoint', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'github-endpoint-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const privateKeyPath = join(directory, 'app.pem');
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  await writeFile(privateKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  for (const [host, apiUrl, expected] of [
    [undefined, undefined, 'https://api.github.com'],
    ['GitHub.COM', undefined, 'https://api.github.com'],
    ['GitHub.Example.Test', undefined, 'https://github.example.test/api/v3'],
    [undefined, 'https://github.example.test/api/v3/', 'https://github.example.test/api/v3'],
    ['github.example.test', 'https://github.example.test:8443/custom/api/', 'https://github.example.test:8443/custom/api'],
  ]) {
    let calls = 0;
    const provider = new GitHubAppCredentialProvider({
      appId: '123', installationId: '456', privateKeyPath, host, apiUrl,
      now: () => new Date('2030-01-01T00:00:00Z'),
      fetch: async (input, init) => {
        calls++;
        const url = String(input);
        assert.equal(init?.redirect, 'error');
        const authorization = new Headers(init?.headers).get('authorization');
        if (url === `${expected}/app`) {
          assert.match(authorization!, /^Bearer eyJ/);
          return Response.json({ slug: 'lia' });
        }
        if (url === `${expected}/app/installations/456/access_tokens`) {
          assert.equal(init?.method, 'POST');
          assert.match(authorization!, /^Bearer eyJ/);
          return new Response(JSON.stringify({ token: 'ghs_abcdefghijklmnopqrstuvwxyz', expires_at: '2030-01-01T01:00:00Z' }), { status: 201 });
        }
        assert.equal(url, `${expected}/users/lia%5Bbot%5D`);
        assert.equal(authorization, 'Bearer ghs_abcdefghijklmnopqrstuvwxyz');
        return Response.json({ id: 1234, login: 'lia[bot]', type: 'Bot' });
      },
    });
    await provider.getCredential();
    await provider.getCredential();
    assert.equal(calls, 3);
  }
});

test('invalid or mismatched App endpoints are refused before any private key access', () => {
  for (const apiUrl of [
    'https://api.github.com', 'https://other.example.test/api/v3',
    'http://github.example.test/api/v3', 'https://user:password@github.example.test/api/v3',
    'https://github.example.test/api/v3?query=1', 'https://github.example.test/api/v3#fragment',
    'https://github.example.test/api/v3?', 'https://github.example.test/api/v3#',
  ]) {
    assert.throws(() => new GitHubAppCredentialProvider({
      appId: '123', installationId: '456', privateKeyPath: '/must-not-be-read',
      host: 'github.example.test', apiUrl,
    }), /must match|HTTPS URL without credentials|query or fragment/);
  }
});
