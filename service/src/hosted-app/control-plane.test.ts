import { describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import type { CheckpointStore } from '../runtime-session/checkpoint-store';
import type { MicrovmDescription } from '../runtime-session/lambda-client';
import type { RuntimeSessionRecord } from '../runtime-session/registry';
import {
  HostedAppControlPlane,
  HostedAppControlPlaneError,
  hostedAppPublicStatus,
  type HostedAppRegistry,
} from './control-plane';
import { openHostedAppCredential } from './credential';
import {
  hostedAppLaunchClientToken,
  hostedAppLaunchFingerprint,
  hostedAppLaunchGenerationSeed,
  hostedAppLaunchRequestFingerprint,
  HostedAppMicrovmError,
  type HostedAppMicrovmConfig,
  type HostedAppMicrovmRuntime,
} from './microvm-runtime';
import { hostedAppSpecFingerprint, type ResidentHostedAppSpec } from './spec';

const appSpec: ResidentHostedAppSpec = {
  adapter: 'resident',
  app_id: 'demo',
  revision: 'rev-1',
  language: 'node',
  version: '>=22',
  entrypoint: 'server.js',
  cwd: '.',
  args: [],
  env: {},
};

const runtimeConfig: HostedAppMicrovmConfig = {
  imageArn: 'arn:aws:lambda:us-east-2:1:microvm-image:app-host',
  imageVersion: '7',
  executionRoleArn: 'arn:aws:iam::1:role/app-host',
  ingressConnectorArns: ['arn:ingress/private'],
  controlPort: 8080,
  previewPort: 3000,
  maximumDurationSeconds: 28_800,
  idleSeconds: 300,
  suspendedSeconds: 900,
  authTokenTtlSeconds: 3_600,
  launchTimeoutMs: 5_000,
  healthTimeoutMs: 500,
  appStartTimeoutMs: 2_000,
  launchTps: 4,
  tokenTps: 8,
};

class MemoryRegistry implements HostedAppRegistry {
  record: RuntimeSessionRecord | null = null;
  generation = hostedAppLaunchGenerationSeed(runtimeConfig);
  writes: RuntimeSessionRecord[] = [];
  allocations = 0;

  async waitForLock(): Promise<string> { return 'lock'; }
  async renewLock(): Promise<'held'> { return 'held'; }
  async releaseLock(): Promise<void> {}
  async read(): Promise<RuntimeSessionRecord | null> {
    return this.record ? structuredClone(this.record) : null;
  }
  async write(record: RuntimeSessionRecord, token: string): Promise<boolean> {
    if (token !== 'lock') return false;
    this.record = structuredClone(record);
    this.writes.push(structuredClone(record));
    return true;
  }
  async allocateGeneration(): Promise<number> {
    this.allocations += 1;
    return this.generation;
  }
}

class FakeRuntime {
  readonly config = runtimeConfig;
  launches: string[] = [];
  starts: Array<{ vm: string; source: string; spec: ResidentHostedAppSpec }> = [];
  healthChecks: string[] = [];
  terminations: string[] = [];
  previewMints = 0;
  previewExpiresAt = 1_900_000_000_000;
  startedAtMs?: number;
  terminateSucceeds = true;
  launchError?: Error;
  healthError?: Error;

  async launch(clientToken: string): Promise<{ vm: MicrovmDescription; clientToken: string }> {
    this.launches.push(clientToken);
    if (this.launchError) throw this.launchError;
    return {
      vm: {
        microvmId: 'vm-app-1',
        endpoint: 'https://vm-app-1.test',
        state: 'RUNNING',
        startedAtMs: this.startedAtMs,
        imageArn: runtimeConfig.imageArn,
        imageVersion: runtimeConfig.imageVersion,
      },
      clientToken,
    };
  }
  async waitForControlReady(vm: MicrovmDescription): Promise<void> {
    this.healthChecks.push(vm.microvmId);
    if (this.healthError) {
      const error = this.healthError;
      this.healthError = undefined;
      throw error;
    }
  }
  async startResidentApp(
    vm: MicrovmDescription,
    source: string,
    spec: ResidentHostedAppSpec,
  ): Promise<void> {
    this.starts.push({ vm: vm.microvmId, source, spec });
  }
  async previewToken() {
    this.previewMints += 1;
    return {
      headerName: 'X-aws-proxy-auth',
      token: `secret-token-${this.previewMints}`,
      expiresAtMs: this.previewExpiresAt,
    };
  }
  async terminate(microvmId: string): Promise<boolean> {
    this.terminations.push(microvmId);
    return this.terminateSucceeds;
  }
}

function fixture(options: {
  registry?: MemoryRegistry;
  runtime?: FakeRuntime;
  restore?: 'restored' | 'absent' | 'fetch_failed' | 'push_failed';
} = {}) {
  const registry = options.registry ?? new MemoryRegistry();
  const runtime = options.runtime ?? new FakeRuntime();
  const credentialKey = randomBytes(32);
  const captures: string[] = [];
  const restores: string[] = [];
  const control = new HostedAppControlPlane({
    registry,
    runtime: runtime as unknown as HostedAppMicrovmRuntime,
    checkpointStore: {} as CheckpointStore,
    checkpointConfig: {
      port: 8080,
      authTokenTtlSeconds: 3_600,
      maxBytes: 1024,
      timeoutMs: 1_000,
    },
    credentialKey,
    lockWaitMs: 50,
    lockTtlMs: 5_000,
    captureCheckpoint: async source => {
      captures.push(source);
      return `rtsx-checkpoints/${source}/0001.tar.gz`;
    },
    restoreCheckpoint: async args => {
      restores.push(args.checkpointKey);
      return options.restore ?? 'restored';
    },
    startHeartbeat: () => ({ stop() {} }),
    now: () => 1_800_000_000_000,
  });
  return { control, registry, runtime, credentialKey, captures, restores };
}

const input = {
  hostedAppRuntimeId: 'happ_123',
  sourceRuntimeSessionId: 'rt_source',
  tenantId: 'tenant-1',
  canonicalUserId: 'user-1',
  spec: appSpec,
  signal: new AbortController().signal,
};

function pendingRecord(): RuntimeSessionRecord {
  const generation = hostedAppLaunchGenerationSeed(runtimeConfig);
  return {
    runtime_session_id: input.hostedAppRuntimeId,
    tenant_id: input.tenantId,
    canonical_user_id: input.canonicalUserId,
    state: 'PENDING',
    generation,
    launched_at: 1_799_999_000_000,
    hard_deadline_at: 1_800_010_000_000,
    last_seen_at: 1_799_999_000_000,
    image_arn: runtimeConfig.imageArn,
    image_version: runtimeConfig.imageVersion,
    port: runtimeConfig.previewPort,
    launch_fingerprint: hostedAppLaunchFingerprint(runtimeConfig),
    launch_request_fingerprint: hostedAppLaunchRequestFingerprint(runtimeConfig),
    launch_client_token: hostedAppLaunchClientToken(input.hostedAppRuntimeId, generation),
    hosted_app: {
      source_runtime_session_id: input.sourceRuntimeSessionId,
      app_id: appSpec.app_id,
      revision: appSpec.revision,
      spec_fingerprint: hostedAppSpecFingerprint(appSpec),
      spec: appSpec,
      checkpoint_key: 'rtsx-checkpoints/rt_source/exact.tar.gz',
    },
  };
}

describe('HostedAppControlPlane', () => {
  test('does not advertise an expired AWS lease as a running preview', () => {
    const expired = {
      ...pendingRecord(),
      state: 'RUNNING' as const,
      microvm_id: 'vm-expired',
      endpoint: 'https://vm-expired.test',
      hard_deadline_at: 99,
    };
    expect(hostedAppPublicStatus(expired, 100).state).toBe('stopped');
  });

  test('does not expose provider details persisted in an internal failure record', () => {
    const failed = {
      ...pendingRecord(),
      state: 'TERMINATED' as const,
      last_error: 'AccessDenied for arn:aws:iam::123456789012:role/private',
    };
    const status = hostedAppPublicStatus(failed);
    expect(status.state).toBe('failed');
    expect(status.error).toBe('Hosted app operation failed');
    expect(JSON.stringify(status)).not.toContain('123456789012');
  });

  test('checkpoints, launches, restores, starts, and persists only a sealed preview credential', async () => {
    const f = fixture();

    const status = await f.control.start(input);

    expect(status).toMatchObject({ state: 'running', preview_id: 'happ_123', revision: 'rev-1' });
    expect(f.captures).toEqual(['rt_source']);
    expect(f.restores).toEqual(['rtsx-checkpoints/rt_source/0001.tar.gz']);
    expect(f.runtime.starts).toHaveLength(1);
    expect(f.registry.writes.map(record => record.state)).toEqual(['PENDING', 'PENDING', 'RUNNING']);
    expect(JSON.stringify(f.registry.record)).not.toContain('secret-token-1');
    const sealed = f.registry.record?.hosted_app?.preview_credential as string;
    expect(openHostedAppCredential('happ_123', sealed, f.credentialKey).token).toBe('secret-token-1');
  });

  test('derives the advertised lease deadline from the provider start time', async () => {
    const runtime = new FakeRuntime();
    runtime.startedAtMs = 1_800_000_000_500;
    const f = fixture({ runtime });

    await f.control.start(input);

    expect(f.registry.record?.launched_at).toBe(runtime.startedAtMs);
    expect(f.registry.record?.hard_deadline_at).toBe(
      runtime.startedAtMs + runtimeConfig.maximumDurationSeconds * 1_000 - 60_000,
    );
  });

  test('replays an exact pending launch intent without taking a different checkpoint', async () => {
    const registry = new MemoryRegistry();
    registry.record = pendingRecord();
    const f = fixture({ registry });

    await f.control.start(input);

    expect(f.captures).toEqual([]);
    expect(registry.allocations).toBe(0);
    expect(f.runtime.launches).toEqual([pendingRecord().launch_client_token as string]);
    expect(f.restores).toEqual(['rtsx-checkpoints/rt_source/exact.tar.gz']);
  });

  test('rejects changed launch settings under an immutable revision', async () => {
    const registry = new MemoryRegistry();
    registry.record = pendingRecord();
    const f = fixture({ registry });
    const changed = { ...input, spec: { ...appSpec, args: ['--changed'] } };

    const error = await f.control.start(changed).catch(value => value);

    expect(error).toBeInstanceOf(HostedAppControlPlaneError);
    expect(error.code).toBe('hosted_app_revision_conflict');
    expect(f.runtime.launches).toEqual([]);
  });

  test('does not overwrite an ambiguous pending provider launch with a new revision', async () => {
    const registry = new MemoryRegistry();
    registry.record = pendingRecord();
    const f = fixture({ registry });

    const error = await f.control.start({
      ...input,
      spec: { ...appSpec, revision: 'rev-2' },
    }).catch(value => value);

    expect(error.code).toBe('hosted_app_launch_in_progress');
    expect(f.captures).toEqual([]);
    expect(registry.allocations).toBe(0);
    expect(f.runtime.launches).toEqual([]);
  });

  test('reasserts an exact running revision and rotates its preview credential', async () => {
    const registry = new MemoryRegistry();
    registry.record = {
      ...pendingRecord(),
      state: 'RUNNING',
      microvm_id: 'vm-existing',
      endpoint: 'https://vm-existing.test',
    };
    const f = fixture({ registry });

    await f.control.start(input);

    expect(f.captures).toEqual([]);
    expect(f.runtime.launches).toEqual([]);
    expect(f.runtime.healthChecks).toEqual(['vm-existing']);
    expect(f.runtime.starts).toHaveLength(1);
    expect(f.runtime.previewMints).toBe(1);
  });

  test('recycles a dead app VM and restores the exact immutable revision checkpoint', async () => {
    const registry = new MemoryRegistry();
    registry.record = {
      ...pendingRecord(),
      state: 'RUNNING',
      microvm_id: 'vm-dead',
      endpoint: 'https://vm-dead.test',
    };
    const runtime = new FakeRuntime();
    runtime.healthError = new HostedAppMicrovmError(
      'hosted_app_unhealthy',
      'endpoint is gone',
      true,
    );
    const f = fixture({ registry, runtime });

    await f.control.start(input);

    expect(f.captures).toEqual([]);
    expect(runtime.terminations).toEqual(['vm-dead']);
    expect(runtime.launches).toHaveLength(1);
    expect(f.restores).toEqual(['rtsx-checkpoints/rt_source/exact.tar.gz']);
  });

  test('records replacement cleanup before terminating the prior revision', async () => {
    const registry = new MemoryRegistry();
    registry.record = {
      ...pendingRecord(),
      state: 'RUNNING',
      microvm_id: 'vm-old-revision',
      endpoint: 'https://vm-old-revision.test',
    };
    registry.allocateGeneration = async () => {
      throw new Error('generation store unavailable');
    };
    const runtime = new FakeRuntime();
    const f = fixture({ registry, runtime });

    await f.control.start({
      ...input,
      spec: { ...appSpec, revision: 'rev-2' },
    }).catch(() => undefined);

    expect(runtime.terminations).toEqual(['vm-old-revision']);
    expect(registry.record).toMatchObject({
      state: 'TERMINATING',
      microvm_id: 'vm-old-revision',
      endpoint: 'https://vm-old-revision.test',
    });
  });

  test('terminates and retires a VM whose exact checkpoint cannot be restored', async () => {
    const f = fixture({ restore: 'fetch_failed' });

    const error = await f.control.start(input).catch(value => value);

    expect(error.code).toBe('hosted_app_restore_failed');
    expect(f.runtime.terminations).toEqual(['vm-app-1']);
    expect(f.registry.record).toMatchObject({ state: 'TERMINATED', microvm_id: undefined });
  });

  test('retains a failed launch VM id until termination can be confirmed', async () => {
    const runtime = new FakeRuntime();
    runtime.terminateSucceeds = false;
    const f = fixture({ restore: 'push_failed', runtime });

    await f.control.start(input).catch(() => undefined);

    expect(f.registry.record).toMatchObject({
      state: 'TERMINATING',
      microvm_id: 'vm-app-1',
      endpoint: 'https://vm-app-1.test',
    });
  });

  test('a failed stop keeps the possibly-live app running and retryable', async () => {
    const registry = new MemoryRegistry();
    registry.record = {
      ...pendingRecord(),
      state: 'RUNNING',
      microvm_id: 'vm-existing',
      endpoint: 'https://vm-existing.test',
    };
    const runtime = new FakeRuntime();
    runtime.terminateSucceeds = false;
    const f = fixture({ registry, runtime });

    const error = await f.control.stop(
      input.hostedAppRuntimeId,
      input,
      input.signal,
    ).catch(value => value);

    expect(error.code).toBe('hosted_app_stop_failed');
    expect(registry.record).toMatchObject({
      state: 'RUNNING',
      microvm_id: 'vm-existing',
      last_error: 'Could not terminate the hosted app',
    });
  });

  test('stop replays an ambiguous pending launch before terminating it', async () => {
    const registry = new MemoryRegistry();
    registry.record = pendingRecord();
    const f = fixture({ registry });

    const status = await f.control.stop(input.hostedAppRuntimeId, input, input.signal);

    expect(status.state).toBe('stopped');
    expect(f.runtime.launches).toEqual([pendingRecord().launch_client_token as string]);
    expect(f.runtime.terminations).toEqual(['vm-app-1']);
    expect(registry.writes.map(record => record.state)).toEqual([
      'PENDING',
      'TERMINATING',
      'TERMINATED',
    ]);
    expect(registry.record).toMatchObject({
      state: 'TERMINATED',
      microvm_id: undefined,
      endpoint: undefined,
    });
  });

  test('stop preserves an ambiguous pending intent when recovery fails', async () => {
    const registry = new MemoryRegistry();
    registry.record = pendingRecord();
    const runtime = new FakeRuntime();
    runtime.launchError = new HostedAppMicrovmError(
      'hosted_app_launch_failed',
      'connection reset after provider accepted the request',
      true,
    );
    const f = fixture({ registry, runtime });

    const error = await f.control.stop(input.hostedAppRuntimeId, input, input.signal)
      .catch(value => value);

    expect(error.code).toBe('hosted_app_launch_failed');
    expect(registry.writes).toEqual([]);
    expect(registry.record).toEqual(pendingRecord());
  });

  test('stop does not overwrite a pending intent that current config cannot replay', async () => {
    const registry = new MemoryRegistry();
    registry.record = { ...pendingRecord(), launch_fingerprint: 'different-image' };
    const f = fixture({ registry });

    const error = await f.control.stop(input.hostedAppRuntimeId, input, input.signal)
      .catch(value => value);

    expect(error.code).toBe('hosted_app_stop_pending');
    expect(error.transient).toBe(true);
    expect(f.runtime.launches).toEqual([]);
    expect(registry.writes).toEqual([]);
  });

  test('a failed cleanup never promotes a partial launch to running', async () => {
    const registry = new MemoryRegistry();
    registry.record = {
      ...pendingRecord(),
      state: 'TERMINATING',
      microvm_id: 'vm-partial',
      endpoint: 'https://vm-partial.test',
    };
    const runtime = new FakeRuntime();
    runtime.terminateSucceeds = false;
    const f = fixture({ registry, runtime });

    await f.control.stop(input.hostedAppRuntimeId, input, input.signal)
      .catch(() => undefined);

    expect(registry.record).toMatchObject({
      state: 'TERMINATING',
      microvm_id: 'vm-partial',
    });
  });

  test('retires definite boot exhaustion but preserves an ambiguous launch intent', async () => {
    const definiteRuntime = new FakeRuntime();
    definiteRuntime.launchError = new HostedAppMicrovmError(
      'hosted_app_boot_failed',
      'both attempts terminated',
      true,
    );
    const definite = fixture({ runtime: definiteRuntime });
    await definite.control.start(input).catch(() => undefined);
    expect(definite.registry.record).toMatchObject({ state: 'TERMINATED' });

    const ambiguousRuntime = new FakeRuntime();
    ambiguousRuntime.launchError = new HostedAppMicrovmError(
      'hosted_app_launch_failed',
      'connection reset after write',
      true,
    );
    const ambiguous = fixture({ runtime: ambiguousRuntime });
    await ambiguous.control.start(input).catch(() => undefined);
    expect(ambiguous.registry.record?.state).toBe('PENDING');
    expect(ambiguous.registry.record?.microvm_id).toBeUndefined();
  });

  test('does not refresh a preview after its advertised hard deadline', async () => {
    const registry = new MemoryRegistry();
    registry.record = {
      ...pendingRecord(),
      state: 'RUNNING',
      microvm_id: 'vm-existing',
      endpoint: 'https://vm-existing.test',
      hard_deadline_at: 1_800_000_000_000,
    };
    const f = fixture({ registry });

    const error = await f.control.refreshPreview(input.hostedAppRuntimeId, input, input.signal)
      .catch(value => value);

    expect(error.code).toBe('hosted_app_not_running');
    expect(f.runtime.previewMints).toBe(0);
  });

  test('rejects an already-expired credential instead of publishing it', async () => {
    const runtime = new FakeRuntime();
    runtime.previewExpiresAt = 1_800_000_000_000;
    const f = fixture({ runtime });

    const error = await f.control.start(input).catch(value => value);

    expect(error.code).toBe('hosted_app_preview_unavailable');
    expect(runtime.terminations).toEqual(['vm-app-1']);
    expect(f.registry.record).toMatchObject({ state: 'TERMINATED' });
  });
});
