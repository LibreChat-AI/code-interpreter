import assert from 'node:assert/strict';
import {
    mkdir,
    mkdtemp,
    writeFile,
    rm,
    readdir,
    open,
    readFile,
} from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { RestrictedBackend } from '/opt/extraction/dist/backend.js';

await mkdir('/jobs/other');
await writeFile('/jobs/other/secret', 'cross-job-canary');

const job = await mkdtemp('/jobs/job-');
const status = await open(
    `${job}/status`,
    constants.O_RDWR |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
    0o600
);
const child = spawn(
    '/opt/extraction/guard',
    [job, '/usr/local/bin/python3.13', '/tests/isolation.py', 'probe'],
    {
        env: { EXTRACTION_SECRET_CANARY: 'private-canary' },
        stdio: ['ignore', status.fd, 'ignore'],
    }
);
const [code] = await once(child, 'close');
await status.close();
const output = await readFile(`${job}/status`, 'ascii');
assert.equal(code, 0, output);
assert.equal(output.trim(), 'ISOLATED');
await rm(job, { recursive: true });
const runtime = {
    jobs: '/jobs',
    guard: '/opt/extraction/guard',
    python: '/usr/local/bin/python3.13',
    worker: '/tests/isolation.py',
};
const backend = new RestrictedBackend(runtime);
for (const abort of ['immediate', 'running']) {
    const job = await backend.create();
    const signal = new AbortController();
    const pending = backend.run(job, 'hang', 'a'.repeat(64), signal.signal);
    if (abort === 'running')
        await new Promise(resolve => setTimeout(resolve, 100));
    signal.abort(new Error('CANCELLED'));
    await assert.rejects(pending);
    await backend.cleanup(job);
}
const flood = await backend.create();
await assert.rejects(
    backend.run(flood, 'flood', 'a'.repeat(64), AbortSignal.timeout(1000)),
    /UNAVAILABLE/
);
await backend.cleanup(flood);
const job2 = await backend.create();
await assert.rejects(
    backend.run(job2, 'hang', 'a'.repeat(64), AbortSignal.timeout(100))
);
await backend.cleanup(job2);
await rm('/jobs/other', { recursive: true });

assert.deepEqual(await readdir('/jobs'), []);
const missing = new RestrictedBackend({ ...runtime, guard: '/nonexistent' });
const job3 = await missing.create();
await assert.rejects(
    missing.run(job3, 'pdf', 'a'.repeat(64), AbortSignal.timeout(1000))
);
await missing.cleanup(job3);
console.log(
    'Container isolation: cross-job/credential paths, sockets, fork, signals, limits, startup/running cancellation, deadline and missing launcher passed'
);
