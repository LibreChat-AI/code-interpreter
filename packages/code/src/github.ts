import { constants } from 'node:fs';
import { createPrivateKey, sign } from 'node:crypto';
import { open, realpath, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

export const GITHUB_CREDENTIAL_ENV_NAME = 'LIBRECHAT_CODE_GITHUB_AUTHORIZATION';
export const GITHUB_ALLOWED_DOMAINS = [
  'github.com',
  '*.github.com',
  'api.github.com',
  'lfs.github.com',
  'objects.githubusercontent.com',
  '*.githubusercontent.com',
  'github-cloud.s3.amazonaws.com',
] as const;

export interface GitHubCredential {
  value: string;
  expiresAt?: Date;
}

export interface GitHubCredentialProvider {
  getCredential(signal?: AbortSignal): Promise<GitHubCredential>;
}

export interface GitHubAppCredentialProviderOptions {
  appId: string;
  installationId: string;
  privateKeyPath: string;
  apiUrl?: string;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function assertPositiveIdentifier(name: string, value: string): void {
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new Error(`${name} must be a positive decimal identifier`);
  }
}

async function readPrivateKey(path: string): Promise<string> {
  if (process.platform !== 'win32') {
    const directory = await stat(await realpath(dirname(path)));
    const uid = process.getuid?.();
    if (uid !== undefined && directory.uid !== uid && directory.uid !== 0) {
      throw new Error(
        'GitHub App private key directory must be owned by this user or root',
      );
    }
    const mode = directory.mode & 0o7777;
    const protectedByStickyBit =
      (mode & 0o1000) !== 0 && (directory.uid === uid || directory.uid === 0);
    if ((mode & 0o022) !== 0 && !protectedByStickyBit) {
      throw new Error(
        'GitHub App private key directory must not be writable by group or other users',
      );
    }
  }

  const handle = await open(
    path,
    constants.O_RDONLY |
      (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW),
  );
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      throw new Error('GitHub App private key must be a regular file');
    }
    const uid = process.getuid?.();
    if (uid !== undefined && metadata.uid !== uid && metadata.uid !== 0) {
      throw new Error(
        'GitHub App private key must be owned by this user or root',
      );
    }
    if (process.platform !== 'win32' && (metadata.mode & 0o077) !== 0) {
      throw new Error(
        'GitHub App private key must not be accessible by group or other users',
      );
    }
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

function createAppJwt(appId: string, privateKey: string, now: Date): string {
  const issuedAt = Math.floor(now.getTime() / 1000) - 60;
  const header = base64UrlJson({ alg: 'RS256', typ: 'JWT' });
  const payload = base64UrlJson({
    iss: appId,
    iat: issuedAt,
    exp: issuedAt + 600,
  });
  const unsigned = `${header}.${payload}`;
  const signature = sign(
    'RSA-SHA256',
    Buffer.from(unsigned),
    createPrivateKey(privateKey),
  );
  return `${unsigned}.${signature.toString('base64url')}`;
}

export class GitHubAppCredentialProvider implements GitHubCredentialProvider {
  private cached?: GitHubCredential;

  constructor(private readonly options: GitHubAppCredentialProviderOptions) {
    assertPositiveIdentifier('GitHub App ID', options.appId);
    assertPositiveIdentifier(
      'GitHub App installation ID',
      options.installationId,
    );
    if (options.apiUrl != null) {
      const apiUrl = new URL(options.apiUrl);
      if (apiUrl.protocol !== 'https:' || apiUrl.username || apiUrl.password) {
        throw new Error(
          'GitHub API URL must be an HTTPS URL without credentials',
        );
      }
    }
  }

  async getCredential(signal?: AbortSignal): Promise<GitHubCredential> {
    const now = (this.options.now ?? (() => new Date()))();
    if (
      this.cached?.expiresAt != null &&
      this.cached.expiresAt.getTime() - now.getTime() > 5 * 60_000
    ) {
      return this.cached;
    }
    const privateKey = await readPrivateKey(this.options.privateKeyPath);
    const jwt = createAppJwt(this.options.appId, privateKey, now);
    const apiUrl = (this.options.apiUrl ?? 'https://api.github.com').replace(
      /\/+$/,
      '',
    );
    const request = this.options.fetch ?? globalThis.fetch;
    const response = await request(
      `${apiUrl}/app/installations/${this.options.installationId}/access_tokens`,
      {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${jwt}`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal,
      },
    );
    if (!response.ok) {
      throw new Error(
        `GitHub App token request failed with status ${response.status}`,
      );
    }
    const body = (await response.json()) as {
      token?: unknown;
      expires_at?: unknown;
    };
    if (
      typeof body.token !== 'string' ||
      body.token.length < 20 ||
      typeof body.expires_at !== 'string'
    ) {
      throw new Error('GitHub App token response is invalid');
    }
    const expiresAt = new Date(body.expires_at);
    if (
      !Number.isFinite(expiresAt.getTime()) ||
      expiresAt.getTime() <= now.getTime()
    ) {
      throw new Error('GitHub App token expiry is invalid');
    }
    this.cached = { value: body.token, expiresAt };
    return this.cached;
  }
}

export class StaticGitHubCredentialProvider implements GitHubCredentialProvider {
  constructor(private readonly token: string) {
    if (token.trim().length < 20 || /[\0\r\n]/.test(token)) {
      throw new Error('GitHub token is invalid');
    }
  }

  async getCredential(): Promise<GitHubCredential> {
    return { value: this.token };
  }
}

export function gitHubCredentialEnvironment(
  credential: GitHubCredential,
): Record<string, string> {
  return {
    [GITHUB_CREDENTIAL_ENV_NAME]: credential.value,
  };
}

export function gitHubAuthenticationPolicyIdentity(options: {
  mode?: 'app' | 'token';
  host: string;
  appId?: string;
  installationId?: string;
}): string {
  const identity = `github-auth:${options.mode ?? 'none'}:${options.host}`;
  if (options.mode !== 'app') return identity;
  if (!options.appId || !options.installationId) {
    throw new Error(
      'GitHub App policy identity requires an App and installation ID',
    );
  }
  return `${identity}:app:${options.appId}:installation:${options.installationId}`;
}

export function wrapGitHubCredentialCommand(
  command: string,
  host = 'github.com',
  platform: NodeJS.Platform = process.platform,
): string {
  const key = `http.https://${host}/.extraheader`;
  if (platform === 'win32') {
    return [
      'set "GIT_CONFIG_GLOBAL=NUL"',
      'set "GIT_CONFIG_NOSYSTEM=1"',
      `set "GIT_CONFIG_PARAMETERS='http.proxyAuthMethod=basic' '${key}=Authorization: Bearer %${GITHUB_CREDENTIAL_ENV_NAME}%'"`,
      `set "${GITHUB_CREDENTIAL_ENV_NAME}="`,
      command,
    ].join(' && ');
  }
  return [
    'export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1',
    `export GIT_CONFIG_PARAMETERS="'http.proxyAuthMethod=basic' '${key}=Authorization: Bearer \${${GITHUB_CREDENTIAL_ENV_NAME}}'"`,
    `unset ${GITHUB_CREDENTIAL_ENV_NAME}`,
    command,
  ].join(';\n');
}
