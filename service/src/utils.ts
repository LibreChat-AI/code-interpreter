import axios from 'axios';
import type { AxiosError } from 'axios';

export function applySystemReplacements(input: string): string {
  return input;
}

export function filterSystemLogs(stderr: string, isPyPlot?: boolean): string {
  const filteredStderr = applySystemReplacements(stderr);

  if (isPyPlot !== true) {
    return filteredStderr;
  }

  const lines = filteredStderr.split('\n');
  const logPattern = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2},\d{3} - (INFO|WARNING|ERROR|CRITICAL) - /;

  return lines.filter(line => !logPattern.test(line)).join('\n');
}

/**
 * Delays the execution for a specified number of milliseconds.
 *
 * @param {number} ms - The number of milliseconds to delay.
 * @return {Promise<void>} A promise that resolves after the specified delay.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface ErrorDetails {
  message: string;
  status?: number;
  statusText?: string;
  url?: string;
  method?: string;
  code?: string;
  responseError?: string;
  responseMessage?: string;
}

export function isValidId(id: string = ''): boolean {
  if (!id) {
    return false;
  }
  return /^[A-Za-z0-9_-]{21}$/.test(id);
}

/**
 * Resource identifiers (skill `_id`, agent id, user id) come from
 * heterogeneous upstream identity systems and don't fit the 21-char
 * nanoid shape `isValidId` enforces for sandbox-generated ids:
 *
 *   - Skills: MongoDB `_id` — 24-char hex (`/^[a-f0-9]{24}$/`).
 *   - Agents: LibreChat agent id — 17-char `agent_<11-char-nanoid>` slug.
 *   - Users: MongoDB `_id` (24-char hex) or other length depending on
 *     the host's identity model.
 *
 * Kept liberal — alphanumerics + a small set of safe punctuation,
 * length-bounded — because over-tight format checks here become
 * cross-org integration friction. The sessionKey itself is the
 * tamper-resistance boundary; this validator just rejects obvious
 * garbage (whitespace, control chars, unbounded length).
 */
export function isValidResourceId(id: string = ''): boolean {
  if (!id) {
    return false;
  }
  if (id.length < 1 || id.length > 128) {
    return false;
  }
  return /^[A-Za-z0-9_.:-]+$/.test(id);
}

export function getAxiosErrorDetails(error: unknown): ErrorDetails | unknown {
  if (axios.isAxiosError(error)) {
    const axiosError = error as AxiosError;
    const responseData = parseErrorResponseData(axiosError.response?.data);
    return {
      message: axiosError.message,
      status: axiosError.response?.status,
      statusText: axiosError.response?.statusText,
      url: axiosError.config?.url,
      method: axiosError.config?.method?.toUpperCase(),
      code: axiosError.code,
      responseError: responseData.error,
      responseMessage: responseData.message,
    };
  }
  return error;
}

function parseErrorResponseData(data: unknown): { error?: string; message?: string } {
  if (typeof data !== 'object' || data === null) return {};
  const raw = data as Record<string, unknown>;
  return {
    error: typeof raw.error === 'string' ? raw.error : undefined,
    message: typeof raw.message === 'string' ? raw.message : undefined,
  };
}

export function sandboxErrorMessageFromAxios(error: AxiosError): string {
  const data = parseErrorResponseData(error.response?.data);
  const message = data.message || data.error || error.message;
  const errorCode = data.error || (error.response?.status === 400 && data.message ? 'bad_request' : undefined);
  return errorCode ? `[${errorCode}] ${message}` : message;
}

export function publicExecutionFailure(error: unknown): { status: number; body: { error: string; message: string } } | null {
  const message = error instanceof Error ? error.message : '';

  /* The worker normally publishes a typed deadline failure before this wait
   * expires. If cleanup itself consumes the bounded completion grace, BullMQ
   * supplies its own timeout string; keep both internal shapes sanitized and
  * caller-correct rather than falling through to a generic 500. */
  const workerDeadlineExpired = /^Job timed out after \d+ms$/.test(message);
  const bullmqWaitExpired =
    /^Job wait .+ timed out before finishing, no finish notification arrived after \d+ms \(id=.+\)$/
      .test(message);
  if (workerDeadlineExpired || bullmqWaitExpired) {
    return {
      status: 504,
      body: {
        error: 'execution_timeout',
        message: 'Execution timed out',
      },
    };
  }

  /* Typed worker failures cross BullMQ as `<CODE>: <message>`. Runtime-session
   * MicroVM, and bridge codes describe sandbox availability; SESSION_INPUT_* codes
   * describe the caller's declared input set or its upstream object source. */
  const backendMatch = message.match(
    /^(RUNTIME_SESSION_BUSY|MICROVM_[A-Z_]+|BRIDGE_[A-Z_]+|SESSION_INPUT_[A-Z_]+):\s*(.+)$/,
  );
  if (backendMatch) {
    const code = backendMatch[1];
    const statuses: Record<string, number> = {
      RUNTIME_SESSION_BUSY: 409,
      BRIDGE_WORKER_OFFLINE: 503,
      BRIDGE_WORKER_BUSY: 409,
      BRIDGE_EXECUTION_FAILED: 502,
      BRIDGE_DEADLINE_EXCEEDED: 504,
      SESSION_INPUT_TOO_LARGE: 413,
      SESSION_INPUT_UNAVAILABLE: 422,
      SESSION_INPUT_SOURCE_FAILED: 502,
      SESSION_INPUT_PREPARATION_FAILED: 500,
      SESSION_INPUT_ABORTED: 504,
    };
    const sessionInputFailure = code.startsWith('SESSION_INPUT_');
    const status = statuses[code] ?? (sessionInputFailure ? 500 : 503);
    const publicMessages: Record<string, string> = {
      RUNTIME_SESSION_BUSY: 'Runtime session is busy',
      BRIDGE_WORKER_OFFLINE: 'Remote code worker is unavailable',
      BRIDGE_WORKER_BUSY: 'Remote code worker is busy',
      BRIDGE_EXECUTION_FAILED: 'Remote code execution failed',
      BRIDGE_DEADLINE_EXCEEDED: 'Remote code execution deadline exceeded',
      MICROVM_LAUNCH_FAILED: 'Sandbox launch failed',
      MICROVM_LAUNCH_THROTTLED: 'Sandbox capacity is temporarily unavailable',
      MICROVM_UNHEALTHY: 'Sandbox runtime is unavailable',
      MICROVM_FENCED: 'Runtime session changed during execution',
      MICROVM_DEADLINE_EXCEEDED: 'Sandbox execution deadline exceeded',
      SESSION_INPUT_TOO_LARGE: 'Input files exceed the delivery limit',
      SESSION_INPUT_UNAVAILABLE: 'One or more input files are unavailable',
      SESSION_INPUT_SOURCE_FAILED: 'Input file service is unavailable',
      SESSION_INPUT_PREPARATION_FAILED: 'Input files could not be prepared',
      SESSION_INPUT_ABORTED: 'Input delivery timed out',
    };
    /* The backend message is retained in worker/router logs, but it can contain
     * AWS identifiers, internal endpoints, object ids, or file names. Only the
     * stable code and a fixed public message cross the API boundary. */
    return {
      status,
      body: {
        error: code.toLowerCase(),
        message: publicMessages[code]
          ?? (sessionInputFailure ? 'Input delivery failed' : 'Sandbox runtime is unavailable'),
      },
    };
  }

  const match = message.match(/^Error from sandbox(?:\s+\[([a-z_]+)\])?:\s*(?:\[([a-z_]+)\]\s*)?(.+)$/);
  if (!match) return null;

  const errorCode = match[1] || match[2] || 'sandbox_execution_failed';
  const sandboxMessage = match[3] || 'Sandbox execution failed';

  if (errorCode === 'bad_request') {
    return {
      status: 400,
      body: {
        error: errorCode,
        message: sandboxMessage,
      },
    };
  }

  if (
    errorCode === 'sandbox_setup_failed' ||
    errorCode === 'permission_denied' ||
    errorCode === 'workspace_missing' ||
    errorCode === 'mount_failed'
  ) {
    return {
      status: 503,
      body: {
        error: errorCode,
        message: sandboxMessage,
      },
    };
  }

  if (errorCode === 'sandbox_execution_failed') {
    return {
      status: 502,
      body: {
        error: errorCode,
        message: sandboxMessage,
      },
    };
  }

  return null;
}
