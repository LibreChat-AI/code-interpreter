import { generateKeyPairSync } from 'node:crypto';
import {
  chmod,
  mkdtemp,
  mkdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GITHUB_ALLOWED_DOMAINS,
  GitHubAppCredentialProvider,
  StaticGitHubCredentialProvider,
  gitHubAuthenticationPolicyIdentity,
  GITHUB_CREDENTIAL_ENV_NAME,
  gitHubCredentialEnvironment,
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
  let calls = 0;
  const request = async (
    _input: string | URL | Request,
    init?: RequestInit,
  ) => {
    calls += 1;
    assert.match(
      String(new Headers(init?.headers).get('authorization')),
      /^Bearer eyJ/,
    );
    return new Response(
      JSON.stringify({
        token: 'ghs_abcdefghijklmnopqrstuvwxyz',
        expires_at: '2030-01-01T01:00:00Z',
      }),
      { status: 201 },
    );
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
  assert.equal(calls, 1);
});

test('builds process-scoped Git HTTPS authorization without embedding credentials in URLs', async () => {
  const provider = new StaticGitHubCredentialProvider(
    'github_pat_abcdefghijklmnopqrstuvwxyz',
  );
  assert.deepEqual(
    gitHubCredentialEnvironment(await provider.getCredential()),
    {
      [GITHUB_CREDENTIAL_ENV_NAME]: 'github_pat_abcdefghijklmnopqrstuvwxyz',
    },
  );
});

test('composes the masked credential with SRT Git configuration inside the sandbox', () => {
  const wrapped = wrapGitHubCredentialCommand(
    'git push',
    'github.com',
    'darwin',
  );
  assert.match(wrapped, /http\.proxyAuthMethod=basic/);
  assert.match(wrapped, /http\.https:\/\/github\.com\/\.extraheader/);
  assert.match(wrapped, /\$\{LIBRECHAT_CODE_GITHUB_AUTHORIZATION\}/);
  assert.match(wrapped, /unset LIBRECHAT_CODE_GITHUB_AUTHORIZATION/);
  assert.equal(wrapped.match(/Authorization: Bearer/g)?.length, 1);
  assert.ok(!wrapped.includes('github_pat_'));
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
        assert.equal(String(input), `${expected}/app/installations/456/access_tokens`);
        assert.equal(init?.method, 'POST');
        assert.equal(init?.redirect, 'error');
        assert.match(new Headers(init?.headers).get('authorization')!, /^Bearer eyJ/);
        return new Response(JSON.stringify({ token: 'ghs_abcdefghijklmnopqrstuvwxyz', expires_at: '2030-01-01T01:00:00Z' }), { status: 201 });
      },
    });
    await provider.getCredential();
    await provider.getCredential();
    assert.equal(calls, 1);
  }
});

test('invalid or mismatched App endpoints are refused before any private key access', () => {
  for (const apiUrl of [
    'https://api.github.com', 'https://other.example.test/api/v3',
    'http://github.example.test/api/v3', 'https://user:password@github.example.test/api/v3',
    'https://github.example.test/api/v3?query=1', 'https://github.example.test/api/v3#fragment',
  ]) {
    assert.throws(() => new GitHubAppCredentialProvider({
      appId: '123', installationId: '456', privateKeyPath: '/must-not-be-read',
      host: 'github.example.test', apiUrl,
    }), /must match|HTTPS URL without credentials|query or fragment/);
  }
});
