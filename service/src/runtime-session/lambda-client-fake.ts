import { nanoid } from 'nanoid';
import {
    LambdaMicrovmApiError,
    MICROVM_AUTH_HEADER,
    type LambdaMicrovmClient,
    type MicrovmAuthToken,
    type MicrovmDescription,
    type MicrovmIdlePolicy,
    type MicrovmLifecycleState,
    type RunMicrovmArgs,
} from './lambda-client';

export interface FakeMicrovm {
    microvmId: string;
    state: MicrovmLifecycleState;
    endpoint: string;
    imageIdentifier: string;
    imageVersion?: string;
    maximumDurationSeconds: number;
    idlePolicy?: MicrovmIdlePolicy;
    runHookPayload?: string;
    clientToken?: string;
    startedAtMs: number;
    mintedTokens: string[];
}

type FakeOp =
    | 'runMicrovm'
    | 'getMicrovm'
    | 'suspendMicrovm'
    | 'resumeMicrovm'
    | 'terminateMicrovm'
    | 'createMicrovmAuthToken';

function runMicrovmRequestFingerprint(args: RunMicrovmArgs): string {
    return JSON.stringify({
        imageIdentifier: args.imageIdentifier,
        imageVersion: args.imageVersion,
        executionRoleArn: args.executionRoleArn,
        ingressConnectorArns: args.ingressConnectorArns,
        egressConnectorArns: args.egressConnectorArns,
        maximumDurationSeconds: args.maximumDurationSeconds,
        idlePolicy: args.idlePolicy,
        logGroup: args.logGroup,
        runHookPayload: args.runHookPayload,
    });
}

/**
 * In-memory control-plane fake for bun tests. Transport-free: the test
 * supplies `endpointProvider` (usually a Bun.serve URL) so the backend's real
 * HTTP proxy path is exercised against a fake sandbox endpoint.
 *
 * Launch behavior: VMs come up RUNNING immediately unless
 * `launchStates` supplies an explicit state sequence (e.g. keep a VM
 * PENDING for N getMicrovm polls).
 */
export class FakeLambdaMicrovmClient implements LambdaMicrovmClient {
    readonly vms = new Map<string, FakeMicrovm>();
    readonly calls: Array<{ op: FakeOp; args: unknown }> = [];
    private readonly failures = new Map<FakeOp, Error[]>();
    private readonly requestByClientToken = new Map<string, string>();
    private pendingPollsByClientToken = new Map<string, number>();
    private vmSeq = 0;

    constructor(
        private readonly options: {
            endpointProvider?: (microvmId: string) => string;
            nowFn?: () => number;
        } = {},
    ) {}

    /** Queue an error for the next call of `op` (FIFO). */
    failNext(op: FakeOp, error?: Error): void {
        const queue = this.failures.get(op) ?? [];
        queue.push(
            error ??
                new LambdaMicrovmApiError(
                    'other',
                    op,
                    `${op} failed (scripted)`,
                ),
        );
        this.failures.set(op, queue);
    }

    /** Make the next launched VM stay PENDING for `polls` getMicrovm calls. */
    delayNextLaunch(polls: number): void {
        this.pendingPollsByClientToken.set('__next__', polls);
    }

    /** Make the next launched VM come back already TERMINATED (boot-time death). */
    terminateNextLaunch(): void {
        this.terminateNextLaunches += 1;
    }

    private terminateNextLaunches = 0;

    setState(microvmId: string, state: MicrovmLifecycleState): void {
        const vm = this.mustGet(microvmId);
        vm.state = state;
    }

    private now(): number {
        return this.options.nowFn?.() ?? Date.now();
    }

    private takeFailure(op: FakeOp): void {
        const queue = this.failures.get(op);
        const error = queue?.shift();
        if (error) throw error;
    }

    private mustGet(microvmId: string): FakeMicrovm {
        const vm = this.vms.get(microvmId);
        if (!vm) {
            throw new LambdaMicrovmApiError(
                'not_found',
                'GetMicrovm',
                `MicroVM ${microvmId} not found`,
            );
        }
        return vm;
    }

    private describe(vm: FakeMicrovm): MicrovmDescription {
        return {
            microvmId: vm.microvmId,
            state: vm.state,
            endpoint: vm.endpoint,
            imageArn: vm.imageIdentifier,
            imageVersion: vm.imageVersion,
            maximumDurationSeconds: vm.maximumDurationSeconds,
            startedAtMs: vm.startedAtMs,
        };
    }

    async runMicrovm(args: RunMicrovmArgs): Promise<MicrovmDescription> {
        this.calls.push({ op: 'runMicrovm', args });
        this.takeFailure('runMicrovm');

        if (args.clientToken != null) {
            const requestFingerprint = runMicrovmRequestFingerprint(args);
            const priorRequest = this.requestByClientToken.get(
                args.clientToken,
            );
            if (priorRequest != null && priorRequest !== requestFingerprint) {
                throw new LambdaMicrovmApiError(
                    'validation',
                    'RunMicrovm',
                    'A request with the same client token but different parameters was already made',
                );
            }
            const existing = [...this.vms.values()].find(
                vm => vm.clientToken === args.clientToken,
            );
            if (existing) return this.describe(existing);
            this.requestByClientToken.set(args.clientToken, requestFingerprint);
        }

        const microvmId = `fake-mvm-${++this.vmSeq}-${nanoid(6)}`;
        const pendingPolls =
            this.pendingPollsByClientToken.get('__next__') ?? 0;
        this.pendingPollsByClientToken.delete('__next__');
        if (pendingPolls > 0) {
            this.pendingPollsByClientToken.set(microvmId, pendingPolls);
        }
        const bootDeath = this.terminateNextLaunches > 0;
        if (bootDeath) {
            this.terminateNextLaunches -= 1;
        }

        const vm: FakeMicrovm = {
            microvmId,
            state: bootDeath
                ? 'TERMINATED'
                : pendingPolls > 0
                  ? 'PENDING'
                  : 'RUNNING',
            endpoint:
                this.options.endpointProvider?.(microvmId) ??
                `https://${microvmId}.fake-microvm.on.aws`,
            imageIdentifier: args.imageIdentifier,
            imageVersion: args.imageVersion,
            maximumDurationSeconds: args.maximumDurationSeconds,
            idlePolicy: args.idlePolicy,
            runHookPayload: args.runHookPayload,
            clientToken: args.clientToken,
            startedAtMs: this.now(),
            mintedTokens: [],
        };
        this.vms.set(microvmId, vm);
        return this.describe(vm);
    }

    async getMicrovm(microvmId: string): Promise<MicrovmDescription> {
        this.calls.push({ op: 'getMicrovm', args: { microvmId } });
        this.takeFailure('getMicrovm');
        const vm = this.mustGet(microvmId);
        const remaining = this.pendingPollsByClientToken.get(microvmId);
        if (remaining != null) {
            if (remaining <= 1) {
                this.pendingPollsByClientToken.delete(microvmId);
                vm.state = 'RUNNING';
            } else {
                this.pendingPollsByClientToken.set(microvmId, remaining - 1);
            }
        }
        return this.describe(vm);
    }

    async suspendMicrovm(microvmId: string): Promise<void> {
        this.calls.push({ op: 'suspendMicrovm', args: { microvmId } });
        this.takeFailure('suspendMicrovm');
        this.mustGet(microvmId).state = 'SUSPENDED';
    }

    async resumeMicrovm(microvmId: string): Promise<MicrovmDescription> {
        this.calls.push({ op: 'resumeMicrovm', args: { microvmId } });
        this.takeFailure('resumeMicrovm');
        const vm = this.mustGet(microvmId);
        if (vm.state === 'TERMINATED' || vm.state === 'TERMINATING') {
            throw new LambdaMicrovmApiError(
                'conflict',
                'ResumeMicrovm',
                `MicroVM ${microvmId} is ${vm.state}`,
            );
        }
        vm.state = 'RUNNING';
        return this.describe(vm);
    }

    async terminateMicrovm(microvmId: string): Promise<void> {
        this.calls.push({ op: 'terminateMicrovm', args: { microvmId } });
        this.takeFailure('terminateMicrovm');
        const vm = this.vms.get(microvmId);
        if (vm) vm.state = 'TERMINATED';
    }

    async createMicrovmAuthToken(args: {
        microvmId: string;
        port: number;
        ttlSeconds: number;
    }): Promise<MicrovmAuthToken> {
        this.calls.push({ op: 'createMicrovmAuthToken', args });
        this.takeFailure('createMicrovmAuthToken');
        const vm = this.mustGet(args.microvmId);
        const token = `fake-proxy-token-${args.microvmId}-${vm.mintedTokens.length + 1}`;
        vm.mintedTokens.push(token);
        return {
            headerName: MICROVM_AUTH_HEADER,
            token,
            expiresAtMs: this.now() + args.ttlSeconds * 1_000,
        };
    }

    callsFor(op: FakeOp): Array<{ op: FakeOp; args: unknown }> {
        return this.calls.filter(call => call.op === op);
    }
}
