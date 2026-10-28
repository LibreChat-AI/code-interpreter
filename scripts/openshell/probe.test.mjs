import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    commandRunner,
    OPENSHELL_VERSION,
    ProbeError,
    runProbe,
} from './probe.mjs';

const options = {
    gateway: 'evaluation',
    workspace: 'codeapi-test',
    image: `registry.test/shell@sha256:${'a'.repeat(64)}`,
};
function fixture(overrides = {}) {
    const calls = [];
    const run = async (args, call) => {
        calls.push({ args, ...call });
        if (overrides[call.stage]) return overrides[call.stage](args, call);
        if (call.stage === 'version') return `openshell ${OPENSHELL_VERSION}\n`;
        if (call.stage === 'exec') return 'codeapi-openshell-probe-ok';
        if (call.stage === 'delete')
            return `✓ Deleted sandbox ${args.at(-1)}\n`;
        return '{}';
    };
    return { run, calls };
}

test('scopes every operation and creates a bounded, credential-free sandbox', async () => {
    const { run, calls } = fixture();
    const result = await runProbe(options, run);
    assert.equal(result.ok, true);
    assert.equal(result.cleanup, 'confirmed');
    assert.match(result.sandbox, /^codeapi-probe-[a-f0-9-]{36}$/);
    assert.deepEqual(
        calls.map(call => call.stage),
        ['version', 'create', 'exec', 'delete']
    );
    for (const call of calls.slice(1)) {
        assert.deepEqual(call.args.slice(0, 4), [
            '--gateway',
            'evaluation',
            '--workspace',
            'codeapi-test',
        ]);
        assert.equal(call.timeoutMs, 120000);
        assert.ok(call.args.includes(result.sandbox));
    }
    const create = calls[1].args;
    for (const flag of [
        '--policy',
        '--no-auto-providers',
        '--keep',
        '--detach',
        '--no-tty',
    ])
        assert.ok(create.includes(flag));
    assert.equal(create.includes('--provider'), false);
    assert.equal(create.includes('--env'), false);
    assert.equal(create[create.indexOf('--from') + 1], options.image);
    assert.equal(create[create.indexOf('--cpu') + 1], '1');
    assert.equal(create[create.indexOf('--memory') + 1], '256Mi');
    assert.equal(create[create.indexOf('--approval-mode') + 1], 'manual');
});

test('rejects mutable images, ambiguous scope, and invalid timeouts before invoking the CLI', async () => {
    for (const invalid of [
        { image: 'shell:latest' },
        { image: `-shell@sha256:${'a'.repeat(64)}` },
        { gateway: undefined },
        { workspace: '../default' },
        { timeoutMs: 0 },
        { timeoutMs: 300001 },
    ]) {
        const { run, calls } = fixture();
        await assert.rejects(
            runProbe({ ...options, ...invalid }, run),
            ProbeError
        );
        assert.equal(calls.length, 0);
    }
});

test('rejects an unpinned CLI without creating or deleting a sandbox', async () => {
    const { run, calls } = fixture({ version: () => 'openshell 0.1.3' });
    await assert.rejects(runProbe(options, run), /version mismatch/);
    assert.equal(calls.length, 1);
});

for (const stage of ['create', 'exec']) {
    test(`attempts cleanup after ${stage} failure without exposing upstream details`, async () => {
        const { run, calls } = fixture({
            [stage]: () => {
                throw new Error('secret provider credential');
            },
        });
        const result = await runProbe(options, run);
        assert.equal(result.ok, false);
        assert.equal(result.failedStage, 'execution');
        assert.equal(result.cleanup, 'confirmed');
        assert.equal(calls.at(-1).stage, 'delete');
        assert.equal(JSON.stringify(result).includes('secret'), false);
    });
}

test('does not accept unexpected command output as success', async () => {
    const { run } = fixture({ exec: () => 'unexpected' });
    const result = await runProbe(options, run);
    assert.equal(result.ok, false);
    assert.equal(result.failedStage, 'exec output');
    assert.equal(result.cleanup, 'confirmed');
});

for (const output of [
    'deletion accepted; cleanup is pending',
    'unsupported outcome',
    '',
    '✓ Deleted sandbox someone-else',
]) {
    test(`does not report terminal cleanup for ${JSON.stringify(
        output
    )}`, async () => {
        const { run } = fixture({ delete: () => output });
        const result = await runProbe(options, run);
        assert.equal(result.ok, false);
        assert.equal(result.cleanup, 'unconfirmed');
    });
}

test('accepts an already-absent sandbox as terminal cleanup', async () => {
    const { run } = fixture({
        delete: args => `✓ Sandbox ${args.at(-1)} already deleted\n`,
    });
    assert.equal((await runProbe(options, run)).cleanup, 'confirmed');
});

test('preserves execution failure when cleanup also fails', async () => {
    const { run } = fixture({
        exec: () => {
            throw new ProbeError('exec');
        },
        delete: () => {
            throw new Error('secret');
        },
    });
    const result = await runProbe(options, run);
    assert.equal(result.failedStage, 'exec');
    assert.equal(result.cleanup, 'unconfirmed');
    assert.equal(result.ok, false);
});

test('cancellation before create does not launch work', async () => {
    const controller = new AbortController();
    controller.abort();
    const { run, calls } = fixture();
    await assert.rejects(
        runProbe({ ...options, signal: controller.signal }, run),
        /cancelled/
    );
    assert.equal(calls.length, 1);
});

test('cancellation during create still uses an independent cleanup attempt', async () => {
    const controller = new AbortController();
    const { run, calls } = fixture({
        create: () => {
            controller.abort();
            throw new ProbeError('create');
        },
    });
    const result = await runProbe(
        { ...options, signal: controller.signal },
        run
    );
    assert.equal(result.ok, false);
    assert.equal(calls[1].signal, controller.signal);
    assert.equal(calls.at(-1).signal, undefined);
    assert.equal(calls.at(-1).stage, 'delete');
});

test('command runner redacts stdout and stderr on failure', async () => {
    await assert.rejects(
        commandRunner(process.execPath)(
            [
                '-e',
                'console.log("secret"); console.error("private-key"); process.exit(2)',
            ],
            { stage: 'exec', timeoutMs: 1000 }
        ),
        error => {
            assert.equal(error.message, 'OpenShell probe failed at exec');
            assert.equal(error.cause, undefined);
            assert.equal(error.stdout, undefined);
            assert.equal(error.stderr, undefined);
            return true;
        }
    );
});

test('command runner kills a stalled CLI within its timeout', async () => {
    await assert.rejects(
        commandRunner(process.execPath)(['-e', 'setInterval(() => {}, 1000)'], {
            stage: 'create',
            timeoutMs: 100,
        }),
        /failed at create/
    );
});

test('command runner removes inherited endpoint and insecure overrides', async () => {
    const savedEndpoint = process.env.OPENSHELL_GATEWAY_ENDPOINT;
    const savedInsecure = process.env.OPENSHELL_GATEWAY_INSECURE;
    try {
        process.env.OPENSHELL_GATEWAY_ENDPOINT = 'http://wrong-gateway';
        process.env.OPENSHELL_GATEWAY_INSECURE = 'true';
        const output = await commandRunner(process.execPath)(
            [
                '-e',
                'console.log(JSON.stringify([process.env.OPENSHELL_GATEWAY_ENDPOINT, process.env.OPENSHELL_GATEWAY_INSECURE]))',
            ],
            { stage: 'version', timeoutMs: 1000 }
        );
        assert.deepEqual(JSON.parse(output), [null, null]);
    } finally {
        if (savedEndpoint === undefined)
            delete process.env.OPENSHELL_GATEWAY_ENDPOINT;
        else process.env.OPENSHELL_GATEWAY_ENDPOINT = savedEndpoint;
        if (savedInsecure === undefined)
            delete process.env.OPENSHELL_GATEWAY_INSECURE;
        else process.env.OPENSHELL_GATEWAY_INSECURE = savedInsecure;
    }
});

test('late cancellation cannot report success while cleanup completes', async () => {
    const controller = new AbortController();
    const { run } = fixture({
        delete: args => {
            controller.abort();
            return `✓ Deleted sandbox ${args.at(-1)}\n`;
        },
    });
    const result = await runProbe(
        { ...options, signal: controller.signal },
        run
    );
    assert.equal(result.ok, false);
    assert.equal(result.failedStage, 'cancelled');
    assert.equal(result.cleanup, 'confirmed');
});

test('command runner rejects oversized output without exposing it', async () => {
    await assert.rejects(
        commandRunner(process.execPath)(
            ['-e', 'process.stdout.write("x".repeat(100000))'],
            { stage: 'exec', timeoutMs: 1000 }
        ),
        error => {
            assert.equal(error.message, 'OpenShell probe failed at exec');
            assert.equal(error.stdout, undefined);
            return true;
        }
    );
});

test('command runner handles a missing CLI without exposing process details', async () => {
    await assert.rejects(
        commandRunner('codeapi-nonexistent-probe-binary')([], {
            stage: 'version',
            timeoutMs: 1000,
        }),
        /failed at version/
    );
});
