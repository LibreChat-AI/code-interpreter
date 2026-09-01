export const EXECUTION_PROFILES = ['default', 'stateful'] as const;
export const SANDBOX_BACKENDS = [
  'http',
  'lambda-microvm',
  'remote-bridge',
] as const;

export type ExecutionProfile = typeof EXECUTION_PROFILES[number];
export type ExecutionProfileSource = 'explicit' | 'inferred';

export const EXPECTED_EXECUTION_PROFILE_HEADER = 'X-CodeAPI-Expected-Profile';
export const EXECUTION_PROFILE_HEADER = 'X-CodeAPI-Execution-Profile';

export interface ExecutionProfileQueueNames {
  python: string;
  other: string;
}

export type SandboxBackendName = typeof SANDBOX_BACKENDS[number];

/** Resolve the backend owned by the queue consumer rather than the API pod.
 * Stateful API-only pods intentionally retain the HTTP local default while
 * dispatching to Lambda workers. */
export function resolveQueuedSandboxBackend(
  profile: ExecutionProfile,
  apiBackend: SandboxBackendName,
  source: ExecutionProfileSource = 'explicit',
): SandboxBackendName | undefined {
  if (profile === 'stateful' && apiBackend === 'http') {
    return 'lambda-microvm';
  }
  /* An inferred default profile still uses the pre-fencing legacy queues.
   * Its API-only process cannot distinguish the supported HTTP and Lambda
   * consumers because Lambda-only configuration belongs to the worker pod.
   * Preserve that rollout topology by leaving the backend absent, exactly as
   * pre-fencing producers did; explicit profiles regain strict fencing. */
  if (profile === 'default' && source === 'inferred' && apiBackend === 'http') {
    return undefined;
  }
  return apiBackend;
}

export function resolveExecutionProfile(
  raw: string | undefined,
  runtimeSessionMode: 'stateless' | 'affinity' | 'strict',
): ExecutionProfile {
  const configuredChoice = raw?.trim();
  if (configuredChoice) {
    if (EXECUTION_PROFILES.includes(configuredChoice as ExecutionProfile)) {
      return configuredChoice as ExecutionProfile;
    }
    throw new Error(
      `CODEAPI_EXECUTION_PROFILE must be one of: ${EXECUTION_PROFILES.join(', ')}`,
    );
  }

  /* Preserve the two supported pre-profile deployments during rollout. The
   * common stateless stack remains `default`; a stateful API-only pod can
   * infer `stateful` from its session mode even though worker-only backend
   * credentials/config are intentionally absent. Worker startup separately
   * verifies that this profile is backed by Lambda. */
  return runtimeSessionMode !== 'stateless'
    ? 'stateful'
    : 'default';
}

export function resolveExecutionProfileSource(
  raw: string | undefined,
): ExecutionProfileSource {
  return raw?.trim() ? 'explicit' : 'inferred';
}

const LEGACY_QUEUE_NAMES: ExecutionProfileQueueNames = {
  python: 'python-queue',
  other: 'other-queue',
};

const EXPLICIT_PROFILE_QUEUE_NAMES: Record<ExecutionProfile, ExecutionProfileQueueNames> = {
  default: LEGACY_QUEUE_NAMES,
  stateful: {
    python: 'stateful-python-queue',
    other: 'stateful-other-queue',
  },
};

const REMOTE_BRIDGE_QUEUE_NAMES: ExecutionProfileQueueNames = {
  python: 'remote-bridge-python-queue',
  other: 'remote-bridge-other-queue',
};

export function queueNamesForExecutionProfile(
  profile: ExecutionProfile,
  source: ExecutionProfileSource,
  backend?: SandboxBackendName,
): ExecutionProfileQueueNames {
  if (backend === 'remote-bridge') return REMOTE_BRIDGE_QUEUE_NAMES;
  /* A pre-profile affinity/strict deployment used the legacy queues. Keep
   * inferred profiles on those names so API and worker Deployments can roll
   * or roll back independently without temporarily losing their consumers.
   * Queue isolation is an explicit cutover: operators bring up the stateful
   * stack with CODEAPI_EXECUTION_PROFILE=stateful on both sides, then switch
   * callers to its endpoint. */
  return source === 'explicit'
    ? EXPLICIT_PROFILE_QUEUE_NAMES[profile]
    : LEGACY_QUEUE_NAMES;
}

export function queueNameForExecution(
  language: 'python' | 'bash',
  profile: ExecutionProfile,
  source: ExecutionProfileSource,
  backend?: SandboxBackendName,
): string {
  const names = queueNamesForExecutionProfile(profile, source, backend);
  return language === 'bash' ? names.other : names.python;
}

export type ExecutionProfileExpectation =
  | { ok: true }
  | {
    ok: false;
    status: 400 | 409;
    body: {
      error: 'invalid_execution_profile' | 'execution_profile_mismatch';
      message: string;
      expected_profile?: string;
      actual_profile: ExecutionProfile;
    };
  };

export function checkExecutionProfileExpectation(
  rawExpectedProfile: string | undefined,
  actualProfile: ExecutionProfile,
): ExecutionProfileExpectation {
  if (rawExpectedProfile == null) return { ok: true };

  if (!EXECUTION_PROFILES.includes(rawExpectedProfile as ExecutionProfile)) {
    return {
      ok: false,
      status: 400,
      body: {
        error: 'invalid_execution_profile',
        message: `Invalid execution profile: ${rawExpectedProfile}`,
        expected_profile: rawExpectedProfile,
        actual_profile: actualProfile,
      },
    };
  }

  if (rawExpectedProfile !== actualProfile) {
    return {
      ok: false,
      status: 409,
      body: {
        error: 'execution_profile_mismatch',
        message: `Expected the ${rawExpectedProfile} execution profile, but reached ${actualProfile}`,
        expected_profile: rawExpectedProfile,
        actual_profile: actualProfile,
      },
    };
  }

  return { ok: true };
}

/** Reject producer/consumer profile drift before a worker invokes a sandbox.
 * Missing profile is accepted only for jobs queued by pre-profile binaries. */
export function validateQueuedExecutionProfile(
  jobProfile: unknown,
  workerProfile: ExecutionProfile,
): void {
  if (jobProfile == null) return;
  if (!EXECUTION_PROFILES.includes(jobProfile as ExecutionProfile)) {
    throw new Error(`Queued job has invalid execution profile: ${String(jobProfile)}`);
  }
  if (jobProfile !== workerProfile) {
    throw new Error(
      `Queued job targets the ${jobProfile} execution profile, but worker serves ${workerProfile}`,
    );
  }
}

/** Reject backend drift before a consumer can invoke the wrong sandbox.
 * Missing backend remains compatible with jobs queued before backend fencing. */
export function validateQueuedSandboxBackend(
  jobBackend: unknown,
  workerBackend: SandboxBackendName,
  bridgeWorkerId?: string,
): void {
  if (jobBackend == null) {
    if (bridgeWorkerId != null && workerBackend !== 'remote-bridge') {
      throw new Error(
        `Legacy queued bridge job cannot run on the ${workerBackend} sandbox backend`,
      );
    }
    return;
  }
  if (!SANDBOX_BACKENDS.includes(jobBackend as SandboxBackendName)) {
    throw new Error(`Queued job has invalid sandbox backend: ${String(jobBackend)}`);
  }
  if (jobBackend !== workerBackend) {
    throw new Error(
      `Queued job targets the ${jobBackend} sandbox backend, but worker serves ${workerBackend}`,
    );
  }
}
