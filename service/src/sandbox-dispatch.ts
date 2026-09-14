import type * as t from './types';
import {
  BRIDGE_WORKSPACE_PROGRAMMATIC_MAX_FILES,
  BRIDGE_WORKSPACE_PROGRAMMATIC_TRANSFER_CONCURRENCY,
  BRIDGE_WORKSPACE_PROGRAMMATIC_TRANSFER_TIMEOUT_MS,
} from '../../packages/code/src/protocol';
import {
    executionManifestBodySha256,
    signExecutionManifestWithKey,
    type ExecutionManifestClaims,
} from './execution-manifest';

interface BuildSandboxExecuteRequestArgs {
  payload: t.PayloadBody;
  egressGrantToken?: string;
  executionManifestClaims?: ExecutionManifestClaims;
  executionManifestPrivateKey?: string;
  executionManifestSecret: string;
  executionManifestTtlSeconds: number;
  nowSeconds?: number;
  maxOutputFileBytes?: number;
  programmaticTransferReserveMs?: number;
}

interface SandboxExecuteRequest {
  body: t.PayloadBody;
  headers: Record<string, string>;
}

/**
 * Large encrypted grants and manifests grow with scoped files/skills, so they
 * ride in the JSON body instead of HTTP headers. Otherwise skill-heavy jobs can
 * fail with 431 before sandbox-runner reaches capability validation.
 */
export function buildSandboxExecuteRequest(
    args: BuildSandboxExecuteRequestArgs,
): SandboxExecuteRequest {
  const body: t.PayloadBody = { ...args.payload };
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
    };

  if (args.egressGrantToken) {
    body.egress_grant = args.egressGrantToken;
  }
  if (args.maxOutputFileBytes != null) {
    body.max_output_file_bytes = args.maxOutputFileBytes;
  }
  if (args.programmaticTransferReserveMs != null) {
    const batches = Math.max(1,
      Math.ceil(body.files.filter(file => 'id' in file).length / BRIDGE_WORKSPACE_PROGRAMMATIC_TRANSFER_CONCURRENCY) +
      Math.ceil((args.executionManifestClaims?.max_output_files ?? BRIDGE_WORKSPACE_PROGRAMMATIC_MAX_FILES) / BRIDGE_WORKSPACE_PROGRAMMATIC_TRANSFER_CONCURRENCY),
    );
    body.transfer_timeout_ms = Math.min(BRIDGE_WORKSPACE_PROGRAMMATIC_TRANSFER_TIMEOUT_MS,
      Math.max(1, Math.floor(args.programmaticTransferReserveMs / batches)));
  }

  if (args.executionManifestClaims) {
        body.max_output_files = args.executionManifestClaims.max_output_files;
    const nowSeconds = args.nowSeconds ?? Math.floor(Date.now() / 1000);
    body.execution_manifest = signExecutionManifestWithKey(
      {
        ...args.executionManifestClaims,
        execute_body_sha256: executionManifestBodySha256(body),
        iat: nowSeconds,
        exp: nowSeconds + args.executionManifestTtlSeconds,
      },
      {
        privateKey: args.executionManifestPrivateKey,
        secret: args.executionManifestSecret,
      },
    );
  }

  return { body, headers };
}
