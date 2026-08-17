/**
 * Create (or update) a hookless Lambda MicroVM image for the CodeAPI runner and
 * poll it to CREATED. This is the one provisioning step Terraform can't own yet
 * (the lambda-microvms service has no TF resource), so it lives here as a thin,
 * guaranteed-correct wrapper over the SDK call proven during the spike.
 *
 * Hookless by design: Lambda's image build hooks only route on the
 * snapshot-compatible Lambda base *container* image, and enabling any runtime
 * hook forces the /ready build hook (which never reaches a stock container's
 * listener, so the build fails at the ready timeout). Session mode is delivered
 * per request via the X-Runtime-Session-Id header instead — no hooks needed.
 *
 * Run from the service workspace so the SDK resolves:
 *   cd service && AWS_PROFILE=... bun scripts/create-microvm-image.ts \
 *     --name codeapi-session \
 *     --artifact s3://<artifact-bucket>/runner/runner-<tag>.zip \
 *     --build-role arn:aws:iam::<acct>:role/codeapi-microvm-build \
 *     --region us-east-1
 *
 * Flags (or the UPPER_SNAKE env equivalents):
 *   --name          MICROVM_IMAGE_NAME     image name (default codeapi-session)
 *   --artifact      MICROVM_ARTIFACT_URI   s3:// uri of the code-artifact zip (required)
 *   --build-role    MICROVM_BUILD_ROLE_ARN build role arn (required)
 *   --base-image    MICROVM_BASE_IMAGE_ARN default arn:aws:lambda:<region>:aws:microvm-image:al2023-1
 *   --base-version  MICROVM_BASE_IMAGE_VERSION optional immutable managed-base version
 *   --region        MICROVM_REGION         default us-east-1
 *   --memory        MICROVM_MEMORY_MIB     baseline memory (default 4096; RunMicrovm has no
 *                                          per-session memory override, so this image-time value
 *                                          is the ONLY memory lever — embedded-engine workloads
 *                                          like chdb OOM inside 2048)
 *   --update        MICROVM_UPDATE=true    update an existing image (new version) instead of create
 */
import {
    LambdaMicrovmsClient,
    CreateMicrovmImageCommand,
    UpdateMicrovmImageCommand,
    GetMicrovmImageCommand,
    ListMicrovmImagesCommand,
} from '@aws-sdk/client-lambda-microvms';
import {
    positiveFiniteNumber,
    positiveInteger,
    parseStringMapJson,
    resolveMicrovmImageArn,
    waitForMicrovmImage,
} from './create-microvm-image-lib';

function arg(flag: string, env: string, fallback?: string): string | undefined {
    const i = process.argv.indexOf(flag);
    if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
    return process.env[env] ?? fallback;
}

const region = arg('--region', 'MICROVM_REGION', 'us-east-1') as string;
const name = arg('--name', 'MICROVM_IMAGE_NAME', 'codeapi-session') as string;
const artifactUri = arg('--artifact', 'MICROVM_ARTIFACT_URI');
const buildRoleArn = arg('--build-role', 'MICROVM_BUILD_ROLE_ARN');
const baseImageArn = arg(
    '--base-image',
    'MICROVM_BASE_IMAGE_ARN',
    `arn:aws:lambda:${region}:aws:microvm-image:al2023-1`,
) as string;
const baseImageVersion = arg('--base-version', 'MICROVM_BASE_IMAGE_VERSION');
const memory = positiveInteger(
    arg('--memory', 'MICROVM_MEMORY_MIB', '4096') as string,
    'MICROVM_MEMORY_MIB',
);
const buildDeadlineMinutes = positiveFiniteNumber(
    process.env.MICROVM_BUILD_DEADLINE_MINUTES ?? '30',
    'MICROVM_BUILD_DEADLINE_MINUTES',
);
const isUpdate =
    (arg('--update', 'MICROVM_UPDATE') ?? 'false') === 'true' ||
    process.argv.includes('--update');

if (!artifactUri || !buildRoleArn) {
    console.error(
        'Missing required --artifact <s3://...> and/or --build-role <arn>.',
    );
    process.exit(2);
}

/* Runner env is baked at image-build time (RunMicrovm does not inject it later),
 * so the runner needs its egress-gateway / manifest config HERE or it can't
 * upload outputs or verify execution manifests. By-reference inputs are pushed
 * through the authenticated control plane, so FILE_SERVER_URL belongs only on
 * the worker. The helper can't know your deployment's URLs or verifier key, so
 * pass them via --env-json '{"EGRESS_GATEWAY_URL":"...", ...}' (or the
 * MICROVM_IMAGE_ENV_JSON env). Typical keys: EGRESS_GATEWAY_URL,
 * SANDBOX_ALLOWED_LOCAL_NETWORK_PORT, SANDBOX_EXECUTION_MANIFEST_PUBLIC_KEY,
 * SANDBOX_REQUIRE_EGRESS_MANIFEST, CODEAPI_HARDENED_SANDBOX_MODE, and
 * SANDBOX_FORWARD_TARGET.
 * Runner limits also inject here and default LOW for session workloads:
 * SANDBOX_RUN_TIMEOUT / SANDBOX_RUN_CPU_TIME (30000ms default kills long
 * computations) and SANDBOX_OUTPUT_MAX_SIZE (1024 bytes default truncates
 * output after a single verbose stack trace). */
function parseEnvJson(): Record<string, string> {
    const raw = arg('--env-json', 'MICROVM_IMAGE_ENV_JSON');
    if (!raw) return {};
    return parseStringMapJson(raw, 'MICROVM_IMAGE_ENV_JSON');
}

/* Hard-won working image config (see docs/lambda-microvm/README.md):
 *  - additionalOsCapabilities ["ALL"]: nsjail needs CAP_SYS_ADMIN for its /proc
 *    mount inside the guest, else EPERM.
 *  - SANDBOX_USE_CGROUPV2=false: the app container can't read the cgroup v2
 *    subtree_control, so fall back to rlimit-based caps.
 *  - NO hooks: hookless is the reliable build path (see header). */
const shared = {
    baseImageArn,
    baseImageVersion,
    buildRoleArn,
    codeArtifact: { uri: artifactUri },
    cpuConfigurations: [{ architecture: 'ARM_64' as const }],
    resources: [{ minimumMemoryInMiB: memory }],
    additionalOsCapabilities: ['ALL' as const],
    environmentVariables: { SANDBOX_USE_CGROUPV2: 'false', ...parseEnvJson() },
};

const client = new LambdaMicrovmsClient({
    region,
    retryMode: 'adaptive',
    maxAttempts: 3,
});

async function main(): Promise<void> {
    console.log(
        `${isUpdate ? 'Updating' : 'Creating'} hookless MicroVM image "${name}" in ${region}...`,
    );
    console.log(
        `  managed base: ${baseImageArn}${baseImageVersion ? ` @ ${baseImageVersion}` : ' (latest version)'}`,
    );
    const startedAtMs = Date.now();
    const deadlineAtMs = startedAtMs + buildDeadlineMinutes * 60_000;
    const controller = new AbortController();
    const deadline = setTimeout(
        () => {
            controller.abort(
                new Error(
                    `MicroVM image provisioning exceeded ${buildDeadlineMinutes} minute(s)`,
                ),
            );
        },
        Math.max(1, deadlineAtMs - Date.now()),
    );
    deadline.unref?.();
    let createdArn: string | undefined;
    try {
        if (isUpdate) {
            const imageIdentifier = await resolveMicrovmImageArn(
                name,
                async (nameFilter, nextToken, signal) =>
                    client.send(
                        new ListMicrovmImagesCommand({
                            nameFilter,
                            nextToken,
                            maxResults: 50,
                        }),
                        { abortSignal: signal },
                    ),
                controller.signal,
            );
            const res = await client.send(
                new UpdateMicrovmImageCommand({ imageIdentifier, ...shared }),
                { abortSignal: controller.signal },
            );
            createdArn = res.imageArn ?? imageIdentifier;
        } else {
            const res = await client.send(
                new CreateMicrovmImageCommand({
                    name,
                    description: 'CodeAPI hookless session runner',
                    ...shared,
                }),
                { abortSignal: controller.signal },
            );
            createdArn = res.imageArn;
        }

        /* GetMicrovmImage and UpdateMicrovmImage require the full ARN. Create
         * accepts a name; update resolves that name above. Create/Update, every
         * lookup/poll, and every sleep share one hard deadline. */
        const completed = await waitForMicrovmImage({
            imageIdentifier: createdArn ?? '',
            deadlineMinutes: buildDeadlineMinutes,
            startedAtMs,
            deadlineAtMs,
            signal: controller.signal,
            getImage: (imageIdentifier, signal) =>
                client.send(new GetMicrovmImageCommand({ imageIdentifier }), {
                    abortSignal: signal,
                }),
            onPending: (state, elapsedSeconds) => {
                if (elapsedSeconds % 60 < 20)
                    console.log(`  [${elapsedSeconds}s] ${state}`);
            },
        });

        console.log(`\n${completed.state} in ${completed.elapsedSeconds}s`);
        console.log(`  imageArn: ${completed.imageArn}`);
        console.log(`  version:  ${completed.imageVersion}`);
        console.log('\nSet on the CodeAPI service:');
        console.log(`  LAMBDA_MICROVM_IMAGE_ARN=${completed.imageArn}`);
        console.log(`  LAMBDA_MICROVM_IMAGE_VERSION=${completed.imageVersion}`);
    } catch (error) {
        if (controller.signal.aborted) {
            throw new Error(
                `MicroVM image provisioning timed out after ${buildDeadlineMinutes} minute(s)`,
                { cause: error },
            );
        }
        throw error;
    } finally {
        clearTimeout(deadline);
    }
}

main().catch(error => {
    console.error(
        'create-microvm-image failed:',
        error instanceof Error ? error.message : error,
    );
    process.exit(1);
});
