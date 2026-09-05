import { generateKeyPairSync } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GitHubAppCredentialProvider,
  StaticGitHubCredentialProvider,
  GITHUB_CREDENTIAL_ENV_NAME,
  gitHubCredentialEnvironment,
  wrapGitHubCredentialCommand,
} from './github.js';

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
