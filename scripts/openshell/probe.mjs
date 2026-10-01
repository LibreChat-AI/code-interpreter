import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const OPENSHELL_VERSION = '0.1.2';
export const OPENSHELL_COMMIT = '6648bd0c290efbc41ba131ee9831ee45cd431f94';
const POLICY = fileURLToPath(new URL('./probe-policy.yaml', import.meta.url));
const MARKER = 'codeapi-openshell-probe-ok';

export class ProbeError extends Error {
    constructor(stage) {
        super(`OpenShell probe failed at ${stage}`);
        this.stage = stage;
    }
}

export function commandRunner(binary = 'openshell') {
    const env = { ...process.env, NO_COLOR: '1' };
    // Named gateway selection must not inherit an endpoint or insecure override.
    delete env.OPENSHELL_GATEWAY_ENDPOINT;
    delete env.OPENSHELL_GATEWAY_INSECURE;
    return (args, { stage, timeoutMs, signal }) =>
        new Promise((resolve, reject) => {
            const child = execFile(
                binary,
                args,
                {
                    env,
                    timeout: timeoutMs,
                    killSignal: 'SIGKILL',
                    maxBuffer: 65536,
                    signal,
                },
                (error, stdout) => {
                    // CLI errors can contain credentials, policy contents, or provider details.
                    if (error) reject(new ProbeError(stage));
                    else resolve(stdout);
                }
            );
            child.stdin.end();
        });
}

export async function runProbe(options, run = commandRunner()) {
    const {
        gateway,
        image,
        workspace = 'default',
        timeoutMs = 120000,
        signal,
    } = options;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(gateway ?? '')) {
        throw new ProbeError('gateway validation');
    }
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(workspace)) {
        throw new ProbeError('workspace validation');
    }
    if (
        !/^\S+@sha256:[a-f0-9]{64}$/.test(image ?? '') ||
        image.startsWith('-')
    ) {
        throw new ProbeError('image validation');
    }
    if (
        !Number.isSafeInteger(timeoutMs) ||
        timeoutMs < 100 ||
        timeoutMs > 300000
    ) {
        throw new ProbeError('timeout validation');
    }
    const invoke = (args, stage, useSignal = true) =>
        run(args, { stage, timeoutMs, signal: useSignal ? signal : undefined });
    const version = await invoke(['--version'], 'version');
    if (version.trim() !== `openshell ${OPENSHELL_VERSION}`) {
        throw new ProbeError('version mismatch');
    }
    if (signal?.aborted) throw new ProbeError('cancelled');

    const name = `codeapi-probe-${randomUUID()}`;
    const scope = ['--gateway', gateway, '--workspace', workspace];
    const timings = {};
    const timed = async (stage, args, useSignal = true) => {
        const start = performance.now();
        try {
            return await invoke([...scope, ...args], stage, useSignal);
        } finally {
            timings[stage] = Math.round(performance.now() - start);
        }
    };
    let failure;
    let cleanup = 'unconfirmed';
    try {
        await timed('create', [
            'sandbox',
            'create',
            '--name',
            name,
            '--from',
            image,
            '--policy',
            POLICY,
            '--no-auto-providers',
            '--approval-mode',
            'manual',
            '--cpu',
            '1',
            '--memory',
            '256Mi',
            '--keep',
            '--detach',
            '--no-tty',
            '--output',
            'json',
            '--',
            '/bin/sh',
            '-c',
            'sleep 300',
        ]);
        const output = await timed('exec', [
            'sandbox',
            'exec',
            '--name',
            name,
            '--timeout',
            '10',
            '--no-tty',
            '--no-login-shell',
            '--',
            '/bin/sh',
            '-c',
            `printf '%s' '${MARKER}' > /tmp/codeapi-probe && cat /tmp/codeapi-probe`,
        ]);
        if (output.trim() !== MARKER) throw new ProbeError('exec output');
    } catch (error) {
        failure = error instanceof ProbeError ? error.stage : 'execution';
    } finally {
        try {
            const output = await timed(
                'delete',
                ['sandbox', 'delete', name],
                false
            );
            const text = output.replace(/\x1b\[[0-9;]*m/g, '').trim();
            // Exit zero also covers accepted/pending deletion. Only terminal outcomes pass.
            if (
                text === `✓ Deleted sandbox ${name}` ||
                text === `✓ Sandbox ${name} already deleted`
            ) {
                cleanup = 'confirmed';
            }
        } catch {
            // Keep the execution failure and report cleanup independently.
        }
    }
    if (signal?.aborted && failure === undefined) failure = 'cancelled';
    return {
        ok: failure === undefined && cleanup === 'confirmed',
        version: OPENSHELL_VERSION,
        upstreamCommit: OPENSHELL_COMMIT,
        sandbox: name,
        workspace,
        cleanup,
        ...(failure ? { failedStage: failure } : {}),
        timingsMs: timings,
    };
}

async function main() {
    const { values } = parseArgs({
        options: {
            gateway: { type: 'string' },
            workspace: { type: 'string', default: 'default' },
            image: { type: 'string' },
            'timeout-ms': { type: 'string', default: '120000' },
            help: { type: 'boolean' },
        },
    });
    if (values.help) {
        console.log(
            'node scripts/openshell/probe.mjs --gateway NAME --image REGISTRY/IMAGE@sha256:DIGEST [--workspace NAME] [--timeout-ms 120000]'
        );
        return;
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    process.on('SIGINT', abort);
    process.on('SIGTERM', abort);
    try {
        const result = await runProbe({
            gateway: values.gateway,
            workspace: values.workspace,
            image: values.image,
            timeoutMs: Number(values['timeout-ms']),
            signal: controller.signal,
        });
        console.log(JSON.stringify(result, null, 2));
        process.exitCode = result.ok ? 0 : 1;
    } finally {
        process.off('SIGINT', abort);
        process.off('SIGTERM', abort);
    }
}

if (
    process.argv[1] &&
    import.meta.url === pathToFileURL(process.argv[1]).href
) {
    main().catch(error => {
        console.error(
            error instanceof ProbeError
                ? error.message
                : 'Invalid OpenShell probe invocation'
        );
        process.exitCode = 1;
    });
}
