import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';

const job = await mkdtemp('/jobs/job-');
try {
    const worker = spawn(
        '/opt/extraction/guard',
        [job, '/usr/local/bin/python3.13', '/tests/isolation.py', 'probe'],
        { stdio: ['pipe', 'pipe', 'pipe'] }
    );
    worker.stdin.end();
    worker.stdout.resume();
    worker.stderr.resume();
    assert.equal((await once(worker, 'close'))[0], 125);
    const gateway = spawn(
        '/opt/extraction/gateway',
        ['python', '/tests/gateway.py'],
        { stdio: ['pipe', 'pipe', 'pipe'] }
    );
    gateway.stdin.end();
    gateway.stdout.resume();
    gateway.stderr.resume();
    assert.equal((await once(gateway, 'close'))[0], 0);
    console.log(
        'Socket standard IO rejected by worker and removed by pre-runtime gateway'
    );
} finally {
    await rm(job, { recursive: true });
}
