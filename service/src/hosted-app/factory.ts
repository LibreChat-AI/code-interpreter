import { env } from '../config';
import { checkpointSession, restoreSession } from '../runtime-session/checkpoint';
import { MinioCheckpointStore } from '../runtime-session/checkpoint-store';
import { AwsLambdaMicrovmClient } from '../runtime-session/lambda-client-aws';
import { startRuntimeSessionLockHeartbeat } from '../runtime-session/lock-heartbeat';
import {
  allocateRuntimeSessionGeneration,
  RUNTIME_SESSION_LOCK_TTL_MS,
  readRuntimeSessionRecord,
  releaseRuntimeSessionLock,
  renewRuntimeSessionLock,
  waitForRuntimeSessionLock,
  writeRuntimeSessionRecord,
} from '../runtime-session/registry';
import {
  HostedAppControlPlane,
  HostedAppControlPlaneError,
} from './control-plane';
import { parseHostedAppCredentialKey } from './credential';
import {
  HostedAppMicrovmRuntime,
  normalizeHostedAppMicrovmEndpoint,
} from './microvm-runtime';
import { captureHostedAppSourceCheckpoint } from './source-checkpoint';

let controlPlane: HostedAppControlPlane | undefined;

export function getHostedAppControlPlane(): HostedAppControlPlane {
  if (controlPlane) return controlPlane;
  if (!env.HOSTED_APPS_ENABLED) {
    throw new HostedAppControlPlaneError(
      'hosted_apps_disabled',
      'Hosted apps are not enabled on this execution profile',
      404,
    );
  }

  const client = new AwsLambdaMicrovmClient({ region: env.LAMBDA_MICROVM_REGION });
  const runtime = new HostedAppMicrovmRuntime(client, {
    imageArn: env.HOSTED_APP_IMAGE_ARN,
    imageVersion: env.HOSTED_APP_IMAGE_VERSION as string,
    executionRoleArn: env.LAMBDA_MICROVM_EXECUTION_ROLE_ARN,
    logGroup: env.LAMBDA_MICROVM_LOG_GROUP,
    ingressConnectorArns: env.LAMBDA_MICROVM_INGRESS_CONNECTOR_ARNS,
    controlPort: env.HOSTED_APP_CONTROL_PORT,
    previewPort: env.HOSTED_APP_PREVIEW_PORT,
    maximumDurationSeconds: env.HOSTED_APP_MAX_DURATION_SECONDS,
    idleSeconds: env.HOSTED_APP_IDLE_SECONDS,
    suspendedSeconds: env.HOSTED_APP_SUSPEND_SECONDS,
    authTokenTtlSeconds: env.LAMBDA_MICROVM_AUTH_TOKEN_TTL_SECONDS,
    launchTimeoutMs: env.LAMBDA_MICROVM_LAUNCH_TIMEOUT_MS,
    healthTimeoutMs: env.LAMBDA_MICROVM_HEALTH_TIMEOUT_MS,
    appStartTimeoutMs: env.HOSTED_APP_START_TIMEOUT_MS,
    launchTps: env.LAMBDA_MICROVM_LAUNCH_TPS,
    tokenTps: env.LAMBDA_MICROVM_TOKEN_TPS,
  });
  const store = new MinioCheckpointStore();
  const checkpointConfig = {
    port: env.HOSTED_APP_CONTROL_PORT,
    authTokenTtlSeconds: env.LAMBDA_MICROVM_AUTH_TOKEN_TTL_SECONDS,
    maxBytes: env.CHECKPOINT_MAX_BYTES,
    timeoutMs: env.CHECKPOINT_TIMEOUT_MS,
  };

  controlPlane = new HostedAppControlPlane({
    registry: {
      waitForLock: (runtimeId, args) => waitForRuntimeSessionLock(runtimeId, args),
      renewLock: (runtimeId, token, ttlMs, args) => renewRuntimeSessionLock(
        runtimeId,
        token,
        ttlMs,
        args,
      ),
      releaseLock: releaseRuntimeSessionLock,
      read: readRuntimeSessionRecord,
      write: (record, token, args) => writeRuntimeSessionRecord(
        record,
        token,
        undefined,
        args,
      ),
      allocateGeneration: allocateRuntimeSessionGeneration,
    },
    runtime,
    checkpointStore: store,
    checkpointConfig,
    credentialKey: parseHostedAppCredentialKey(env.HOSTED_APP_CREDENTIAL_KEY),
    lockWaitMs: env.RUNTIME_SESSION_LOCK_WAIT_MS,
    lockTtlMs: RUNTIME_SESSION_LOCK_TTL_MS,
    startHeartbeat: startRuntimeSessionLockHeartbeat,
    captureCheckpoint: (runtimeSessionId, owner, signal) => (
      captureHostedAppSourceCheckpoint({
        runtimeSessionId,
        owner,
        signal,
        lockWaitMs: env.RUNTIME_SESSION_LOCK_WAIT_MS,
        deps: {
          waitForLock: (sourceId, args) => waitForRuntimeSessionLock(sourceId, args),
          releaseLock: releaseRuntimeSessionLock,
          read: readRuntimeSessionRecord,
          checkpoint: ({ runtimeSessionId: sourceId, lockToken, signal: sourceSignal }) => (
            checkpointSession({
              mintToken: microvmId => runtime.mintToken(
                microvmId,
                env.LAMBDA_MICROVM_PORT,
                sourceSignal,
              ),
              store,
              runtimeSessionId: sourceId,
              config: {
                ...checkpointConfig,
                port: env.LAMBDA_MICROVM_PORT,
              },
              normalizeEndpoint: normalizeHostedAppMicrovmEndpoint,
              lockToken,
              signal: sourceSignal,
            })
          ),
        },
      })
    ),
    restoreCheckpoint: args => restoreSession({
      mintToken: microvmId => runtime.mintToken(
        microvmId,
        env.HOSTED_APP_CONTROL_PORT,
        args.signal,
      ),
      store: args.store,
      runtimeSessionId: args.runtimeSessionId,
      microvmId: args.vm.microvmId,
      endpointBase: normalizeHostedAppMicrovmEndpoint(args.vm.endpoint ?? ''),
      config: args.config,
      signal: args.signal,
      checkpointKey: args.checkpointKey,
    }),
  });
  return controlPlane;
}

export function resetHostedAppControlPlaneForTests(): void {
  controlPlane = undefined;
}
