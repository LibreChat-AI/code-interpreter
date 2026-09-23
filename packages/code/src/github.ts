import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import { projectRemote } from './projects.js';
import { assertPrivateStorageAcl, assertPrivateStorageAncestors, assertPrivateStorageSupported } from './private-storage.js';

export const GITHUB_CREDENTIAL_ENV_NAME = 'LIBRECHAT_CODE_GITHUB_AUTHORIZATION';
export const GITHUB_AUTHOR_NAME_ENV_NAME = 'LIBRECHAT_CODE_GITHUB_AUTHOR_NAME';
export const GITHUB_AUTHOR_EMAIL_ENV_NAME = 'LIBRECHAT_CODE_GITHUB_AUTHOR_EMAIL';
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
  actor?: {
    name: string;
    email: string;
  };
}

export interface GitHubCredentialProvider {
  getCredential(
    signal?: AbortSignal,
    repository?: string,
  ): Promise<GitHubCredential>;
  validate?(signal?: AbortSignal): Promise<void>;
}

export interface GitHubAppCredentialProviderOptions {
  appId: string;
  /** Legacy fixed installation. Omit to resolve the installation per repository. */
  installationId?: string;
  privateKeyPath: string;
  apiUrl?: string;
  /** Git HTTPS hostname; non-public hosts default to the GHES /api/v3 base. */
  host?: string;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
  platform?: NodeJS.Platform;
}

const execFileAsync = promisify(execFile);
const GITHUB_SHARED_REQUEST_TIMEOUT_MS = 30_000;

async function waitForShared<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const aborted = () => {
      try {
        signal.throwIfAborted();
      } catch (error) {
        reject(error);
      }
    };
    signal.addEventListener('abort', aborted, { once: true });
    void promise.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', aborted);
    });
  });
}

function repositoryName(value: string): { owner: string; name: string } {
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(value);
  if (!match) throw new Error('GitHub repository must be owner/name');
  return { owner: match[1], name: match[2] };
}

/** Resolve only the repository containing the admitted command cwd. */
export async function gitHubRepositoryForDirectory(
  cwd: string,
  host = 'github.com',
  signal?: AbortSignal,
): Promise<string | undefined> {
  let remote: string;
  try {
    const result = await execFileAsync(
      'git',
      [
        '--no-optional-locks',
        '-C',
        cwd,
        '-c',
        'core.fsmonitor=false',
        'config',
        '--local',
        '--no-includes',
        '--get',
        'remote.origin.url',
      ],
      {
        env: {
          PATH: process.env.PATH,
          SYSTEMROOT: process.env.SYSTEMROOT,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_TERMINAL_PROMPT: '0',
          GIT_OPTIONAL_LOCKS: '0',
          LC_ALL: 'C',
        },
        encoding: 'utf8',
        maxBuffer: 4096,
        timeout: 1500,
        signal,
      },
    );
    remote = result.stdout.trim();
  } catch {
    signal?.throwIfAborted();
    return undefined;
  }
  const normalized = projectRemote(remote);
  if (!normalized) return undefined;
  const separator = normalized.indexOf('/');
  const remoteHost = normalized
    .slice(0, separator)
    .replace(/:[1-9][0-9]*$/, '');
  if (remoteHost !== normalizeGitHubHost(host)) {
    return undefined;
  }
  const repository = normalized.slice(separator + 1);
  repositoryName(repository);
  return repository;
}

function admittedRepositoryEntry(
  cwd: string,
  repositories: ReadonlyMap<string, string | undefined>,
): readonly [string, string | undefined] | undefined {
  let closest: readonly [string, string | undefined] | undefined;
  for (const entry of repositories) {
    const [root] = entry;
    const path = relative(root, cwd);
    if (
      path === '' ||
      (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
    ) {
      if (!closest || root.length > closest[0].length) closest = entry;
    }
  }
  return closest;
}

/** Return the startup-bound repository for the admitted root containing cwd. */
export function gitHubRepositoryForAdmittedDirectory(
  cwd: string,
  repositories: ReadonlyMap<string, string | undefined>,
): string | undefined {
  return admittedRepositoryEntry(cwd, repositories)?.[1];
}

/** Resolve a checkout repository only when its cwd remains inside an admitted root. */
export async function gitHubRepositoryForCommand(
  cwd: string,
  repositories: ReadonlyMap<string, string | undefined>,
  routing: 'admitted' | 'checkout',
  host = 'github.com',
  signal?: AbortSignal,
): Promise<string | undefined> {
  const admitted = admittedRepositoryEntry(cwd, repositories);
  if (!admitted) return undefined;
  if (routing === 'admitted') return admitted[1];
  let canonicalCwd: string;
  try {
    canonicalCwd = await realpath(cwd);
  } catch {
    signal?.throwIfAborted();
    return undefined;
  }
  if (admittedRepositoryEntry(canonicalCwd, repositories)?.[0] !== admitted[0]) {
    return undefined;
  }
  return gitHubRepositoryForDirectory(canonicalCwd, host, signal);
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
  assertPrivateStorageSupported();
  await assertPrivateStorageAncestors(dirname(path));

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
    await assertPrivateStorageAcl(handle, path);
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
  private readonly cached = new Map<string, GitHubCredential>();
  private readonly inFlight = new Map<string, Promise<GitHubCredential>>();
  private readonly installationIds = new Map<string, string>();
  private appLogin?: string;
  private appLoginInFlight?: Promise<string>;
  private actor?: GitHubCredential['actor'];
  private actorInFlight?: Promise<NonNullable<GitHubCredential['actor']>>;
  private readonly apiUrl: string;
  private readonly host: string;

  constructor(private readonly options: GitHubAppCredentialProviderOptions) {
    if ((options.platform ?? process.platform) === 'win32') {
      throw new Error(
        'GitHub App authentication is unavailable on native Windows because private key ACLs cannot be validated securely; use a token or WSL2',
      );
    }
    assertPositiveIdentifier('GitHub App ID', options.appId);
    if (options.installationId != null) {
      assertPositiveIdentifier(
        'GitHub App installation ID',
        options.installationId,
      );
    }
    const host = options.host == null ? undefined : normalizeGitHubHost(options.host);
    const apiUrl = new URL(options.apiUrl ?? (
      host != null && host !== 'github.com'
        ? `https://${host}/api/v3`
        : 'https://api.github.com'
    ));
    if (apiUrl.protocol !== 'https:' || apiUrl.username || apiUrl.password) {
      throw new Error('GitHub API URL must be an HTTPS URL without credentials');
    }
    if (/[?#]/.test(apiUrl.href)) {
      throw new Error('GitHub API URL must not contain a query or fragment');
    }
    const apiHost = apiUrl.hostname === 'api.github.com' ? 'github.com' : apiUrl.hostname;
    if (host != null && host !== apiHost) {
      throw new Error('LIBRECHAT_CODE_GITHUB_HOST must match the GitHub App API hostname');
    }
    this.host = host ?? apiHost;
    this.apiUrl = apiUrl.href.replace(/\/+$/, '');
  }

  private async appJwt(now: Date): Promise<string> {
    const privateKey = await readPrivateKey(this.options.privateKeyPath);
    return createAppJwt(this.options.appId, privateKey, now);
  }

  private async request(
    path: string,
    jwt: string,
    signal?: AbortSignal,
    init?: RequestInit,
  ): Promise<Response> {
    const request = this.options.fetch ?? globalThis.fetch;
    return request(`${this.apiUrl}${path}`, {
      redirect: 'error',
      ...init,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${jwt}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...init?.headers,
      },
      signal,
    });
  }

  private async resolveAppLogin(
    jwt: string,
    signal?: AbortSignal,
  ): Promise<string> {
    if (this.appLogin) return this.appLogin;
    if (!this.appLoginInFlight) {
      const pending = (async () => {
        const sharedSignal = AbortSignal.timeout(
          GITHUB_SHARED_REQUEST_TIMEOUT_MS,
        );
        const appResponse = await this.request('/app', jwt, sharedSignal);
        if (!appResponse.ok) {
          throw new Error(
            `GitHub App identity request failed with status ${appResponse.status}`,
          );
        }
        const app = (await appResponse.json()) as { slug?: unknown };
        if (
          typeof app.slug !== 'string' ||
          !/^[A-Za-z0-9-]+$/.test(app.slug)
        ) {
          throw new Error('GitHub App identity response is invalid');
        }
        return `${app.slug}[bot]`;
      })();
      this.appLoginInFlight = pending;
      void pending.then(
        login => {
          this.appLogin = login;
          if (this.appLoginInFlight === pending) {
            this.appLoginInFlight = undefined;
          }
        },
        () => {
          if (this.appLoginInFlight === pending) {
            this.appLoginInFlight = undefined;
          }
        },
      );
    }
    return waitForShared(this.appLoginInFlight, signal);
  }

  private async resolveActor(
    jwt: string,
    installationToken: string,
    signal?: AbortSignal,
  ): Promise<NonNullable<GitHubCredential['actor']>> {
    if (this.actor) return this.actor;
    if (!this.actorInFlight) {
      const pending = (async () => {
        const sharedSignal = AbortSignal.timeout(
          GITHUB_SHARED_REQUEST_TIMEOUT_MS,
        );
        const login = await this.resolveAppLogin(jwt, sharedSignal);
        const userResponse = await this.request(
          `/users/${encodeURIComponent(login)}`,
          installationToken,
          sharedSignal,
        );
        if (!userResponse.ok) {
          throw new Error(
            `GitHub App bot identity request failed with status ${userResponse.status}`,
          );
        }
        const user = (await userResponse.json()) as {
          id?: unknown;
          login?: unknown;
          type?: unknown;
        };
        if (
          !Number.isSafeInteger(user.id) ||
          Number(user.id) <= 0 ||
          user.login !== login ||
          user.type !== 'Bot'
        ) {
          throw new Error('GitHub App bot identity response is invalid');
        }
        return {
          name: login,
          email: `${user.id}+${login}@users.noreply.${this.host}`,
        };
      })();
      this.actorInFlight = pending;
      void pending.then(
        actor => {
          this.actor = actor;
          if (this.actorInFlight === pending) this.actorInFlight = undefined;
        },
        () => {
          if (this.actorInFlight === pending) this.actorInFlight = undefined;
        },
      );
    }
    return waitForShared(this.actorInFlight, signal);
  }

  async validate(signal?: AbortSignal): Promise<void> {
    const now = (this.options.now ?? (() => new Date()))();
    const jwt = await this.appJwt(now);
    await this.resolveAppLogin(jwt, signal);
    if (this.options.installationId) {
      await this.getCredential(signal);
    }
  }

  private async resolveInstallationId(
    repository: string,
    jwt: string,
    signal?: AbortSignal,
  ): Promise<string> {
    if (this.options.installationId) return this.options.installationId;
    const cached = this.installationIds.get(repository);
    if (cached) return cached;
    const { owner, name } = repositoryName(repository);
    const response = await this.request(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/installation`,
      jwt,
      signal,
    );
    if (!response.ok) {
      throw new Error(
        response.status === 404
          ? `GitHub App is not installed for ${repository}`
          : `GitHub App installation lookup failed with status ${response.status}`,
      );
    }
    const body = (await response.json()) as { id?: unknown };
    if (!Number.isSafeInteger(body.id) || Number(body.id) <= 0) {
      throw new Error('GitHub App installation response is invalid');
    }
    const installationId = String(body.id);
    this.installationIds.set(repository, installationId);
    return installationId;
  }

  async getCredential(
    signal?: AbortSignal,
    repository?: string,
  ): Promise<GitHubCredential> {
    signal?.throwIfAborted();
    if (!this.options.installationId && !repository) {
      throw new Error(
        'GitHub App authentication requires a GitHub repository for this command',
      );
    }
    if (repository) repositoryName(repository);
    const now = (this.options.now ?? (() => new Date()))();
    const key = this.options.installationId ?? repository!;
    const cached = this.cached.get(key);
    if (
      cached?.expiresAt != null &&
      cached.expiresAt.getTime() - now.getTime() > 5 * 60_000
    ) {
      return cached;
    }
    const existing = this.inFlight.get(key);
    if (existing) return waitForShared(existing, signal);
    const pending = (async () => {
      const sharedSignal = AbortSignal.timeout(
        GITHUB_SHARED_REQUEST_TIMEOUT_MS,
      );
      const jwt = await this.appJwt(now);
      const scopedRepository = repository
        ? repositoryName(repository).name
        : undefined;
      const installationId = await this.resolveInstallationId(
        repository ?? '',
        jwt,
        sharedSignal,
      );
      let response = await this.request(
        `/app/installations/${installationId}/access_tokens`,
        jwt,
        sharedSignal,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          ...(this.options.installationId
            ? {}
            : { body: JSON.stringify({ repositories: [scopedRepository] }) }),
        },
      );
      if (!this.options.installationId && response.status === 404) {
        this.installationIds.delete(repository!);
        const refreshedInstallationId = await this.resolveInstallationId(
          repository!,
          jwt,
          sharedSignal,
        );
        response = await this.request(
          `/app/installations/${refreshedInstallationId}/access_tokens`,
          jwt,
          sharedSignal,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ repositories: [scopedRepository] }),
          },
        );
      }
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
      const actor = await this.resolveActor(
        jwt,
        body.token,
        sharedSignal,
      );
      const credential = {
        value: body.token,
        expiresAt,
        actor,
      };
      this.cached.set(key, credential);
      return credential;
    })();
    this.inFlight.set(key, pending);
    const clearPending = () => {
      if (this.inFlight.get(key) === pending) this.inFlight.delete(key);
    };
    void pending.then(clearPending, clearPending);
    return waitForShared(pending, signal);
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
    [GITHUB_CREDENTIAL_ENV_NAME]: Buffer.from(
      `x-access-token:${credential.value}`,
      'utf8',
    ).toString('base64'),
  };
}

export function gitHubCommandCredentialEnvironment(
  credential: GitHubCredential,
  host = 'github.com',
): Record<string, string> {
  return {
    ...gitHubCredentialEnvironment(credential),
    [gitHubCliTokenEnvironmentName(host)]: credential.value,
    ...(credential.actor
      ? {
          [GITHUB_AUTHOR_NAME_ENV_NAME]: credential.actor.name,
          [GITHUB_AUTHOR_EMAIL_ENV_NAME]: credential.actor.email,
        }
      : {}),
  };
}

export function gitHubCliTokenEnvironmentName(host: string): string {
  return host === 'github.com' ? 'GH_TOKEN' : 'GH_ENTERPRISE_TOKEN';
}

export function gitHubApiHost(host: string): string {
  return host === 'github.com' ? 'api.github.com' : host;
}

export function gitHubMaskedCredentialVariables(host: string): Array<{
  name: string;
  injectHosts: string[];
  extract: string;
}> {
  return [
    {
      name: GITHUB_CREDENTIAL_ENV_NAME,
      extract: '^(.+)$',
      injectHosts: [host],
    },
    {
      name: gitHubCliTokenEnvironmentName(host),
      extract: '^(.+)$',
      injectHosts: [gitHubApiHost(host)],
    },
  ];
}

export function gitHubAuthenticationPolicyIdentity(options: {
  mode?: 'app' | 'token';
  host: string;
  appId?: string;
  installationId?: string;
  token?: string;
}): string {
  const identity = `github-auth:${options.mode ?? 'none'}:${options.host}`;
  if (options.mode === 'token') {
    if (!options.token) {
      throw new Error('GitHub token policy identity requires a token');
    }
    const fingerprint = createHash('sha256')
      .update('librechat-code-github-token-v1\0')
      .update(options.token)
      .digest('hex');
    return `${identity}:fingerprint:${fingerprint}`;
  }
  if (options.mode !== 'app') return identity;
  if (!options.appId) {
    throw new Error('GitHub App policy identity requires an App ID');
  }
  return `${identity}:app:${options.appId}:installation:${options.installationId ?? 'repository'}`;
}

export function normalizeGitHubHost(value: string): string {
  const host = value.toLowerCase();
  if (
    !/^[a-z0-9.-]+$/.test(host) ||
    host.startsWith('.') ||
    host.endsWith('.')
  ) {
    throw new Error('LIBRECHAT_CODE_GITHUB_HOST must be a DNS hostname');
  }
  return host;
}

export function wrapGitHubCredentialCommand(
  command: string,
  host = 'github.com',
  platform: NodeJS.Platform = process.platform,
  environment: Readonly<Record<string, string>> = {},
): string {
  const key = `http.https://${host}/.extraheader`;
  const cliHost = host === 'github.com' ? undefined : host;
  const hasCredential = Boolean(environment[GITHUB_CREDENTIAL_ENV_NAME]);
  const actorName = environment[GITHUB_AUTHOR_NAME_ENV_NAME];
  const actorEmail = environment[GITHUB_AUTHOR_EMAIL_ENV_NAME];
  const noReplyHost = `users.noreply.${normalizeGitHubHost(host)}`
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const hasActor =
    /^[A-Za-z0-9_.-]+\[bot\]$/.test(actorName ?? '') &&
    new RegExp(
      `^[1-9][0-9]+\\+[A-Za-z0-9_.-]+\\[bot\\]@${noReplyHost}$`,
    ).test(actorEmail ?? '');
  if (platform === 'win32') {
    return [
      'set "GIT_CONFIG_GLOBAL=NUL"',
      'set "GIT_CONFIG_NOSYSTEM=1"',
      ...(cliHost ? [`set "GH_HOST=${cliHost}"`] : []),
      ...(hasCredential
        ? [`set "GIT_CONFIG_PARAMETERS='http.proxyAuthMethod=basic' '${key}=Authorization: Basic %${GITHUB_CREDENTIAL_ENV_NAME}%'"`]
        : ['set "GIT_CONFIG_PARAMETERS="']),
      ...(hasActor
        ? [`set "GIT_CONFIG_PARAMETERS=%GIT_CONFIG_PARAMETERS% 'user.name=${actorName}' 'user.email=${actorEmail}'"`]
        : []),
      `set "${GITHUB_CREDENTIAL_ENV_NAME}="`,
      `set "${GITHUB_AUTHOR_NAME_ENV_NAME}="`,
      `set "${GITHUB_AUTHOR_EMAIL_ENV_NAME}="`,
      command,
    ].join(' && ');
  }
  return [
    'export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1',
    ...(cliHost ? [`export GH_HOST=${cliHost}`] : []),
    ...(hasCredential
      ? [`export GIT_CONFIG_PARAMETERS="'http.proxyAuthMethod=basic' '${key}=Authorization: Basic \${${GITHUB_CREDENTIAL_ENV_NAME}}'"`]
      : ['export GIT_CONFIG_PARAMETERS=']),
    ...(hasActor
      ? [`export GIT_CONFIG_PARAMETERS="\${GIT_CONFIG_PARAMETERS} 'user.name=${actorName}' 'user.email=${actorEmail}'"`]
      : []),
    `unset ${GITHUB_CREDENTIAL_ENV_NAME}`,
    `unset ${GITHUB_AUTHOR_NAME_ENV_NAME} ${GITHUB_AUTHOR_EMAIL_ENV_NAME}`,
    command,
  ].join(';\n');
}
