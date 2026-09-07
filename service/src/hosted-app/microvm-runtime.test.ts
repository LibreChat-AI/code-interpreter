import { describe, expect, test } from 'bun:test';
import { FakeLambdaMicrovmClient } from '../runtime-session/lambda-client-fake';
import { LambdaMicrovmApiError } from '../runtime-session/lambda-client';
import { MicrovmOpThrottledError } from '../runtime-session/throttle';
import {
  hostedAppLaunchFingerprint,
  hostedAppLaunchGenerationSeed,
  hostedAppLaunchRequestFingerprint,
  HostedAppMicrovmError,
  HostedAppMicrovmRuntime,
  type HostedAppMicrovmConfig,
} from './microvm-runtime';
import type { ResidentHostedAppSpec } from './spec';

function config(): HostedAppMicrovmConfig {
  return {
    imageArn: 'arn:aws:lambda:us-east-2:1:microvm-image:app-host',
    imageVersion: '7',
    executionRoleArn: 'arn:aws:iam::1:role/app-host',
    logGroup: '/aws/lambda-microvm/codeapi-app-host',
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
}

const spec: ResidentHostedAppSpec = {
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

function runtime(
  fake: FakeLambdaMicrovmClient,
  fetchImpl: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
    = async () => new Response('{}', { status: 200 }),
) {
  const reservations: string[] = [];
  const poisons: string[] = [];
  return {
    reservations,
    poisons,
    runtime: new HostedAppMicrovmRuntime(fake, config(), {
      reserveOp: async op => { reservations.push(op); },
      poisonOp: async op => { poisons.push(op); },
      fetch: fetchImpl,
      sleep: async () => {},
    }),
  };
}

describe('HostedAppMicrovmRuntime', () => {
  test('keeps suspended recovery ambiguous when the shared resume budget is exhausted', async () => {
    const fake = new FakeLambdaMicrovmClient();
    const signal = new AbortController().signal;
    const { vm } = await runtime(fake).runtime.launch('resume-budget', signal);
    await fake.suspendMicrovm(vm.microvmId);
    const limited = new HostedAppMicrovmRuntime(fake, config(), {
      reserveOp: async op => { if (op === 'resume') throw new MicrovmOpThrottledError('resume', 1); },
    });
    const failure = await limited.launch('resume-budget', signal).catch(error => error);
    expect(failure.transient).toBe(true);
    expect(fake.callsFor('resumeMicrovm')).toHaveLength(0);
    expect(fake.vms.size).toBe(1);
  });
  test('reserves and poisons the distributed resume budget on provider throttling', async () => {
    const fake = new FakeLambdaMicrovmClient();
    const f = runtime(fake);
    const signal = new AbortController().signal;
    const { vm } = await f.runtime.launch('resume-throttle', signal);
    await fake.suspendMicrovm(vm.microvmId);
    fake.failNext('resumeMicrovm', new LambdaMicrovmApiError('throttled', 'ResumeMicrovm', 'throttled'));
    await expect(f.runtime.launch('resume-throttle', signal)).rejects.toThrow('throttled');
    expect(f.reservations).toEqual(['run', 'run', 'resume']);
    expect(f.poisons).toEqual(['resume']);
  });

  test('does not turn control-token failure into evidence of an unhealthy VM', async () => {
    const fake = new FakeLambdaMicrovmClient();
    const f = runtime(fake);
    const signal = new AbortController().signal;
    const { vm } = await f.runtime.launch('health-auth', signal);
    fake.failNext('createMicrovmAuthToken', new LambdaMicrovmApiError('throttled', 'CreateMicrovmAuthToken', 'throttled'));
    const failure = await f.runtime.waitForControlReady(vm, signal).catch(error => error);
    expect(failure.code).toBe('hosted_app_auth_failed');
  });
  test('cancels unsuccessful and successful health response bodies before continuing', async () => {
    const fake = new FakeLambdaMicrovmClient();
    let probes = 0;
    let canceled = 0;
    const f = runtime(fake, async () => {
      expect(canceled).toBe(probes);
      probes++;
      return new Response(new ReadableStream({ cancel() { canceled++; } }), {
        status: probes === 1 ? 503 : 200,
      });
    });
    const signal = new AbortController().signal;
    const { vm } = await f.runtime.launch('health-disposal', signal);
    await f.runtime.waitForControlReady(vm, signal);
    expect(canceled).toBe(2);
  });

  test('reads session-bound resident status and rejects mismatched revision', async () => {
    const fake = new FakeLambdaMicrovmClient();
    let revision = spec.revision;
    const f = runtime(fake, async (url, init) => {
      expect(String(url)).toEndWith('/api/v2/hosted-app/status');
      expect(new Headers(init?.headers).get('X-Runtime-Session-Id')).toBe('source');
      return Response.json({ app_id: spec.app_id, revision, state: 'failed' });
    });
    const signal = new AbortController().signal;
    const { vm } = await f.runtime.launch('status', signal);
    expect(await f.runtime.residentAppState(vm, 'source', spec, signal)).toBe('failed');
    revision = 'wrong-revision';
    await expect(f.runtime.residentAppState(vm, 'source', spec, signal)).rejects.toThrow('does not match');
  });
  test('keeps a second-attempt cancellation ambiguous and replayable', async () => {
    const fake = new FakeLambdaMicrovmClient();
    fake.terminateNextLaunch();
    const caller = new AbortController();
    let attempts = 0;
    const run = fake.runMicrovm.bind(fake);
    fake.runMicrovm = async (...args) => {
      const vm = await run(...args);
      if (++attempts === 2) {
        caller.abort(new Error('caller left after provider acceptance'));
        throw caller.signal.reason;
      }
      return vm;
    };
    const error = await runtime(fake).runtime.launch('retry-abort', caller.signal).catch(e => e);
    expect(error.transient).toBe(true);
    expect(fake.callsFor('runMicrovm').map(c => (c.args as { clientToken: string }).clientToken))
      .toEqual(['retry-abort', 'retry-abort-r1']);
    const recovered = await runtime(fake).runtime.launch('retry-abort', new AbortController().signal);
    expect(recovered.clientToken).toBe('retry-abort-r1');
    expect(fake.vms.size).toBe(2);
  });

  test('classifies a resident-start network reset as transient', async () => {
    const fake = new FakeLambdaMicrovmClient();
    const f = runtime(fake, async () => { throw new TypeError('fetch failed'); });
    const signal = new AbortController().signal;
    const { vm } = await f.runtime.launch('resident-reset', signal);
    const error = await f.runtime.startResidentApp(vm, 'source', spec, signal).catch(e => e);
    expect(error).toBeInstanceOf(HostedAppMicrovmError);
    expect(error.transient).toBe(true);
  });
  test('seeds idempotency from exact wire inputs while keeping semantic matching order-independent', () => {
    const first = { ...config(), ingressConnectorArns: ['arn:b', 'arn:a'] };
    const reordered = { ...config(), ingressConnectorArns: ['arn:a', 'arn:b'] };
    expect(hostedAppLaunchFingerprint(first)).toBe(hostedAppLaunchFingerprint(reordered));
    expect(hostedAppLaunchRequestFingerprint(first)).not.toBe(
      hostedAppLaunchRequestFingerprint(reordered),
    );
    expect(hostedAppLaunchGenerationSeed(first)).not.toBe(hostedAppLaunchGenerationSeed(reordered));
  });

  test('launches the dedicated image with bounded idle policy and no egress connector', async () => {
    const fake = new FakeLambdaMicrovmClient();
    const fixture = runtime(fake);

    const launched = await fixture.runtime.launch('sess-happ-1', new AbortController().signal);

    expect(launched.clientToken).toBe('sess-happ-1');
    expect(launched.vm.state).toBe('RUNNING');
    expect(fixture.reservations).toEqual(['run']);
    const args = fake.callsFor('runMicrovm')[0].args as Record<string, unknown>;
    expect(args).toMatchObject({
      imageIdentifier: config().imageArn,
      imageVersion: '7',
      maximumDurationSeconds: 28_800,
      idlePolicy: {
        maxIdleSeconds: 300,
        suspendedSeconds: 900,
        autoResume: true,
      },
    });
    expect(args.egressConnectorArns).toBeUndefined();
  });

  test('retries a definite boot-time death once under a distinct token', async () => {
    const fake = new FakeLambdaMicrovmClient();
    fake.terminateNextLaunch();
    const fixture = runtime(fake);

    const launched = await fixture.runtime.launch('sess-happ-2', new AbortController().signal);

    expect(launched.clientToken).toBe('sess-happ-2-r1');
    expect(fake.callsFor('runMicrovm').map(call => (
      call.args as { clientToken?: string }
    ).clientToken)).toEqual(['sess-happ-2', 'sess-happ-2-r1']);
  });

  test('resumes a suspended same-token launch instead of provisioning a second VM', async () => {
    const fake = new FakeLambdaMicrovmClient();
    const fixture = runtime(fake);
    const first = await fixture.runtime.launch('sess-happ-recovered', new AbortController().signal);
    await fake.suspendMicrovm(first.vm.microvmId);

    const recovered = await fixture.runtime.launch(
      'sess-happ-recovered',
      new AbortController().signal,
    );

    expect(recovered.vm.microvmId).toBe(first.vm.microvmId);
    expect(recovered.clientToken).toBe('sess-happ-recovered');
    expect(fake.vms.size).toBe(1);
    expect(fake.callsFor('resumeMicrovm')).toHaveLength(1);
    expect(fake.callsFor('runMicrovm').map(call => (
      call.args as { clientToken?: string }
    ).clientToken)).toEqual(['sess-happ-recovered', 'sess-happ-recovered']);
  });

  test('does not rotate the idempotency token after an ambiguous provider failure', async () => {
    const fake = new FakeLambdaMicrovmClient();
    fake.failNext('runMicrovm', new LambdaMicrovmApiError(
      'other',
      'RunMicrovm',
      'connection reset after request write',
    ));
    const fixture = runtime(fake);

    const error = await fixture.runtime.launch(
      'sess-happ-3',
      new AbortController().signal,
    ).catch(value => value);

    expect(error.code).toBe('hosted_app_launch_failed');
    expect(fake.callsFor('runMicrovm')).toHaveLength(1);
  });

  test('reuses one control credential while polling health', async () => {
    const fake = new FakeLambdaMicrovmClient({ endpointProvider: () => 'http://app-host.test' });
    let probes = 0;
    const fixture = runtime(fake, async () => {
      probes += 1;
      return new Response('{}', { status: probes < 3 ? 503 : 200 });
    });
    const { vm } = await fixture.runtime.launch('sess-happ-4', new AbortController().signal);

    await fixture.runtime.waitForControlReady(vm, new AbortController().signal);

    expect(probes).toBe(3);
    expect(fake.callsFor('createMicrovmAuthToken')).toHaveLength(1);
  });

  test('starts the resident app through the control port with its session binding', async () => {
    const fake = new FakeLambdaMicrovmClient({ endpointProvider: () => 'http://app-host.test' });
    let captured: { url: string; init?: RequestInit } | undefined;
    const fixture = runtime(fake, async (input, init) => {
      captured = { url: String(input), init };
      return new Response('{}', { status: 200 });
    });
    const { vm } = await fixture.runtime.launch('sess-happ-5', new AbortController().signal);

    await fixture.runtime.startResidentApp(
      vm,
      'rt_source_session',
      spec,
      new AbortController().signal,
    );

    expect(captured?.url).toBe('http://app-host.test/api/v2/hosted-app/start');
    expect(captured?.init?.method).toBe('POST');
    expect(captured?.init?.headers).toMatchObject({
      'X-aws-proxy-auth': expect.any(String),
      'X-Runtime-Session-Id': 'rt_source_session',
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(String(captured?.init?.body))).toEqual(spec);
  });

  test('preserves a runner validation status as a non-retryable typed failure', async () => {
    const fake = new FakeLambdaMicrovmClient({ endpointProvider: () => 'http://app-host.test' });
    const fixture = runtime(fake, async () => new Response(JSON.stringify({
      error: 'hosted_app_runtime_not_found',
      message: 'runtime node@99 is not installed',
    }), { status: 400 }));
    const { vm } = await fixture.runtime.launch('sess-happ-6', new AbortController().signal);

    const error = await fixture.runtime.startResidentApp(
      vm,
      'rt_source_session',
      spec,
      new AbortController().signal,
    ).catch(value => value);

    expect(error).toBeInstanceOf(HostedAppMicrovmError);
    expect(error.httpStatus).toBe(400);
    expect(error.transient).toBe(false);
  });
});
