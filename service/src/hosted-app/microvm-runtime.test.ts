import { describe, expect, test } from 'bun:test';
import { FakeLambdaMicrovmClient } from '../runtime-session/lambda-client-fake';
import { LambdaMicrovmApiError } from '../runtime-session/lambda-client';
import {
  hostedAppLaunchFingerprint,
  hostedAppLaunchGenerationSeed,
  hostedAppLaunchRequestFingerprint,
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
  return {
    reservations,
    runtime: new HostedAppMicrovmRuntime(fake, config(), {
      reserveOp: async op => { reservations.push(op); },
      poisonOp: async () => {},
      fetch: fetchImpl,
      sleep: async () => {},
    }),
  };
}

describe('HostedAppMicrovmRuntime', () => {
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
});
