import { describe, expect, test } from 'bun:test';
import { FakeLambdaMicrovmClient } from './lambda-client-fake';
import { LambdaMicrovmApiError } from './lambda-client';

const RUN_ARGS = {
    imageIdentifier: 'arn:image/codeapi',
    maximumDurationSeconds: 28_800,
};

describe('FakeLambdaMicrovmClient state machine', () => {
    test('launches RUNNING by default with a per-VM endpoint', async () => {
        const fake = new FakeLambdaMicrovmClient({
            endpointProvider: id => `http://localhost:9/${id}`,
        });
        const vm = await fake.runMicrovm(RUN_ARGS);
        expect(vm.state).toBe('RUNNING');
        expect(vm.endpoint).toBe(`http://localhost:9/${vm.microvmId}`);
        expect((await fake.getMicrovm(vm.microvmId)).state).toBe('RUNNING');
    });

    test('delayNextLaunch keeps the VM PENDING for N polls', async () => {
        const fake = new FakeLambdaMicrovmClient();
        fake.delayNextLaunch(2);
        const vm = await fake.runMicrovm(RUN_ARGS);
        expect(vm.state).toBe('PENDING');
        expect((await fake.getMicrovm(vm.microvmId)).state).toBe('PENDING');
        expect((await fake.getMicrovm(vm.microvmId)).state).toBe('RUNNING');
    });

    test('suspend/resume/terminate transitions', async () => {
        const fake = new FakeLambdaMicrovmClient();
        const vm = await fake.runMicrovm(RUN_ARGS);

        await fake.suspendMicrovm(vm.microvmId);
        expect((await fake.getMicrovm(vm.microvmId)).state).toBe('SUSPENDED');

        expect((await fake.resumeMicrovm(vm.microvmId)).state).toBe('RUNNING');

        await fake.terminateMicrovm(vm.microvmId);
        expect((await fake.getMicrovm(vm.microvmId)).state).toBe('TERMINATED');
        expect(fake.resumeMicrovm(vm.microvmId)).rejects.toThrow(
            'is TERMINATED',
        );
    });

    test('clientToken makes launch idempotent', async () => {
        const fake = new FakeLambdaMicrovmClient();
        const first = await fake.runMicrovm({
            ...RUN_ARGS,
            clientToken: 'launch-1',
        });
        const second = await fake.runMicrovm({
            ...RUN_ARGS,
            clientToken: 'launch-1',
        });
        const third = await fake.runMicrovm({
            ...RUN_ARGS,
            clientToken: 'launch-2',
        });
        expect(second.microvmId).toBe(first.microvmId);
        expect(third.microvmId).not.toBe(first.microvmId);
        expect(fake.vms.size).toBe(2);
    });

    test('rejects a clientToken reused with different launch parameters', async () => {
        const fake = new FakeLambdaMicrovmClient();
        await fake.runMicrovm({ ...RUN_ARGS, clientToken: 'launch-1' });
        await expect(
            fake.runMicrovm({
                ...RUN_ARGS,
                maximumDurationSeconds: 3_600,
                clientToken: 'launch-1',
            }),
        ).rejects.toMatchObject({
            kind: 'validation',
            operation: 'RunMicrovm',
        });
        expect(fake.vms.size).toBe(1);
    });

    test('failNext raises once then recovers, and unknown VMs are not_found', async () => {
        const fake = new FakeLambdaMicrovmClient();
        fake.failNext('runMicrovm');
        expect(fake.runMicrovm(RUN_ARGS)).rejects.toThrow('scripted');
        const vm = await fake.runMicrovm(RUN_ARGS);
        expect(vm.state).toBe('RUNNING');

        try {
            await fake.getMicrovm('missing');
            throw new Error('expected rejection');
        } catch (error) {
            expect((error as LambdaMicrovmApiError).kind).toBe('not_found');
        }
    });

    test('mints distinct tokens per VM and records calls', async () => {
        const fake = new FakeLambdaMicrovmClient();
        const vm = await fake.runMicrovm(RUN_ARGS);
        const first = await fake.createMicrovmAuthToken({
            microvmId: vm.microvmId,
            port: 8080,
            ttlSeconds: 300,
        });
        const second = await fake.createMicrovmAuthToken({
            microvmId: vm.microvmId,
            port: 8080,
            ttlSeconds: 300,
        });
        expect(first.token).not.toBe(second.token);
        expect(fake.vms.get(vm.microvmId)?.mintedTokens).toEqual([
            first.token,
            second.token,
        ]);
        expect(fake.callsFor('createMicrovmAuthToken')).toHaveLength(2);
    });
});
