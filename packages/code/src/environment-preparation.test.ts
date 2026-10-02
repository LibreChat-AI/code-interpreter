import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
    chmod,
    mkdtemp,
    mkdir,
    readFile,
    rm,
    symlink,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { prepareCodeEnvironment } from './environment-preparation.js';
import { parseCodeEnvironment } from './environment.js';
import { captureWorkspaceRootIdentity } from './root-identity.js';
import { prepareEnvironmentPreparationDirectory } from './storage.js';
import type { EnvironmentPreparationOptions } from './environment-preparation.js';
import { NativeProcessWorkspaceCommandSandbox } from './native-process.js';

async function fixture(t: test.TestContext) {
    const directory = await mkdtemp(join(tmpdir(), 'code-preparation-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const root = join(directory, 'checkout');
    const state = join(directory, 'private');
    await mkdir(root, { mode: 0o700 });
    await prepareEnvironmentPreparationDirectory(state);
    await writeFile(join(root, 'package-lock.json'), 'lock-v1');
    const commands: string[] = [];
    const options: EnvironmentPreparationOptions = {
        root: (await captureWorkspaceRootIdentity(root)).path,
        identity: await captureWorkspaceRootIdentity(root),
        receiptPath: join(state, 'receipt.json'),
        context: 'policy-v1',
        setup: {
            command: 'install',
            timeoutMs: 1000,
            reuse: {
                inputs: ['package-lock.json'],
                checkCommand: 'check',
                checkTimeoutMs: 100,
            },
        },
        async execute(command) {
            commands.push(command);
            return { exitCode: 0, timedOut: false };
        },
    };
    return { root, state, commands, options };
}

test('unchanged checkout checks readiness without repeating installation, including after restart', async t => {
    const { options, commands } = await fixture(t);
    assert.equal(await prepareCodeEnvironment(options), 'prepared');
    assert.equal(await prepareCodeEnvironment({ ...options }), 'reused');
    assert.deepEqual(commands, ['install', 'check', 'check']);
    assert.equal(
        (await readFile(options.receiptPath, 'utf8')).includes('lock-v1'),
        false,
    );
});

test('changed inputs, recipe and toolchain/policy context invalidate preparation', async t => {
    const { options, root, commands } = await fixture(t);
    await prepareCodeEnvironment(options);
    await writeFile(join(root, 'package-lock.json'), 'lock-v2');
    await prepareCodeEnvironment(options);
    await prepareCodeEnvironment({ ...options, context: 'policy-v2' });
    await prepareCodeEnvironment({
        ...options,
        context: 'policy-v2',
        setup: { ...options.setup, command: 'install-v2' },
    });
    assert.deepEqual(commands, [
        'install',
        'check',
        'install',
        'check',
        'install',
        'check',
        'install-v2',
        'check',
    ]);
});

test('missing installed artifacts trigger repair; a failed setup is never stamped', async t => {
    const { options, commands } = await fixture(t);
    await prepareCodeEnvironment(options);
    let installed = false;
    await prepareCodeEnvironment({
        ...options,
        async execute(command) {
            commands.push(command);
            if (command === 'install') installed = true;
            return { exitCode: installed ? 0 : 1, timedOut: false };
        },
    });
    assert.deepEqual(commands, [
        'install',
        'check',
        'check',
        'install',
        'check',
    ]);
    const failed = {
        ...options,
        receiptPath: join(options.receiptPath, '..', 'failed.json'),
        execute: async () => ({ exitCode: 1, timedOut: false }),
    };
    await assert.rejects(prepareCodeEnvironment(failed), /setup failed/);
    await assert.rejects(readFile(failed.receiptPath), { code: 'ENOENT' });
});

test('timed-out readiness and cancellation do not fall through to another setup', async t => {
    const { options, commands } = await fixture(t);
    await prepareCodeEnvironment(options);
    await assert.rejects(
        prepareCodeEnvironment({
            ...options,
            execute: async command => {
                commands.push(command);
                return { exitCode: 0, timedOut: true };
            },
        }),
        /did not settle/,
    );
    assert.deepEqual(commands, ['install', 'check', 'check']);
    const controller = new AbortController();
    await assert.rejects(
        prepareCodeEnvironment({
            ...options,
            signal: controller.signal,
            execute: async () => {
                controller.abort();
                return { exitCode: 0, timedOut: false };
            },
        }),
        { name: 'AbortError' },
    );
});

test('changing inputs during setup or readiness never publishes success', async t => {
    const { options, root } = await fixture(t);
    await assert.rejects(
        prepareCodeEnvironment({
            ...options,
            execute: async () => {
                await writeFile(join(root, 'package-lock.json'), 'changed');
                return { exitCode: 0, timedOut: false };
            },
        }),
        /inputs changed/,
    );
    await assert.rejects(readFile(options.receiptPath), { code: 'ENOENT' });
    await assert.rejects(
        prepareCodeEnvironment({
            ...options,
            execute: async command => {
                if (command === 'check')
                    await writeFile(
                        join(root, 'package-lock.json'),
                        'changed-again',
                    );
                return { exitCode: 0, timedOut: false };
            },
        }),
        /inputs changed/,
    );
});

test('input hashing is bounded and refuses symlink traversal and non-files', async t => {
    const { options, root } = await fixture(t);
    const outside = join(root, '..', 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'secret'), 'do-not-read');
    await symlink(outside, join(root, 'escape'));
    for (const path of ['escape/secret', 'escape']) {
        await assert.rejects(
            prepareCodeEnvironment({
                ...options,
                setup: {
                    ...options.setup,
                    reuse: { ...options.setup.reuse!, inputs: [path] },
                },
            }),
        );
    }
    await writeFile(join(root, 'big'), Buffer.alloc(8 * 1024 * 1024 + 1));
    await assert.rejects(
        prepareCodeEnvironment({
            ...options,
            setup: {
                ...options.setup,
                reuse: { ...options.setup.reuse!, inputs: ['big'] },
            },
        }),
        /bounded regular-file/,
    );
});

test('legacy setup always runs and does not create preparation state', async t => {
    const { options, commands } = await fixture(t);
    const legacy = {
        ...options,
        setup: { command: 'install', timeoutMs: 1000 },
    };
    await prepareCodeEnvironment(legacy);
    await prepareCodeEnvironment(legacy);
    assert.deepEqual(commands, ['install', 'install']);
    await assert.rejects(readFile(options.receiptPath), { code: 'ENOENT' });
});

test('a foreign checkout receipt is not installation evidence and exposed state fails closed', async t => {
    const { options, commands } = await fixture(t);
    await prepareCodeEnvironment(options);
    const other = join(options.root, '..', 'other');
    await mkdir(other);
    await writeFile(join(other, 'package-lock.json'), 'lock-v1');
    await prepareCodeEnvironment({
        ...options,
        root: (await captureWorkspaceRootIdentity(other)).path,
        identity: await captureWorkspaceRootIdentity(other),
    });
    assert.deepEqual(commands, ['install', 'check', 'install', 'check']);
    await chmod(options.receiptPath, 0o644);
    await assert.rejects(
        prepareCodeEnvironment({
            ...options,
            root: (await captureWorkspaceRootIdentity(other)).path,
            identity: await captureWorkspaceRootIdentity(other),
        }),
        /owner-only/,
    );
});

test('reuse YAML requires bounded explicit inputs and readiness check', () => {
    assert.ok(
        parseCodeEnvironment(
            'name: app\nroot: app\nsetup:\n  command: npm ci\n  reuse:\n    inputs: [package.json, package-lock.json]\n    checkCommand: test -d node_modules\n',
        ).setup?.reuse,
    );
    for (const reuse of [
        'inputs: []\ncheckCommand: ready',
        'inputs: [../outside]\ncheckCommand: ready',
        'inputs: [package.json, package.json]\ncheckCommand: ready',
        'inputs: [package.json]',
        'inputs: [package.json]\ncheckCommand: ready\ncheckTimeoutMs: 0',
        'inputs: [package.json]\ncheckCommand: ready\nunknown: true',
    ])
        assert.throws(() =>
            parseCodeEnvironment(
                `name: app\nroot: app\nsetup:\n  command: install\n  reuse:\n${reuse
                    .split('\n')
                    .map(line => `    ${line}`)
                    .join('\n')}\n`,
            ),
        );
});

test('real local shell canary: installation reused, deleted output repaired, changed lockfile reinstalled', async t => {
    const { options } = await fixture(t);
    const run = promisify(execFile);
    const ready = join(options.root, 'installed');
    const configured: EnvironmentPreparationOptions = {
        ...options,
        setup: {
            command: 'printf "install\\n" >> installs.log; mkdir -p installed',
            timeoutMs: 1000,
            reuse: {
                inputs: ['package-lock.json'],
                checkCommand: 'test -d installed',
                checkTimeoutMs: 1000,
            },
        },
        async execute(command, timeout) {
            try {
                await run('/bin/sh', ['-c', command], {
                    cwd: options.root,
                    timeout,
                });
                return { exitCode: 0, timedOut: false };
            } catch (error) {
                return {
                    exitCode: 1,
                    timedOut: Boolean((error as { killed?: boolean }).killed),
                };
            }
        },
    };
    await prepareCodeEnvironment(configured);
    assert.equal(await prepareCodeEnvironment(configured), 'reused');
    await rm(ready, { recursive: true });
    await prepareCodeEnvironment(configured);
    await writeFile(resolve(options.root, 'package-lock.json'), 'new-lock');
    await prepareCodeEnvironment(configured);
    assert.equal(
        await readFile(join(options.root, 'installs.log'), 'utf8'),
        'install\ninstall\ninstall\n',
    );
});

test(
    'real native SRT preparation reuse keeps receipts inaccessible to checkout commands',
    {
        skip: process.env.LIBRECHAT_CODE_LIVE_SRT_TESTS !== '1',
        timeout: 30_000,
    },
    async t => {
        const { options, state } = await fixture(t);
        const sandbox = new NativeProcessWorkspaceCommandSandbox({
            workspaceRoot: options.root,
            workspaceIdentity: options.identity,
            protectedPaths: [state],
        });
        t.after(() => sandbox.close());
        await sandbox.prepare();
        const execute = (
            command: string,
            timeoutMs: number,
        ) =>
            sandbox.execute({
                protocolVersion: 1,
                operation: 'execute_command',
                workspaceId: 'primary',
                command,
                timeoutMs,
                maxOutputBytes: 1024,
            });
        const configured = {
            ...options,
            execute,
            setup: {
                command:
                    'printf "install\\n" >> installs.log; mkdir -p installed',
                timeoutMs: 5000,
                reuse: {
                    inputs: ['package-lock.json'],
                    checkCommand: 'test -d installed',
                    checkTimeoutMs: 5000,
                },
            },
        };
        assert.equal(await prepareCodeEnvironment(configured), 'prepared');
        assert.equal(await prepareCodeEnvironment(configured), 'reused');
        const receipt = await readFile(options.receiptPath, 'utf8');
        const protectedRead = await execute(`cat '${options.receiptPath}'`, 5000);
        // Linux SRT may mask denied reads with an empty file. Exit status alone
        // is not evidence that the protected receipt was exposed.
        assert.ok(!protectedRead.stdout?.includes(receipt));
        await execute(`printf forged > '${options.receiptPath}'`, 5000);
        assert.equal(await readFile(options.receiptPath, 'utf8'), receipt);
        assert.equal(
            await readFile(join(options.root, 'installs.log'), 'utf8'),
            'install\n',
        );
        await rm(join(options.root, 'installed'), { recursive: true });
        assert.equal(await prepareCodeEnvironment(configured), 'prepared');
        assert.equal(
            await readFile(join(options.root, 'installs.log'), 'utf8'),
            'install\ninstall\n',
        );
    },
);
