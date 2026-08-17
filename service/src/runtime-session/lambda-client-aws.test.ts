import { describe, expect, test } from 'bun:test';
import {
    AwsLambdaMicrovmClient,
    type MicrovmCommandSender,
} from './lambda-client-aws';
import { LambdaMicrovmApiError, MICROVM_AUTH_HEADER } from './lambda-client';

type SentCommand = {
    constructor: { name: string };
    input: Record<string, unknown>;
};

function stubSender(responses: unknown[]): {
    sender: MicrovmCommandSender;
    sent: SentCommand[];
} {
    const sent: SentCommand[] = [];
    return {
        sent,
        sender: {
            send(command: unknown): Promise<unknown> {
                sent.push(command as SentCommand);
                const next = responses.shift();
                if (next instanceof Error) return Promise.reject(next);
                return Promise.resolve(next);
            },
        },
    };
}

function namedError(name: string): Error {
    const error = new Error(`${name} raised`);
    error.name = name;
    return error;
}

describe('AwsLambdaMicrovmClient command mapping', () => {
    test('runMicrovm maps args onto RunMicrovmCommand input and normalizes the response', async () => {
        const startedAt = new Date('2026-07-05T00:00:00Z');
        const { sender, sent } = stubSender([
            {
                microvmId: 'mvm-1',
                state: 'PENDING',
                endpoint: 'https://mvm-1.on.aws',
                imageArn: 'arn:aws:lambda:us-east-2:1:microvm-image/codeapi',
                imageVersion: '7',
                maximumDurationInSeconds: 28_800,
                startedAt,
            },
        ]);
        const client = new AwsLambdaMicrovmClient({ client: sender });

        const description = await client.runMicrovm({
            imageIdentifier: 'arn:aws:lambda:us-east-2:1:microvm-image/codeapi',
            imageVersion: '7',
            executionRoleArn: 'arn:aws:iam::1:role/codeapi-microvm',
            ingressConnectorArns: ['arn:ingress'],
            egressConnectorArns: ['arn:egress'],
            maximumDurationSeconds: 28_800,
            idlePolicy: {
                maxIdleSeconds: 300,
                suspendedSeconds: 1_800,
                autoResume: true,
            },
            runHookPayload: '{"runtime_session_id":"rt_x"}',
            clientToken: 'launch-rt_x-7',
        });

        expect(sent[0].constructor.name).toBe('RunMicrovmCommand');
        expect(sent[0].input).toEqual({
            imageIdentifier: 'arn:aws:lambda:us-east-2:1:microvm-image/codeapi',
            imageVersion: '7',
            executionRoleArn: 'arn:aws:iam::1:role/codeapi-microvm',
            ingressNetworkConnectors: ['arn:ingress'],
            egressNetworkConnectors: ['arn:egress'],
            maximumDurationInSeconds: 28_800,
            idlePolicy: {
                maxIdleDurationSeconds: 300,
                suspendedDurationSeconds: 1_800,
                autoResumeEnabled: true,
            },
            runHookPayload: '{"runtime_session_id":"rt_x"}',
            clientToken: 'launch-rt_x-7',
        });
        expect(description).toEqual({
            microvmId: 'mvm-1',
            state: 'PENDING',
            endpoint: 'https://mvm-1.on.aws',
            imageArn: 'arn:aws:lambda:us-east-2:1:microvm-image/codeapi',
            imageVersion: '7',
            maximumDurationSeconds: 28_800,
            startedAtMs: startedAt.getTime(),
            stateReason: undefined,
        });
    });

    test('lifecycle commands address the VM via microvmIdentifier', async () => {
        const { sender, sent } = stubSender([
            { microvmId: 'mvm-1', state: 'RUNNING' },
            {},
            {},
            { microvmId: 'mvm-1', state: 'RUNNING' },
            {},
        ]);
        const client = new AwsLambdaMicrovmClient({ client: sender });

        await client.getMicrovm('mvm-1');
        await client.suspendMicrovm('mvm-1');
        await client.resumeMicrovm('mvm-1');
        await client.terminateMicrovm('mvm-1');

        expect(sent.map(command => command.constructor.name)).toEqual([
            'GetMicrovmCommand',
            'SuspendMicrovmCommand',
            'ResumeMicrovmCommand',
            'GetMicrovmCommand',
            'TerminateMicrovmCommand',
        ]);
        for (const command of sent) {
            expect(command.input).toEqual({ microvmIdentifier: 'mvm-1' });
        }
    });

    test('createMicrovmAuthToken clamps TTL to whole minutes and reads the header map', async () => {
        const { sender, sent } = stubSender([
            { authToken: { [MICROVM_AUTH_HEADER]: 'proxy-token-1' } },
        ]);
        const client = new AwsLambdaMicrovmClient({ client: sender });

        const token = await client.createMicrovmAuthToken({
            microvmId: 'mvm-1',
            port: 8080,
            ttlSeconds: 300,
        });

        expect(sent[0].constructor.name).toBe('CreateMicrovmAuthTokenCommand');
        expect(sent[0].input).toEqual({
            microvmIdentifier: 'mvm-1',
            expirationInMinutes: 5,
            allowedPorts: [{ port: 8080 }],
        });
        expect(token.headerName).toBe(MICROVM_AUTH_HEADER);
        expect(token.token).toBe('proxy-token-1');
        expect(token.expiresAtMs).toBeGreaterThan(Date.now());
    });

    test('token TTL clamps to the 1..60 minute API bounds', async () => {
        const { sender, sent } = stubSender([
            { authToken: { [MICROVM_AUTH_HEADER]: 't1' } },
            { authToken: { [MICROVM_AUTH_HEADER]: 't2' } },
        ]);
        const client = new AwsLambdaMicrovmClient({ client: sender });

        await client.createMicrovmAuthToken({
            microvmId: 'mvm-1',
            port: 8080,
            ttlSeconds: 10,
        });
        await client.createMicrovmAuthToken({
            microvmId: 'mvm-1',
            port: 8080,
            ttlSeconds: 86_400,
        });

        expect(
            (sent[0].input as { expirationInMinutes: number })
                .expirationInMinutes,
        ).toBe(1);
        expect(
            (sent[1].input as { expirationInMinutes: number })
                .expirationInMinutes,
        ).toBe(60);
    });

    test('missing token entry in the response surfaces as an API error', async () => {
        const { sender } = stubSender([{ authToken: {} }]);
        const client = new AwsLambdaMicrovmClient({ client: sender });
        expect(
            client.createMicrovmAuthToken({
                microvmId: 'mvm-1',
                port: 8080,
                ttlSeconds: 300,
            }),
        ).rejects.toThrow(`missing ${MICROVM_AUTH_HEADER}`);
    });

    test('a hanging SDK request is aborted by the client request deadline', async () => {
        const sender: MicrovmCommandSender = {
            send(_command, options): Promise<unknown> {
                return new Promise((_resolve, reject) => {
                    options?.abortSignal?.addEventListener(
                        'abort',
                        () =>
                            reject(
                                options.abortSignal?.reason ??
                                    new Error('aborted'),
                            ),
                        { once: true },
                    );
                });
            },
        };
        const client = new AwsLambdaMicrovmClient({
            client: sender,
            requestTimeoutMs: 10,
        });

        await expect(client.getMicrovm('mvm-hung')).rejects.toMatchObject({
            operation: 'GetMicrovm',
            kind: 'other',
        });
    });

    test('passes a caller abort signal through to the SDK request', async () => {
        let observedSignal: AbortSignal | undefined;
        const sender: MicrovmCommandSender = {
            send(_command, options): Promise<unknown> {
                observedSignal = options?.abortSignal;
                return new Promise((_resolve, reject) => {
                    observedSignal?.addEventListener(
                        'abort',
                        () =>
                            reject(
                                observedSignal?.reason ?? new Error('aborted'),
                            ),
                        { once: true },
                    );
                });
            },
        };
        const client = new AwsLambdaMicrovmClient({
            client: sender,
            requestTimeoutMs: 5_000,
        });
        const controller = new AbortController();
        const pending = client.createMicrovmAuthToken(
            {
                microvmId: 'mvm-hung',
                port: 8080,
                ttlSeconds: 300,
            },
            controller.signal,
        );
        controller.abort(new Error('job timed out'));

        await expect(pending).rejects.toMatchObject({
            operation: 'CreateMicrovmAuthToken',
        });
        expect(observedSignal?.aborted).toBe(true);
    });

    test('replays the same client token after an ambiguous abort to recover the VM id', async () => {
        const sent: Array<{ command: SentCommand; signal?: AbortSignal }> = [];
        const sender: MicrovmCommandSender = {
            send(command, options): Promise<unknown> {
                sent.push({
                    command: command as SentCommand,
                    signal: options?.abortSignal,
                });
                if (sent.length === 1) {
                    return new Promise((_resolve, reject) => {
                        options?.abortSignal?.addEventListener(
                            'abort',
                            () =>
                                reject(
                                    options.abortSignal?.reason ??
                                        new Error('aborted'),
                                ),
                            { once: true },
                        );
                    });
                }
                return Promise.resolve({
                    microvmId: 'mvm-recovered',
                    state: 'RUNNING',
                    endpoint: 'https://mvm-recovered.example',
                });
            },
        };
        const client = new AwsLambdaMicrovmClient({
            client: sender,
            requestTimeoutMs: 5_000,
        });
        const controller = new AbortController();
        const pending = client.runMicrovm(
            {
                imageIdentifier: 'arn:image',
                maximumDurationSeconds: 120,
                clientToken: 'exec-idempotent-1',
            },
            controller.signal,
        );
        controller.abort(new Error('job deadline'));

        await expect(pending).resolves.toMatchObject({
            microvmId: 'mvm-recovered',
        });
        expect(sent).toHaveLength(2);
        expect(sent.map(item => item.command.input.clientToken)).toEqual([
            'exec-idempotent-1',
            'exec-idempotent-1',
        ]);
        expect(sent[1].signal?.aborted).toBe(false);
    });

    test('an explicit reconcile signal bounds ambiguous launch recovery', async () => {
        const sent: Array<{ command: SentCommand; signal?: AbortSignal }> = [];
        const sender: MicrovmCommandSender = {
            send(command, options): Promise<unknown> {
                sent.push({
                    command: command as SentCommand,
                    signal: options?.abortSignal,
                });
                if (sent.length === 1)
                    return Promise.reject(new Error('connection reset'));
                return new Promise((_resolve, reject) => {
                    const signal = options?.abortSignal;
                    const onAbort = (): void =>
                        reject(signal?.reason ?? new Error('aborted'));
                    if (signal?.aborted) {
                        onAbort();
                    } else {
                        signal?.addEventListener('abort', onAbort, {
                            once: true,
                        });
                    }
                });
            },
        };
        const client = new AwsLambdaMicrovmClient({
            client: sender,
            requestTimeoutMs: 5_000,
        });
        const reconcile = new AbortController();
        const pending = client.runMicrovm(
            {
                imageIdentifier: 'arn:image',
                maximumDurationSeconds: 120,
                clientToken: 'exec-budgeted-1',
            },
            undefined,
            reconcile.signal,
        );
        while (sent.length < 2) await Promise.resolve();
        reconcile.abort(new Error('launch budget expired'));

        await expect(pending).rejects.toMatchObject({
            kind: 'other',
            operation: 'RunMicrovm',
            message: 'connection reset',
        });
        expect(sent).toHaveLength(2);
        expect(sent[1].signal?.aborted).toBe(true);
    });

    test('does not reconcile a deterministic RunMicrovm rejection', async () => {
        const { sender, sent } = stubSender([
            namedError('ValidationException'),
        ]);
        const client = new AwsLambdaMicrovmClient({ client: sender });
        await expect(
            client.runMicrovm({
                imageIdentifier: 'arn:image',
                maximumDurationSeconds: 120,
                clientToken: 'exec-invalid',
            }),
        ).rejects.toMatchObject({
            kind: 'validation',
            operation: 'RunMicrovm',
        });
        expect(sent).toHaveLength(1);
    });
});

describe('AwsLambdaMicrovmClient error classification', () => {
    const cases: Array<[string, string]> = [
        ['ThrottlingException', 'throttled'],
        ['TooManyRequestsException', 'throttled'],
        ['ResourceNotFoundException', 'not_found'],
        ['ConflictException', 'conflict'],
        ['ServiceQuotaExceededException', 'quota_exceeded'],
        ['ValidationException', 'validation'],
        ['SomeUnknownException', 'other'],
    ];

    for (const [name, kind] of cases) {
        test(`${name} -> ${kind}`, async () => {
            const { sender } = stubSender([namedError(name)]);
            const client = new AwsLambdaMicrovmClient({ client: sender });
            try {
                await client.getMicrovm('mvm-1');
                throw new Error('expected rejection');
            } catch (error) {
                expect(error).toBeInstanceOf(LambdaMicrovmApiError);
                expect((error as LambdaMicrovmApiError).kind).toBe(
                    kind as LambdaMicrovmApiError['kind'],
                );
                expect((error as LambdaMicrovmApiError).operation).toBe(
                    'GetMicrovm',
                );
            }
        });
    }
});
