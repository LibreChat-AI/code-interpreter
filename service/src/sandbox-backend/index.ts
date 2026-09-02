import type {
  SandboxBackend,
  SandboxExecuteContext,
  SandboxRawResponse,
  SandboxTransportRequest,
} from './types';
import type { LambdaMicrovmClient } from '../runtime-session/lambda-client';
import { HttpSandboxBackend } from './http';
import { env } from '../config';

export type { SandboxBackend, SandboxExecuteContext, SandboxRawResponse, SandboxTransportRequest } from './types';
export { SandboxBackendError } from './types';
export { HttpSandboxBackend } from './http';

let backend: SandboxBackend | undefined;

class LazyRemoteBridgeSandboxBackend implements SandboxBackend {
  readonly name = 'remote-bridge' as const;
  private backendPromise: Promise<SandboxBackend> | undefined;

  private load(): Promise<SandboxBackend> {
    this.backendPromise ??= import('./remote-bridge').then(
      ({ RemoteBridgeSandboxBackend }) => new RemoteBridgeSandboxBackend(),
    );
    return this.backendPromise;
  }

  async execute(
    req: SandboxTransportRequest,
    ctx: SandboxExecuteContext,
  ): Promise<SandboxRawResponse> {
    return (await this.load()).execute(req, ctx);
  }
}

class LazyLambdaMicrovmSandboxBackend implements SandboxBackend {
  readonly name = 'lambda-microvm' as const;
  private backendPromise: Promise<SandboxBackend> | undefined;

  private load(): Promise<SandboxBackend> {
    this.backendPromise ??= (async (): Promise<SandboxBackend> => {
      const { LambdaMicrovmSandboxBackend } = await import('./lambda-microvm');
      const checkpointStore = env.SESSION_CHECKPOINTS && env.RUNTIME_SESSION_MODE !== 'stateless'
        ? new (await import('../runtime-session/checkpoint-store')).MinioCheckpointStore()
        : undefined;

      return new LambdaMicrovmSandboxBackend({
        /* The AWS client stays behind the same backend gate. */
        clientFactory: async (): Promise<LambdaMicrovmClient> => {
          const { AwsLambdaMicrovmClient } = await import('../runtime-session/lambda-client-aws');
          return new AwsLambdaMicrovmClient({ region: env.LAMBDA_MICROVM_REGION });
        },
        config: {
          imageArn: env.LAMBDA_MICROVM_IMAGE_ARN,
          imageVersion: env.LAMBDA_MICROVM_IMAGE_VERSION,
          executionRoleArn: env.LAMBDA_MICROVM_EXECUTION_ROLE_ARN,
          logGroup: env.LAMBDA_MICROVM_LOG_GROUP,
          ingressConnectorArns: env.LAMBDA_MICROVM_INGRESS_CONNECTOR_ARNS,
          egressConnectorArns: env.LAMBDA_MICROVM_EGRESS_CONNECTOR_ARNS,
          port: env.LAMBDA_MICROVM_PORT,
          maxDurationSeconds: env.LAMBDA_MICROVM_MAX_DURATION_SECONDS,
          authTokenTtlSeconds: env.LAMBDA_MICROVM_AUTH_TOKEN_TTL_SECONDS,
          launchTimeoutMs: env.LAMBDA_MICROVM_LAUNCH_TIMEOUT_MS,
          healthTimeoutMs: env.LAMBDA_MICROVM_HEALTH_TIMEOUT_MS,
          launchTps: env.LAMBDA_MICROVM_LAUNCH_TPS,
          tokenTps: env.LAMBDA_MICROVM_TOKEN_TPS,
          jobTimeoutMs: env.JOB_TIMEOUT,
          idleSeconds: env.LAMBDA_MICROVM_IDLE_SECONDS,
          suspendedSeconds: env.LAMBDA_MICROVM_SUSPEND_SECONDS,
          lockWaitMs: env.RUNTIME_SESSION_LOCK_WAIT_MS,
          checkpointsEnabled: env.SESSION_CHECKPOINTS,
          checkpoint: {
            port: env.LAMBDA_MICROVM_PORT,
            authTokenTtlSeconds: env.LAMBDA_MICROVM_AUTH_TOKEN_TTL_SECONDS,
            maxBytes: env.CHECKPOINT_MAX_BYTES,
            timeoutMs: env.CHECKPOINT_TIMEOUT_MS,
          },
        },
        checkpointStore,
      });
    })();
    return this.backendPromise;
  }

  async execute(
    req: SandboxTransportRequest,
    ctx: SandboxExecuteContext,
  ): Promise<SandboxRawResponse> {
    return (await this.load()).execute(req, ctx);
  }
}

function createBackend(): SandboxBackend {
  if (env.SANDBOX_BACKEND === 'remote-bridge') {
    return new LazyRemoteBridgeSandboxBackend();
  }
  if (env.SANDBOX_BACKEND === 'lambda-microvm') {
    /* Loading the concrete backend also loads its session registry and
     * checkpoint code. Defer the whole graph so the default HTTP worker does
     * not require AWS SDK modules or initialize Lambda-only dependencies. */
    return new LazyLambdaMicrovmSandboxBackend();
  }
  return new HttpSandboxBackend();
}

export function getSandboxBackend(): SandboxBackend {
  backend ??= createBackend();
  return backend;
}

export function setSandboxBackendForTests(next: SandboxBackend | undefined): void {
  backend = next;
}
