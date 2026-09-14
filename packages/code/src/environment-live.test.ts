import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

for (const { succeeds, reset, timesOut } of [
    { succeeds: true, reset: false, timesOut: false },
    { succeeds: false, reset: false, timesOut: false },
    { succeeds: false, reset: false, timesOut: true },
    { succeeds: true, reset: true, timesOut: false },
]) {
    test(
        `real CLI environment setup gates registration (success=${succeeds}, reset=${reset}, timeout=${timesOut})`,
        {
            skip: process.env.LIBRECHAT_CODE_LIVE_SRT_TESTS !== '1',
            timeout: 20_000,
        },
        async t => {
            const directory = await mkdtemp(join(tmpdir(), 'code-env-live-'));
            t.after(() => rm(directory, { recursive: true, force: true }));
            const root = join(directory, 'project');
            await mkdir(root);
            const path = join(directory, 'environment.yaml');
            await writeFile(
                path,
                `name: project\nroot: project\nsetup:\n  command: 'printf prepared >> prepared.txt; ${timesOut ? 'sleep 10' : `exit ${succeeds ? 0 : 2}`}'\n  timeoutMs: ${timesOut ? 1000 : 5000}\n`,
            );
            let registrations = 0;
            let receive: (() => void) | undefined;
            const registered = new Promise<void>(resolve => {
                receive = resolve;
            });
            const server = createServer(async (request, response) => {
                request.resume();
                if (request.url?.endsWith('/register')) {
                    registrations++;
                    await assert.rejects(readFile(join(directory, 'quarantine.json')), { code: 'ENOENT' });
                    if (reset)
                        await assert.rejects(
                            readFile(join(root, 'prepared.txt')),
                            { code: 'ENOENT' },
                        );
                    else
                        assert.equal(
                            await readFile(join(root, 'prepared.txt'), 'utf8'),
                            'prepared',
                        );
                    receive?.();
                }
                response.writeHead(503).end();
            });
            await new Promise<void>(resolve =>
                server.listen(0, '127.0.0.1', resolve),
            );
            t.after(() => {
                server.closeAllConnections();
                server.close();
            });
            const address = server.address();
            assert.ok(address && typeof address !== 'string');
            const start = (clear = false) => spawn(
                process.execPath,
                [
                    fileURLToPath(new URL('./cli.js', import.meta.url)),
                    ...(clear ? [
                        'clear-workspace-quarantine',
                        '--worker-dir', root,
                        '--workspace-id', 'project',
                    ] : [
                    'run',
                    '--environment',
                    path,
                    '--allow-workspace-commands',
                    ...(reset
                        ? ['--reset-workspace-quarantine', 'project']
                        : []),
                    ]),
                ],
                {
                    env: {
                        PATH: process.env.PATH,
                        HOME: process.env.HOME,
                        TMPDIR: process.env.TMPDIR,
                        LIBRECHAT_CODE_URL: `http://127.0.0.1:${address.port}/v1`,
                        LIBRECHAT_CODE_WORKER_ID: 'environment-test',
                        LIBRECHAT_CODE_WORKER_TOKEN: 'test-only-token',
                        LIBRECHAT_CODE_DEFAULT_WORKSPACE: 'false',
                        LIBRECHAT_CODE_WORKSPACE_QUARANTINE_FILE: join(
                            directory,
                            'quarantine.json',
                        ),
                    },
                    stdio: ['ignore', 'pipe', 'pipe'],
                },
            );
            const child = start();
            const exited = once(child, 'exit');
            t.after(() => child.kill('SIGKILL'));
            let stderr = '';
            child.stderr.on('data', chunk => {
                stderr += chunk.toString();
            });
            if (succeeds) {
                await Promise.race([
                    registered,
                    exited.then(() => {
                        throw new Error(stderr);
                    }),
                ]);
                child.kill('SIGTERM');
                await exited;
                assert.ok(registrations > 0);
            } else {
                const [code] = await exited;
                assert.notEqual(code, 0);
                assert.match(stderr, /Environment project setup failed/);
                assert.equal(registrations, 0);
                const marker = await readFile(join(directory, 'quarantine.json'), 'utf8');
                assert.equal(JSON.parse(marker).workspaceId, 'project');
                const before = await readFile(join(root, 'prepared.txt'), 'utf8');
                const retry = start();
                t.after(() => retry.kill('SIGKILL'));
                let retryStderr = '';
                retry.stderr.on('data', chunk => { retryStderr += chunk.toString(); });
                const [retryCode] = await once(retry, 'exit');
                assert.notEqual(retryCode, 0);
                assert.match(retryStderr, /quarantined/);
                assert.equal(await readFile(join(root, 'prepared.txt'), 'utf8'), before);
                assert.equal(await readFile(join(directory, 'quarantine.json'), 'utf8'), marker);
                assert.equal(registrations, 0);
                const recovery = start(true);
                t.after(() => recovery.kill('SIGKILL'));
                const [recoveryCode] = await once(recovery, 'exit');
                assert.equal(recoveryCode, 0);
                await assert.rejects(readFile(join(directory, 'quarantine.json')), { code: 'ENOENT' });
                assert.equal(await readFile(join(root, 'prepared.txt'), 'utf8'), before);
                assert.equal(registrations, 0);
            }
        },
    );
}
