import type { CheckpointConfig } from '../runtime-session/checkpoint';
import type { CheckpointStore } from '../runtime-session/checkpoint-store';
import type { MicrovmDescription } from '../runtime-session/lambda-client';
import type { RuntimeSessionRecord } from '../runtime-session/registry';
import type { LockHeartbeat } from '../runtime-session/lock-heartbeat';
import { sealHostedAppCredential } from './credential';
import {
  hostedAppLaunchClientToken,
  hostedAppLaunchFingerprint,
  hostedAppLaunchGenerationSeed,
  hostedAppLaunchRequestFingerprint,
  HostedAppMicrovmError,
  type HostedAppMicrovmRuntime,
} from './microvm-runtime';
import type { HostedAppPublicStatus } from './record';
import {
  hostedAppSpecFingerprint,
  type ResidentHostedAppSpec,
} from './spec';

const HOSTED_APP_DEADLINE_HEADROOM_MS = 60_000;

export class HostedAppControlPlaneError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly transient = false,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'HostedAppControlPlaneError';
  }
}

export interface HostedAppOwner {
  tenantId: string;
  canonicalUserId: string;
}

export interface HostedAppStartInput extends HostedAppOwner {
  hostedAppRuntimeId: string;
  sourceRuntimeSessionId: string;
  spec: ResidentHostedAppSpec;
  signal: AbortSignal;
}

export interface HostedAppRegistry {
  waitForLock(runtimeId: string, args: {
    waitMs: number;
    ttlMs: number;
    signal: AbortSignal;
  }): Promise<string | null>;
  renewLock(runtimeId: string, token: string, ttlMs: number, args: {
    signal: AbortSignal;
    onLateLost: () => void;
  }): Promise<'held' | 'lost' | 'error'>;
  releaseLock(runtimeId: string, token: string): Promise<void>;
  read(runtimeId: string, args: { signal?: AbortSignal }): Promise<RuntimeSessionRecord | null>;
  write(record: RuntimeSessionRecord, token: string, args: {
    signal?: AbortSignal;
  }): Promise<boolean>;
  allocateGeneration(runtimeId: string, seed: number, args: {
    signal: AbortSignal;
  }): Promise<number>;
}

export interface HostedAppControlPlaneDeps {
  registry: HostedAppRegistry;
  runtime: HostedAppMicrovmRuntime;
  checkpointStore: CheckpointStore;
  checkpointConfig: CheckpointConfig;
  credentialKey: Buffer;
  lockWaitMs: number;
  lockTtlMs: number;
  captureCheckpoint(
    runtimeSessionId: string,
    owner: HostedAppOwner,
    signal: AbortSignal,
  ): Promise<string>;
  restoreCheckpoint(args: {
    runtimeSessionId: string;
    checkpointKey: string;
    vm: MicrovmDescription;
    store: CheckpointStore;
    config: CheckpointConfig;
    signal: AbortSignal;
  }): Promise<'restored' | 'absent' | 'fetch_failed' | 'push_failed'>;
  startHeartbeat(args: {
    renew: () => Promise<'held' | 'lost' | 'error'>;
    fence: AbortController;
    ttlMs: number;
  }): LockHeartbeat;
  now?: () => number;
}

function publicState(
  record: RuntimeSessionRecord,
  now: number,
): HostedAppPublicStatus['state'] {
  if (
    record.state === 'RUNNING'
    && record.hard_deadline_at != null
    && record.hard_deadline_at <= now
  ) return 'stopped';
  if (record.state === 'RUNNING') return 'running';
  if (record.state === 'PENDING') return 'starting';
  if (record.state === 'TERMINATED') {
    return record.last_error ? 'failed' : 'stopped';
  }
  if (record.state === 'TERMINATING') return 'stopping';
  return 'starting';
}

export function hostedAppPublicStatus(
  record: RuntimeSessionRecord,
  now = Date.now(),
): HostedAppPublicStatus {
  const app = record.hosted_app;
  if (!app) {
    throw new HostedAppControlPlaneError(
      'hosted_app_record_invalid',
      'Hosted app registry record is missing app metadata',
      503,
      true,
    );
  }
  return {
    app_id: app.app_id,
    revision: app.revision,
    state: publicState(record, now),
    preview_id: record.runtime_session_id,
    hard_deadline_at: record.hard_deadline_at,
    updated_at: record.last_seen_at,
    ...(record.last_error ? {
      /* Provider, endpoint, and checkpoint errors stay in the internal record
       * and worker logs. Status is a public API and must not replay them. */
      error: record.state === 'TERMINATING'
        ? 'Hosted app cleanup is pending'
        : record.state === 'RUNNING'
          ? 'Hosted app could not be stopped'
          : 'Hosted app operation failed',
    } : {}),
  };
}

export function assertHostedAppOwned(
  record: RuntimeSessionRecord,
  owner: HostedAppOwner,
  sourceRuntimeSessionId?: string,
): void {
  if (
    record.tenant_id !== owner.tenantId
    || record.canonical_user_id !== owner.canonicalUserId
    || (sourceRuntimeSessionId != null
      && record.hosted_app?.source_runtime_session_id !== sourceRuntimeSessionId)
  ) {
    /* Do not disclose whether another owner's opaque id exists. */
    throw new HostedAppControlPlaneError('hosted_app_not_found', 'Hosted app not found', 404);
  }
}

export class HostedAppControlPlane {
  private readonly now: () => number;

  constructor(private readonly deps: HostedAppControlPlaneDeps) {
    this.now = deps.now ?? Date.now;
  }

  async start(input: HostedAppStartInput): Promise<HostedAppPublicStatus> {
    return this.withLease(input.hostedAppRuntimeId, input.signal, async (signal, lockToken) => {
      const fingerprint = hostedAppSpecFingerprint(input.spec);
      let prior = await this.deps.registry.read(input.hostedAppRuntimeId, { signal });
      if (prior) {
        assertHostedAppOwned(prior, input, input.sourceRuntimeSessionId);
        if (
          prior.hosted_app?.revision === input.spec.revision
          && prior.hosted_app.spec_fingerprint !== fingerprint
        ) {
          throw new HostedAppControlPlaneError(
            'hosted_app_revision_conflict',
            'An app revision is immutable; use a new revision for changed launch settings',
            409,
          );
        }
      }

      const exactRevision = prior?.hosted_app?.revision === input.spec.revision
        && prior.hosted_app.spec_fingerprint === fingerprint;
      if (
        exactRevision
        && prior?.state === 'RUNNING'
        && prior.microvm_id
        && prior.endpoint
        && (prior.hard_deadline_at == null
          || prior.hard_deadline_at > this.now() + HOSTED_APP_DEADLINE_HEADROOM_MS)
      ) {
        /* Reassert both the runner and credential. This resumes a suspended VM,
         * heals a dead resident process, and never trusts an expired token. */
        const vm = this.recordedVm(prior);
        try {
          await this.deps.runtime.waitForControlReady(vm, signal);
          await this.deps.runtime.startResidentApp(
            vm,
            input.sourceRuntimeSessionId,
            input.spec,
            signal,
          );
          return hostedAppPublicStatus(
            await this.persistPreviewCredential(prior, vm, lockToken, signal),
            this.now(),
          );
        } catch (error) {
          if (!(error instanceof HostedAppMicrovmError) || !error.transient) throw error;
          const terminating: RuntimeSessionRecord = {
            ...prior,
            state: 'TERMINATING',
            last_seen_at: this.now(),
          };
          /* Record the destructive transition before acting on AWS. If the
           * subsequent generation allocation or Redis write fails, callers see
           * a recoverable cleanup state rather than a stale RUNNING endpoint
           * for a VM we already terminated. */
          await this.writeOrFence(terminating, lockToken, signal);
          const terminated = await this.deps.runtime.terminate(vm.microvmId);
          if (!terminated) throw error;
          prior = {
            ...terminating,
            microvm_id: undefined,
            endpoint: undefined,
            state: 'TERMINATED',
            last_seen_at: this.now(),
            last_error: error.message,
          };
        }
      }

      const replayPending = Boolean(
        exactRevision
        && prior?.state === 'PENDING'
        && !prior.microvm_id
        && prior.launch_client_token
        && prior.hosted_app?.checkpoint_key
        && prior.launch_fingerprint === hostedAppLaunchFingerprint(this.deps.runtime.config)
        && prior.launch_request_fingerprint
          === hostedAppLaunchRequestFingerprint(this.deps.runtime.config)
        && prior.hard_deadline_at != null
        && prior.hard_deadline_at > this.now() + HOSTED_APP_DEADLINE_HEADROOM_MS
      );
      const pendingProviderCouldStillBeLive = Boolean(
        prior?.state === 'PENDING'
        && !prior.microvm_id
        && (
          prior.hard_deadline_at == null
          || prior.hard_deadline_at
            + HOSTED_APP_DEADLINE_HEADROOM_MS
            + this.deps.runtime.config.launchTimeoutMs > this.now()
        )
      );
      if (
        pendingProviderCouldStillBeLive
        && !replayPending
      ) {
        /* A provider call may have succeeded before its response was lost. We
         * can recover only by replaying the exact revision/config token; never
         * overwrite that intent with a different revision and orphan a VM. */
        throw new HostedAppControlPlaneError(
          'hosted_app_launch_in_progress',
          'The prior hosted app launch must be recovered before it can be replaced',
          409,
          true,
        );
      }
      /* An exact revision always reuses its immutable source snapshot. A dead
       * app VM must not silently pick up later workspace edits under the same
       * revision; changed bytes require a new revision. */
      const checkpointKey = exactRevision && prior?.hosted_app?.checkpoint_key
        ? prior.hosted_app.checkpoint_key
        : await this.deps.captureCheckpoint(input.sourceRuntimeSessionId, input, signal);

      if (prior?.microvm_id) {
        const terminating: RuntimeSessionRecord = {
          ...prior,
          state: 'TERMINATING',
          last_seen_at: this.now(),
        };
        await this.writeOrFence(terminating, lockToken, signal);
        const terminated = await this.deps.runtime.terminate(prior.microvm_id);
        if (!terminated) {
          throw new HostedAppControlPlaneError(
            'hosted_app_replace_failed',
            'Could not terminate the previous hosted app revision',
            503,
            true,
          );
        }
        prior = terminating;
      }

      const generation = replayPending && prior
        ? prior.generation
        : await this.deps.registry.allocateGeneration(
          input.hostedAppRuntimeId,
          hostedAppLaunchGenerationSeed(this.deps.runtime.config),
          { signal },
        );
      const clientToken = replayPending && prior?.launch_client_token
        ? prior.launch_client_token
        : hostedAppLaunchClientToken(input.hostedAppRuntimeId, generation);
      const launchedAt = replayPending && prior?.launched_at
        ? prior.launched_at
        : this.now();
      const hardDeadlineAt = replayPending && prior?.hard_deadline_at
        ? prior.hard_deadline_at
        : launchedAt
          + this.deps.runtime.config.maximumDurationSeconds * 1_000
          - HOSTED_APP_DEADLINE_HEADROOM_MS;
      let launchIntent: RuntimeSessionRecord = {
        runtime_session_id: input.hostedAppRuntimeId,
        tenant_id: input.tenantId,
        canonical_user_id: input.canonicalUserId,
        port: this.deps.runtime.config.previewPort,
        image_arn: this.deps.runtime.config.imageArn,
        image_version: this.deps.runtime.config.imageVersion,
        launch_fingerprint: hostedAppLaunchFingerprint(this.deps.runtime.config),
        launch_client_token: clientToken,
        launch_request_fingerprint: hostedAppLaunchRequestFingerprint(this.deps.runtime.config),
        state: 'PENDING',
        generation,
        launched_at: launchedAt,
        last_seen_at: this.now(),
        hard_deadline_at: hardDeadlineAt,
        hosted_app: {
          source_runtime_session_id: input.sourceRuntimeSessionId,
          app_id: input.spec.app_id,
          revision: input.spec.revision,
          spec_fingerprint: fingerprint,
          spec: input.spec,
          checkpoint_key: checkpointKey,
        },
      };
      await this.writeOrFence(launchIntent, lockToken, signal);

      let vm: MicrovmDescription | undefined;
      try {
        const launched = await this.deps.runtime.launch(clientToken, signal);
        vm = launched.vm;
        const providerStartedAt = Number.isFinite(vm.startedAtMs)
          ? vm.startedAtMs
          : undefined;
        launchIntent = {
          ...launchIntent,
          launch_client_token: launched.clientToken,
          microvm_id: vm.microvmId,
          endpoint: vm.endpoint,
          image_arn: vm.imageArn ?? launchIntent.image_arn,
          image_version: vm.imageVersion ?? launchIntent.image_version,
          launched_at: providerStartedAt ?? launchIntent.launched_at,
          hard_deadline_at: providerStartedAt == null
            ? launchIntent.hard_deadline_at
            : providerStartedAt
              + this.deps.runtime.config.maximumDurationSeconds * 1_000
              - HOSTED_APP_DEADLINE_HEADROOM_MS,
          last_seen_at: this.now(),
        };
        await this.writeOrFence(launchIntent, lockToken, signal);
        await this.deps.runtime.waitForControlReady(vm, signal);
        const restored = await this.deps.restoreCheckpoint({
          runtimeSessionId: input.sourceRuntimeSessionId,
          checkpointKey,
          vm,
          store: this.deps.checkpointStore,
          config: this.deps.checkpointConfig,
          signal,
        });
        if (restored !== 'restored') {
          throw new HostedAppControlPlaneError(
            'hosted_app_restore_failed',
            `Could not restore the exact app workspace revision (${restored})`,
            503,
            true,
          );
        }
        await this.deps.runtime.startResidentApp(
          vm,
          input.sourceRuntimeSessionId,
          input.spec,
          signal,
        );
        const running: RuntimeSessionRecord = {
          ...launchIntent,
          state: 'RUNNING',
          last_seen_at: this.now(),
        };
        return hostedAppPublicStatus(
          await this.persistPreviewCredential(running, vm, lockToken, signal),
          this.now(),
        );
      } catch (error) {
        const terminated = vm ? await this.deps.runtime.terminate(vm.microvmId) : false;
        /* Preserve a no-id PENDING intent after an ambiguous provider failure:
         * the successor replays the same token. Once a VM id is known, it was
         * terminated above and the intent must be retired. */
        if (vm) {
          const failed: RuntimeSessionRecord = {
            ...launchIntent,
            microvm_id: terminated ? undefined : vm.microvmId,
            endpoint: terminated ? undefined : vm.endpoint,
            state: terminated ? 'TERMINATED' : 'TERMINATING',
            last_seen_at: this.now(),
            last_error: terminated
              ? (error instanceof Error ? error.message : 'Hosted app launch failed')
              : 'Hosted app launch failed and its MicroVM still requires termination',
          };
          await this.deps.registry.write(failed, lockToken, { signal })
            .catch(() => false);
        } else if (
          error instanceof HostedAppMicrovmError
          && (error.code === 'hosted_app_boot_failed' || !error.transient)
        ) {
          /* No VM id escaped launch(), and these outcomes prove AWS did not
           * leave a live resource: deterministic rejection, or both boot
           * attempts reached a terminal state. Let the next request allocate a
           * fresh generation instead of replaying dead tokens forever. */
          await this.deps.registry.write({
            ...launchIntent,
            state: 'TERMINATED',
            last_seen_at: this.now(),
            last_error: error.message,
          }, lockToken, { signal }).catch(() => false);
        }
        throw error;
      }
    });
  }

  async status(
    hostedAppRuntimeId: string,
    owner: HostedAppOwner,
    signal: AbortSignal,
  ): Promise<HostedAppPublicStatus> {
    const record = await this.deps.registry.read(hostedAppRuntimeId, { signal });
    if (!record?.hosted_app) {
      throw new HostedAppControlPlaneError('hosted_app_not_found', 'Hosted app not found', 404);
    }
    assertHostedAppOwned(record, owner);
    return hostedAppPublicStatus(record, this.now());
  }

  async stop(
    hostedAppRuntimeId: string,
    owner: HostedAppOwner,
    signal: AbortSignal,
  ): Promise<HostedAppPublicStatus> {
    return this.withLease(hostedAppRuntimeId, signal, async (leaseSignal, lockToken) => {
      let record = await this.deps.registry.read(hostedAppRuntimeId, { signal: leaseSignal });
      if (!record?.hosted_app) {
        throw new HostedAppControlPlaneError('hosted_app_not_found', 'Hosted app not found', 404);
      }
      assertHostedAppOwned(record, owner);
      if (
        record.state === 'PENDING'
        && !record.microvm_id
        && (
          record.hard_deadline_at == null
          || record.hard_deadline_at
            + HOSTED_APP_DEADLINE_HEADROOM_MS
            + this.deps.runtime.config.launchTimeoutMs > this.now()
        )
      ) {
        const replayable = Boolean(
          record.launch_client_token
          && record.launch_fingerprint === hostedAppLaunchFingerprint(this.deps.runtime.config)
          && record.launch_request_fingerprint
            === hostedAppLaunchRequestFingerprint(this.deps.runtime.config)
        );
        if (!replayable) {
          /* The provider may still have accepted this request. Retain the
           * intent until its maximum provider lifetime passes rather than
           * claiming it was stopped and losing the only safe recovery key. */
          throw new HostedAppControlPlaneError(
            'hosted_app_stop_pending',
            'The pending hosted app launch must be recovered before it can be stopped',
            409,
            true,
          );
        }
        const launched = await this.deps.runtime.launch(
          record.launch_client_token as string,
          leaseSignal,
        );
        const recovered: RuntimeSessionRecord = {
          ...record,
          launch_client_token: launched.clientToken,
          microvm_id: launched.vm.microvmId,
          endpoint: launched.vm.endpoint,
          image_arn: launched.vm.imageArn ?? record.image_arn,
          image_version: launched.vm.imageVersion ?? record.image_version,
          launched_at: Number.isFinite(launched.vm.startedAtMs)
            ? launched.vm.startedAtMs
            : record.launched_at,
          hard_deadline_at: Number.isFinite(launched.vm.startedAtMs)
            ? (launched.vm.startedAtMs as number)
              + this.deps.runtime.config.maximumDurationSeconds * 1_000
              - HOSTED_APP_DEADLINE_HEADROOM_MS
            : record.hard_deadline_at,
          last_seen_at: this.now(),
        };
        try {
          await this.writeOrFence(recovered, lockToken, leaseSignal);
        } catch (error) {
          /* A recovered VM must never escape merely because we lost the Redis
           * fence while recording its id. */
          await this.deps.runtime.terminate(launched.vm.microvmId).catch(() => false);
          throw error;
        }
        record = recovered;
      }
      if (record.microvm_id) {
        const terminating: RuntimeSessionRecord = {
          ...record,
          state: 'TERMINATING',
          last_seen_at: this.now(),
        };
        await this.writeOrFence(terminating, lockToken, leaseSignal);
        if (!await this.deps.runtime.terminate(record.microvm_id)) {
          await this.writeOrFence({
            ...record,
            state: record.state === 'RUNNING' ? 'RUNNING' : 'TERMINATING',
            last_seen_at: this.now(),
            last_error: 'Could not terminate the hosted app',
          }, lockToken, leaseSignal);
          throw new HostedAppControlPlaneError(
            'hosted_app_stop_failed',
            'Could not terminate the hosted app',
            503,
            true,
          );
        }
      }
      const stopped: RuntimeSessionRecord = {
        ...record,
        microvm_id: undefined,
        endpoint: undefined,
        state: 'TERMINATED',
        last_seen_at: this.now(),
        last_error: undefined,
        hosted_app: {
          ...(record.hosted_app as NonNullable<RuntimeSessionRecord['hosted_app']>),
          preview_credential: undefined,
          preview_credential_expires_at: undefined,
        },
      };
      await this.writeOrFence(stopped, lockToken, leaseSignal);
      return hostedAppPublicStatus(stopped, this.now());
    });
  }

  async refreshPreview(
    hostedAppRuntimeId: string,
    owner: HostedAppOwner,
    signal: AbortSignal,
  ): Promise<HostedAppPublicStatus> {
    return this.withLease(hostedAppRuntimeId, signal, async (leaseSignal, lockToken) => {
      const record = await this.deps.registry.read(hostedAppRuntimeId, { signal: leaseSignal });
      if (!record?.hosted_app) {
        throw new HostedAppControlPlaneError(
          'hosted_app_not_running',
          'Hosted app is not running',
          409,
          true,
        );
      }
      assertHostedAppOwned(record, owner);
      if (
        record.state !== 'RUNNING'
        || !record.microvm_id
        || !record.endpoint
        || record.hard_deadline_at == null
        || record.hard_deadline_at <= this.now()
      ) {
        throw new HostedAppControlPlaneError(
          'hosted_app_not_running',
          'Hosted app is not running',
          409,
          true,
        );
      }
      return hostedAppPublicStatus(
        await this.persistPreviewCredential(
          record,
          this.recordedVm(record),
          lockToken,
          leaseSignal,
        ),
        this.now(),
      );
    });
  }

  private recordedVm(record: RuntimeSessionRecord): MicrovmDescription {
    return {
      microvmId: record.microvm_id as string,
      endpoint: record.endpoint,
      state: 'RUNNING',
      imageArn: record.image_arn,
      imageVersion: record.image_version,
    };
  }

  private async persistPreviewCredential(
    record: RuntimeSessionRecord,
    vm: MicrovmDescription,
    lockToken: string,
    signal: AbortSignal,
  ): Promise<RuntimeSessionRecord> {
    const credential = await this.deps.runtime.previewToken(vm.microvmId, signal);
    if (credential.expiresAtMs <= this.now()) {
      throw new HostedAppControlPlaneError(
        'hosted_app_preview_unavailable',
        'Hosted app preview credential is unavailable',
        503,
        true,
      );
    }
    const running: RuntimeSessionRecord = {
      ...record,
      state: 'RUNNING',
      last_seen_at: this.now(),
      last_error: undefined,
      hosted_app: {
        ...(record.hosted_app as NonNullable<RuntimeSessionRecord['hosted_app']>),
        preview_credential: sealHostedAppCredential(
          record.runtime_session_id,
          credential,
          this.deps.credentialKey,
        ),
        preview_credential_expires_at: credential.expiresAtMs,
      },
    };
    await this.writeOrFence(running, lockToken, signal);
    return running;
  }

  private async writeOrFence(
    record: RuntimeSessionRecord,
    lockToken: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (!await this.deps.registry.write(record, lockToken, { signal })) {
      signal.throwIfAborted();
      throw new HostedAppControlPlaneError(
        'hosted_app_fenced',
        'Lost the hosted app lease while updating it',
        409,
        true,
      );
    }
  }

  private async withLease<T>(
    runtimeId: string,
    callerSignal: AbortSignal,
    operation: (signal: AbortSignal, lockToken: string) => Promise<T>,
  ): Promise<T> {
    const lockToken = await this.deps.registry.waitForLock(runtimeId, {
      waitMs: this.deps.lockWaitMs,
      ttlMs: this.deps.lockTtlMs,
      signal: callerSignal,
    });
    if (!lockToken) {
      throw new HostedAppControlPlaneError(
        'hosted_app_busy',
        'Another hosted app transition is in progress',
        409,
        true,
      );
    }
    const fence = new AbortController();
    const signal = AbortSignal.any([callerSignal, fence.signal]);
    const heartbeat = this.deps.startHeartbeat({
      renew: () => this.deps.registry.renewLock(
        runtimeId,
        lockToken,
        this.deps.lockTtlMs,
        { signal: callerSignal, onLateLost: () => fence.abort() },
      ),
      fence,
      ttlMs: this.deps.lockTtlMs,
    });
    try {
      return await operation(signal, lockToken);
    } finally {
      heartbeat.stop();
      await this.deps.registry.releaseLock(runtimeId, lockToken);
    }
  }
}
