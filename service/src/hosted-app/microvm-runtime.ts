import {
  LambdaMicrovmApiError,
  microvmPortHeaders,
  type LambdaMicrovmClient,
  type MicrovmAuthToken,
  type MicrovmDescription,
} from '../runtime-session/lambda-client';
import {
  MicrovmOpThrottledError,
  acquireOpBudget,
  poisonOpBucket,
  type ThrottledOp,
} from '../runtime-session/throttle';
import type { ResidentHostedAppSpec } from './spec';
import { createHash } from 'node:crypto';

export interface HostedAppMicrovmConfig {
  imageArn: string;
  imageVersion: string;
  executionRoleArn?: string;
  logGroup?: string;
  ingressConnectorArns?: string[];
  controlPort: number;
  previewPort: number;
  maximumDurationSeconds: number;
  idleSeconds: number;
  suspendedSeconds: number;
  authTokenTtlSeconds: number;
  launchTimeoutMs: number;
  healthTimeoutMs: number;
  appStartTimeoutMs: number;
  launchTps: number;
  tokenTps: number;
}

/** Order-independent identity for every immutable app-host launch input. */
export function hostedAppLaunchFingerprint(config: HostedAppMicrovmConfig): string {
  return JSON.stringify({
    imageArn: config.imageArn,
    imageVersion: config.imageVersion,
    executionRoleArn: config.executionRoleArn ?? '',
    logGroup: config.logGroup ?? '',
    ingressConnectorArns: [...(config.ingressConnectorArns ?? [])].sort(),
    controlPort: config.controlPort,
    previewPort: config.previewPort,
    maximumDurationSeconds: config.maximumDurationSeconds,
    idlePolicy: {
      maxIdleSeconds: config.idleSeconds,
      suspendedSeconds: config.suspendedSeconds,
      autoResume: true,
    },
  });
}

/** Exact RunMicrovm request identity. Preserve connector order because AWS
 * idempotency compares the submitted request, not our semantic policy. */
export function hostedAppLaunchRequestFingerprint(config: HostedAppMicrovmConfig): string {
  return JSON.stringify({
    launchFingerprint: hostedAppLaunchFingerprint(config),
    runMicrovm: {
      imageIdentifier: config.imageArn,
      imageVersion: config.imageVersion,
      executionRoleArn: config.executionRoleArn,
      logGroup: config.logGroup,
      ingressConnectorArns: config.ingressConnectorArns,
      maximumDurationSeconds: config.maximumDurationSeconds,
      idlePolicy: {
        maxIdleSeconds: config.idleSeconds,
        suspendedSeconds: config.suspendedSeconds,
        autoResume: true,
      },
    },
  });
}

/** Keep reset Redis counters in an image/config-specific safe-integer range. */
export function hostedAppLaunchGenerationSeed(config: HostedAppMicrovmConfig): number {
  const offset = Number.parseInt(
    createHash('sha256')
      .update(hostedAppLaunchRequestFingerprint(config), 'utf8')
      .digest('hex')
      .slice(0, 13),
    16,
  );
  return 1_000_000_000_000_000 + offset;
}

export function hostedAppLaunchClientToken(runtimeId: string, generation: number): string {
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new Error('Hosted app generation must be a positive safe integer');
  }
  const token = `happ-${runtimeId}-${generation}`;
  /* launch() reserves a single `-r1` suffix after a definite boot failure. */
  if (token.length > 125) {
    throw new Error('Hosted app clientToken exceeds the AWS length limit');
  }
  return token;
}

export class HostedAppMicrovmError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly transient: boolean,
    readonly cause?: unknown,
    readonly httpStatus = 503,
  ) {
    super(message);
    this.name = 'HostedAppMicrovmError';
  }
}

interface HostedAppMicrovmDeps {
  reserveOp: (
    op: ThrottledOp,
    args: { limitPerSecond: number; deadlineAtMs: number; signal: AbortSignal },
  ) => Promise<void>;
  poisonOp: (op: ThrottledOp, deadlineAtMs: number, signal: AbortSignal) => Promise<void>;
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
}

const abortableSleep = (ms: number, signal: AbortSignal): Promise<void> => new Promise(
  (resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('operation aborted'));
      return;
    }
    const finish = (): void => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new Error('operation aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  },
);

export function normalizeHostedAppMicrovmEndpoint(endpoint: string): string {
  if (endpoint.startsWith('http://') || endpoint.startsWith('https://')) {
    return endpoint.replace(/\/+$/, '');
  }
  return `https://${endpoint.replace(/\/+$/, '')}`;
}

function launchFailure(error: unknown): HostedAppMicrovmError {
  if (error instanceof HostedAppMicrovmError) return error;
  if (error instanceof LambdaMicrovmApiError) {
    const transient = error.kind === 'throttled' || error.kind === 'other';
    return new HostedAppMicrovmError(
      error.kind === 'throttled' ? 'hosted_app_launch_throttled' : 'hosted_app_launch_failed',
      error.message,
      transient,
      error,
    );
  }
  return new HostedAppMicrovmError(
    'hosted_app_launch_failed',
    error instanceof Error ? error.message : 'Hosted app MicroVM launch failed',
    false,
    error,
  );
}

export class HostedAppMicrovmRuntime {
  private readonly deps: HostedAppMicrovmDeps;

  constructor(
    private readonly client: LambdaMicrovmClient,
    readonly config: HostedAppMicrovmConfig,
    deps: Partial<HostedAppMicrovmDeps> = {},
  ) {
    this.deps = {
      reserveOp: (op, args) => acquireOpBudget(op, {
        limitPerSecond: args.limitPerSecond,
        budgetMs: Math.max(1, args.deadlineAtMs - Date.now()),
        deadlineAtMs: args.deadlineAtMs,
        signal: args.signal,
      }),
      poisonOp: (op, deadlineAtMs, signal) => poisonOpBucket(op, undefined, {
        deadlineAtMs,
        signal,
      }),
      fetch,
      sleep: abortableSleep,
      ...deps,
    };
  }

  async launch(clientToken: string, callerSignal: AbortSignal): Promise<{
    vm: MicrovmDescription;
    clientToken: string;
  }> {
    const deadlineAtMs = Date.now() + this.config.launchTimeoutMs;
    const deadlineSignal = AbortSignal.timeout(this.config.launchTimeoutMs);
    const signal = AbortSignal.any([callerSignal, deadlineSignal]);
    try {
      const first = await this.launchOnce(clientToken, deadlineAtMs, signal, deadlineSignal);
      return { vm: first, clientToken };
    } catch (error) {
      const failure = deadlineSignal.aborted && !callerSignal.aborted
        ? new HostedAppMicrovmError(
          'hosted_app_launch_timeout',
          `Hosted app MicroVM did not reach RUNNING within ${this.config.launchTimeoutMs}ms`,
          true,
          error,
        )
        : launchFailure(error);
      /* Only a definite boot-time death is safe to retry with a new token.
       * Ambiguous RunMicrovm failures retain the original token so a successor
       * can replay and recover the provider resource. */
      if (failure.code !== 'hosted_app_boot_failed' || callerSignal.aborted) throw failure;
      const retryToken = `${clientToken}-r1`;
      const vm = await this.launchOnce(retryToken, deadlineAtMs, signal, deadlineSignal)
        .catch(second => { throw launchFailure(second); });
      return { vm, clientToken: retryToken };
    }
  }

  private async launchOnce(
    clientToken: string,
    deadlineAtMs: number,
    signal: AbortSignal,
    reconcileSignal: AbortSignal,
  ): Promise<MicrovmDescription> {
    try {
      await this.deps.reserveOp('run', {
        limitPerSecond: this.config.launchTps,
        deadlineAtMs,
        signal,
      });
    } catch (error) {
      if (error instanceof MicrovmOpThrottledError) {
        throw new HostedAppMicrovmError(
          'hosted_app_launch_throttled',
          error.message,
          true,
          error,
        );
      }
      throw error;
    }

    let vm: MicrovmDescription;
    try {
      vm = await this.client.runMicrovm({
        imageIdentifier: this.config.imageArn,
        imageVersion: this.config.imageVersion,
        executionRoleArn: this.config.executionRoleArn,
        logGroup: this.config.logGroup,
        ingressConnectorArns: this.config.ingressConnectorArns,
        /* No egress connector is passed. The app-host runner additionally
         * blocks all new OUTPUT traffic from the untrusted app UID. */
        maximumDurationSeconds: this.config.maximumDurationSeconds,
        idlePolicy: {
          maxIdleSeconds: this.config.idleSeconds,
          suspendedSeconds: this.config.suspendedSeconds,
          autoResume: true,
        },
        clientToken,
      }, signal, reconcileSignal);
    } catch (error) {
      if (error instanceof LambdaMicrovmApiError && error.kind === 'throttled') {
        await this.deps.poisonOp('run', deadlineAtMs, signal).catch(() => {});
      }
      throw error;
    }

    let current = vm;
    while (current.state === 'PENDING' || current.state === 'SUSPENDING') {
      if (Date.now() >= deadlineAtMs) {
        throw new HostedAppMicrovmError(
          'hosted_app_launch_timeout',
          'Hosted app MicroVM launch timed out',
          true,
        );
      }
      await this.deps.sleep(Math.min(250, Math.max(1, deadlineAtMs - Date.now())), signal);
      current = await this.client.getMicrovm(current.microvmId, signal);
    }
    if (current.state !== 'RUNNING' || !current.endpoint) {
      throw new HostedAppMicrovmError(
        'hosted_app_boot_failed',
        `Hosted app MicroVM entered ${current.state} before becoming ready`,
        true,
      );
    }
    return current;
  }

  async mintToken(
    microvmId: string,
    port: number,
    callerSignal: AbortSignal,
  ): Promise<MicrovmAuthToken> {
    const deadlineAtMs = Date.now() + this.config.launchTimeoutMs;
    const signal = AbortSignal.any([
      callerSignal,
      AbortSignal.timeout(this.config.launchTimeoutMs),
    ]);
    try {
      await this.deps.reserveOp('token', {
        limitPerSecond: this.config.tokenTps,
        deadlineAtMs,
        signal,
      });
      return await this.client.createMicrovmAuthToken({
        microvmId,
        port,
        ttlSeconds: this.config.authTokenTtlSeconds,
      }, signal);
    } catch (error) {
      if (error instanceof LambdaMicrovmApiError && error.kind === 'throttled') {
        await this.deps.poisonOp('token', deadlineAtMs, signal).catch(() => {});
      }
      throw new HostedAppMicrovmError(
        'hosted_app_auth_failed',
        error instanceof Error ? error.message : 'Could not authorize hosted app endpoint',
        true,
        error,
      );
    }
  }

  async waitForControlReady(vm: MicrovmDescription, callerSignal: AbortSignal): Promise<void> {
    const endpoint = normalizeHostedAppMicrovmEndpoint(vm.endpoint ?? '');
    const deadlineAtMs = Date.now() + this.config.launchTimeoutMs;
    let lastError: unknown;
    let token: MicrovmAuthToken | undefined;
    while (Date.now() < deadlineAtMs) {
      callerSignal.throwIfAborted();
      try {
        if (token == null || token.expiresAtMs <= Date.now() + this.config.healthTimeoutMs) {
          token = await this.mintToken(vm.microvmId, this.config.controlPort, callerSignal);
        }
        const response = await this.deps.fetch(`${endpoint}/api/v2/health`, {
          headers: {
            [token.headerName]: token.token,
            ...microvmPortHeaders(this.config.controlPort),
          },
          signal: AbortSignal.any([
            callerSignal,
            AbortSignal.timeout(this.config.healthTimeoutMs),
          ]),
        });
        if (response.ok) return;
        lastError = new Error(`health returned ${response.status}`);
      } catch (error) {
        lastError = error;
      }
      await this.deps.sleep(250, callerSignal);
    }
    throw new HostedAppMicrovmError(
      'hosted_app_unhealthy',
      `Hosted app control listener did not become ready: ${lastError instanceof Error ? lastError.message : 'unknown error'}`,
      true,
      lastError,
    );
  }

  async startResidentApp(
    vm: MicrovmDescription,
    runtimeSessionId: string,
    spec: ResidentHostedAppSpec,
    callerSignal: AbortSignal,
  ): Promise<void> {
    const token = await this.mintToken(vm.microvmId, this.config.controlPort, callerSignal);
    const response = await this.deps.fetch(
      `${normalizeHostedAppMicrovmEndpoint(vm.endpoint ?? '')}/api/v2/hosted-app/start`,
      {
        method: 'POST',
        headers: {
          [token.headerName]: token.token,
          ...microvmPortHeaders(this.config.controlPort),
          'X-Runtime-Session-Id': runtimeSessionId,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(spec),
        signal: AbortSignal.any([
          callerSignal,
          AbortSignal.timeout(this.config.appStartTimeoutMs),
        ]),
      },
    );
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new HostedAppMicrovmError(
        'hosted_app_start_failed',
        `Hosted app runner rejected start (${response.status}): ${body.slice(0, 1_024)}`,
        response.status >= 500,
        undefined,
        response.status,
      );
    }
  }

  previewToken(microvmId: string, signal: AbortSignal): Promise<MicrovmAuthToken> {
    return this.mintToken(microvmId, this.config.previewPort, signal);
  }

  async terminate(microvmId: string): Promise<boolean> {
    try {
      await this.client.terminateMicrovm(
        microvmId,
        AbortSignal.timeout(this.config.launchTimeoutMs),
      );
      return true;
    } catch (error) {
      if (error instanceof LambdaMicrovmApiError && error.kind === 'not_found') return true;
      return false;
    }
  }
}
