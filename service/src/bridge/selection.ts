export const CODEAPI_BRIDGE_WORKER_HEADER = 'X-LibreChat-Code-Worker-ID';
export const BRIDGE_WORKER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

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
}): { workerId: string; dynamic: boolean } | undefined {
  const requestedWorkerId = args.requestedWorkerId?.trim();
  if (requestedWorkerId != null && requestedWorkerId.length > 0) {
    if (args.backend !== 'remote-bridge') {
      throw new BridgeWorkerSelectionError(
        'Code bridge worker routing requires the remote-bridge backend',
        400,
      );
    }
    if (!BRIDGE_WORKER_ID_PATTERN.test(requestedWorkerId)) {
      throw new BridgeWorkerSelectionError('Invalid code bridge worker ID', 400);
    }
    if (!args.dynamicWorkers && requestedWorkerId !== args.configuredWorkerId) {
      throw new BridgeWorkerSelectionError('Dynamic code bridge workers are disabled', 403);
    }
    return {
      workerId: requestedWorkerId,
      dynamic: requestedWorkerId !== args.configuredWorkerId,
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
  return { workerId: configuredWorkerId, dynamic: false };
}

type SandboxBackendName = 'http' | 'lambda-microvm' | 'remote-bridge';
