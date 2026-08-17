import {
    LambdaMicrovmsClient,
    RunMicrovmCommand,
    GetMicrovmCommand,
    SuspendMicrovmCommand,
    ResumeMicrovmCommand,
    TerminateMicrovmCommand,
    CreateMicrovmAuthTokenCommand,
    type MicrovmState,
} from '@aws-sdk/client-lambda-microvms';
import {
    LambdaMicrovmApiError,
    MICROVM_AUTH_HEADER,
    type LambdaMicrovmClient,
    type LambdaMicrovmErrorKind,
    type MicrovmAuthToken,
    type MicrovmDescription,
    type MicrovmLifecycleState,
    type RunMicrovmArgs,
} from './lambda-client';

const THROTTLE_ERROR_NAMES = new Set([
    'ThrottlingException',
    'TooManyRequestsException',
]);

const ERROR_KIND_BY_NAME: Record<string, LambdaMicrovmErrorKind> = {
    ResourceNotFoundException: 'not_found',
    ConflictException: 'conflict',
    ResourceConflictException: 'conflict',
    ServiceQuotaExceededException: 'quota_exceeded',
    ValidationException: 'validation',
    InvalidParameterValueException: 'validation',
};

function classifyError(error: unknown): LambdaMicrovmErrorKind {
    const name = (error as { name?: string } | null)?.name ?? '';
    if (THROTTLE_ERROR_NAMES.has(name)) return 'throttled';
    return ERROR_KIND_BY_NAME[name] ?? 'other';
}

function toDescription(response: {
    microvmId?: string;
    state?: MicrovmState;
    endpoint?: string;
    imageArn?: string;
    imageVersion?: string;
    maximumDurationInSeconds?: number;
    startedAt?: Date;
    stateReason?: string;
}): MicrovmDescription {
    /* Every command (Run/Get/Suspend/Resume/Terminate) returns the VM id. A
     * missing id means a partial/garbled response; fail fast rather than hand
     * back `''`, which downstream getMicrovm('')/terminateMicrovm('') would act
     * on — leaking the just-created VM as orphaned and billable. */
    if (response.microvmId == null || response.microvmId === '') {
        throw new Error('Lambda MicroVM response omitted microvmId');
    }
    return {
        microvmId: response.microvmId,
        state: (response.state ?? 'PENDING') as MicrovmLifecycleState,
        endpoint: response.endpoint,
        imageArn: response.imageArn,
        imageVersion: response.imageVersion,
        maximumDurationSeconds: response.maximumDurationInSeconds,
        startedAtMs: response.startedAt?.getTime(),
        stateReason: response.stateReason,
    };
}

/** Minimal send-shaped surface so tests can stub the SDK client. */
export interface MicrovmCommandSender {
    send(
        command: unknown,
        options?: { abortSignal?: AbortSignal },
    ): Promise<unknown>;
}

export class AwsLambdaMicrovmClient implements LambdaMicrovmClient {
    private readonly client: MicrovmCommandSender;
    private readonly requestTimeoutMs: number;

    constructor(
        options: {
            region?: string;
            client?: MicrovmCommandSender;
            requestTimeoutMs?: number;
        } = {},
    ) {
        this.client =
            options.client ??
            new LambdaMicrovmsClient({
                region: options.region,
                retryMode: 'adaptive',
                maxAttempts: 3,
            });
        this.requestTimeoutMs = Math.max(1, options.requestTimeoutMs ?? 60_000);
    }

    private async send<T>(
        operation: string,
        command: unknown,
        callerSignal?: AbortSignal,
    ): Promise<T> {
        /* Every SDK request has its own hard deadline even when the caller does not
         * supply one (notably best-effort termination). When a job signal exists,
         * either deadline cancels the adaptive-retry loop and underlying handler. */
        const timeoutSignal = AbortSignal.timeout(this.requestTimeoutMs);
        const abortSignal = callerSignal
            ? AbortSignal.any([callerSignal, timeoutSignal])
            : timeoutSignal;
        try {
            return (await this.client.send(command, { abortSignal })) as T;
        } catch (error) {
            throw new LambdaMicrovmApiError(
                classifyError(error),
                operation,
                (error as Error)?.message ??
                    `Lambda MicroVM ${operation} failed`,
                error,
            );
        }
    }

    async runMicrovm(
        args: RunMicrovmArgs,
        signal?: AbortSignal,
        reconcileSignal?: AbortSignal,
    ): Promise<MicrovmDescription> {
        const input = {
            imageIdentifier: args.imageIdentifier,
            imageVersion: args.imageVersion,
            executionRoleArn: args.executionRoleArn,
            ingressNetworkConnectors: args.ingressConnectorArns,
            egressNetworkConnectors: args.egressConnectorArns,
            maximumDurationInSeconds: args.maximumDurationSeconds,
            idlePolicy: args.idlePolicy
                ? {
                      maxIdleDurationSeconds: args.idlePolicy.maxIdleSeconds,
                      suspendedDurationSeconds:
                          args.idlePolicy.suspendedSeconds,
                      autoResumeEnabled: args.idlePolicy.autoResume,
                  }
                : undefined,
            logging: args.logGroup
                ? { cloudWatch: { logGroup: args.logGroup } }
                : undefined,
            runHookPayload: args.runHookPayload,
            clientToken: args.clientToken,
        };
        try {
            const response = await this.send<
                Parameters<typeof toDescription>[0]
            >('RunMicrovm', new RunMicrovmCommand(input), signal);
            return toDescription(response);
        } catch (firstError) {
            /* A timeout/abort or broken response is ambiguous: AWS may have accepted
             * RunMicrovm before the client lost the response. Replay the SAME
             * idempotency token once on a request independent of caller cancellation.
             * A higher-level launch budget may still bound that reconciliation via
             * `reconcileSignal`. If AWS accepted it, this recovers the MicroVM id so
             * the backend can either continue or (when the job signal is already
             * aborted) terminate it.
             * Never reconcile deterministic validation/quota/throttle failures, and
             * never replay a launch that lacks an idempotency token. */
            const ambiguous =
                !(firstError instanceof LambdaMicrovmApiError) ||
                firstError.kind === 'other';
            if (!args.clientToken || !ambiguous) throw firstError;
            try {
                const recovered = await this.send<
                    Parameters<typeof toDescription>[0]
                >(
                    'RunMicrovmReconcile',
                    new RunMicrovmCommand(input),
                    reconcileSignal,
                );
                return toDescription(recovered);
            } catch {
                /* Preserve the original classification/message. The persisted session
                 * launch intent (stateful path) can make the same-token recovery on a
                 * successor; stateless VMs retain their short maximum duration. */
                throw firstError;
            }
        }
    }

    async getMicrovm(
        microvmId: string,
        signal?: AbortSignal,
    ): Promise<MicrovmDescription> {
        const response = await this.send<Parameters<typeof toDescription>[0]>(
            'GetMicrovm',
            new GetMicrovmCommand({ microvmIdentifier: microvmId }),
            signal,
        );
        return toDescription(response);
    }

    async suspendMicrovm(
        microvmId: string,
        signal?: AbortSignal,
    ): Promise<void> {
        await this.send(
            'SuspendMicrovm',
            new SuspendMicrovmCommand({ microvmIdentifier: microvmId }),
            signal,
        );
    }

    async resumeMicrovm(
        microvmId: string,
        signal?: AbortSignal,
    ): Promise<MicrovmDescription> {
        /* ResumeMicrovm's real response is empty. Read the resource afterward
         * instead of passing that empty object through toDescription(), which
         * would turn every successful resume into "response omitted microvmId". */
        await this.send(
            'ResumeMicrovm',
            new ResumeMicrovmCommand({ microvmIdentifier: microvmId }),
            signal,
        );
        return this.getMicrovm(microvmId, signal);
    }

    async terminateMicrovm(
        microvmId: string,
        signal?: AbortSignal,
    ): Promise<void> {
        await this.send(
            'TerminateMicrovm',
            new TerminateMicrovmCommand({ microvmIdentifier: microvmId }),
            signal,
        );
    }

    async createMicrovmAuthToken(
        args: {
            microvmId: string;
            port: number;
            ttlSeconds: number;
        },
        signal?: AbortSignal,
    ): Promise<MicrovmAuthToken> {
        const expirationInMinutes = Math.min(
            Math.max(Math.ceil(args.ttlSeconds / 60), 1),
            60,
        );
        const response = await this.send<{
            authToken?: Record<string, string>;
        }>(
            'CreateMicrovmAuthToken',
            new CreateMicrovmAuthTokenCommand({
                microvmIdentifier: args.microvmId,
                expirationInMinutes,
                allowedPorts: [{ port: args.port }],
            }),
            signal,
        );
        const token = response.authToken?.[MICROVM_AUTH_HEADER];
        if (token == null || token.length === 0) {
            throw new LambdaMicrovmApiError(
                'other',
                'CreateMicrovmAuthToken',
                `CreateMicrovmAuthToken response missing ${MICROVM_AUTH_HEADER} entry`,
            );
        }
        return {
            headerName: MICROVM_AUTH_HEADER,
            token,
            expiresAtMs: Date.now() + expirationInMinutes * 60_000,
        };
    }
}
