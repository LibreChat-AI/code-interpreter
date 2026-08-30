export const CODEAPI_BRIDGE_WORKER_HEADER = 'X-LibreChat-Code-Worker-ID';
export const BRIDGE_WORKER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export class BridgeWorkerSelectionError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 403 | 503,
  ) {
    super(message);
    this.name = 'BridgeWorkerSelectionError';
  }
}

export function resolveBridgeWorkerSelection(args: {
  backend: SandboxBackendName;
  configuredWorkerId: string;
  dynamicWorkers: boolean;
  requestedWorkerId?: string;
  trustedWorkerId?: string;
}): { workerId: string; explicit: boolean } | undefined {
  const requestedWorkerId = args.requestedWorkerId?.trim();
  const trustedWorkerId = args.trustedWorkerId?.trim();
  const hasRequestedWorker = requestedWorkerId != null && requestedWorkerId.length > 0;
  const hasTrustedWorker = trustedWorkerId != null && trustedWorkerId.length > 0;
  if (hasRequestedWorker || hasTrustedWorker) {
    if (args.backend !== 'remote-bridge') {
      throw new BridgeWorkerSelectionError(
        'Code bridge worker routing requires the remote-bridge backend',
        400,
      );
    }
    if (hasRequestedWorker && !hasTrustedWorker) {
      throw new BridgeWorkerSelectionError(
        'Code bridge worker selection is not authenticated',
        403,
      );
    }
    if (
      hasRequestedWorker &&
      hasTrustedWorker &&
      requestedWorkerId !== trustedWorkerId
    ) {
      throw new BridgeWorkerSelectionError(
        'Code bridge worker selection does not match the authenticated claim',
        403,
      );
    }
    const selectedWorkerId = trustedWorkerId as string;
    if (!BRIDGE_WORKER_ID_PATTERN.test(selectedWorkerId)) {
      throw new BridgeWorkerSelectionError('Invalid code bridge worker ID', 400);
    }
    if (!args.dynamicWorkers && selectedWorkerId !== args.configuredWorkerId) {
      throw new BridgeWorkerSelectionError('Dynamic code bridge workers are disabled', 403);
    }
    return {
      workerId: selectedWorkerId,
      explicit: true,
    };
  }

  if (args.backend !== 'remote-bridge') return undefined;
  const configuredWorkerId = args.configuredWorkerId.trim();
  if (configuredWorkerId.length === 0) {
    throw new BridgeWorkerSelectionError('No code bridge worker was selected', 503);
  }
  if (!BRIDGE_WORKER_ID_PATTERN.test(configuredWorkerId)) {
    throw new BridgeWorkerSelectionError('Invalid configured code bridge worker ID', 503);
  }
  return { workerId: configuredWorkerId, explicit: false };
}

type SandboxBackendName = 'http' | 'lambda-microvm' | 'remote-bridge';
