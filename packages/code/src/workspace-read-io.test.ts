import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Isolate libuv saturation from the test runner and sibling tests.
const queuedRead = `
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { getEventListeners } from 'node:events';
import { join } from 'node:path';
import { mock } from 'node:test';
import { LocalWorkspaceTools } from ${JSON.stringify(
    new URL('./workspace.js', import.meta.url).href
)};
import { captureWorkspaceRootIdentity } from ${JSON.stringify(
    new URL('./root-identity.js', import.meta.url).href
)};
import { WorkspaceRootAccess } from ${JSON.stringify(
    new URL('./root-access.js', import.meta.url).href
)};
const [root, cause, held] = process.argv.slice(1);
const tools = await LocalWorkspaceTools.create({ workspaces: [{
    id: 'primary', root,
    ...(held === 'true' ? { identity: await captureWorkspaceRootIdentity(root) } : {}),
}] });
const fifo = join(root, 'pool');
execFileSync('mkfifo', [fifo]);
const pipe = fs.openSync(fifo, fs.constants.O_RDWR);
const probe = await fsp.open(join(root, 'file'), 'r');
const prototype = Object.getPrototypeOf(probe);
await probe.close();
const originalRead = prototype.read;
const controller = new AbortController();
let entered, blocker, pendingIo, physicalFd, readSettled = false;
const started = new Promise(resolve => { entered = resolve; });
const closing = [];
const descriptors = [];
let elapsed = 0;
const now = performance.now();
mock.method(performance, 'now', () => now + elapsed);
function trackClose(handle) {
    const originalClose = handle.close;
    mock.method(handle, 'close', function (...args) {
        descriptors.push(this.fd);
        const promise = originalClose.apply(this, args);
        closing.push(promise);
        return promise;
    });
}
const originalOpen = WorkspaceRootAccess.open;
mock.method(WorkspaceRootAccess, 'open', async (...args) => {
    const access = await originalOpen(...args);
    trackClose(access.handle);
    return access;
});
mock.method(prototype, 'read', function (...args) {
    physicalFd = this.fd;
    trackClose(this);
    // This actual pipe read occupies the sole libuv worker until explicitly drained.
    blocker = new Promise((resolve, reject) => fs.read(pipe, Buffer.alloc(1), 0, 1, null,
        error => error ? reject(error) : resolve()));
    // Invoke Node's original FileHandle.read, including its active-I/O references.
    pendingIo = originalRead.apply(this, args).finally(() => { readSettled = true; });
    if (cause === 'deadline') elapsed = 10_000;
    if (cause === 'early-deadline') elapsed = 9_999.75;
    entered();
    return pendingIo;
});
let released = false;
function drain() {
    if (!released) { released = true; fs.writeSync(pipe, Buffer.from('x')); }
}
const wallStart = Date.now();
const pending = tools.execute({ protocolVersion: 1, operation: 'read_file', workspaceId: 'primary', path: 'file' }, controller.signal);
const rejected = assert.rejects(pending, error => error.code === (cause === 'abort' ? 'EXECUTION_ABORTED' : 'READ_LIMIT_EXCEEDED'));
await started;
if (cause === 'abort') controller.abort();
// Always drain, even if a regression prevents bounded settlement.
const fallback = setTimeout(drain, 2_000);
try {
    await rejected;
    assert.equal(released, false, 'request settled before pool was drained');
    if (cause === 'early-deadline') assert.ok(performance.now() < now + 10_000, 'timer settled before the monotonic deadline');
    assert.equal(readSettled, false, 'real descriptor read remained pending');
    assert.ok(fs.fstatSync(physicalFd).isFile(), 'Node still owns the physical descriptor');
    assert.equal(closing.length, held === 'true' ? 2 : 1, 'file and held-root closes initiated');
    assert.deepEqual(getEventListeners(controller.signal, 'abort'), []);
    console.log(JSON.stringify({ cause, held: held === 'true', settledBeforeDrain: true, readSettled, elapsedMs: Date.now() - wallStart }));
} finally {
    clearTimeout(fallback);
    drain();
    await blocker;
    await pendingIo;
    await Promise.all(closing);
    for (const fd of descriptors) assert.throws(() => fs.fstatSync(fd), { code: 'EBADF' });
    mock.restoreAll();
    fs.closeSync(pipe);
}
`;

for (const cause of ['abort', 'deadline', 'early-deadline'] as const) {
    for (const held of [false, true]) {
        test(`${cause} settles before real queued I/O drains (${
            held ? 'held' : 'legacy'
        } root)`, async t => {
            if (!['linux', 'darwin'].includes(process.platform))
                return t.skip('requires POSIX FIFO and descriptor access');
            const root = await fs.realpath(
                await fs.mkdtemp(join(tmpdir(), 'workspace-read-io-'))
            );
            t.after(() => fs.rm(root, { recursive: true, force: true }));
            await fs.writeFile(join(root, 'file'), 'line\n'.repeat(300_000));
            const { stdout } = await execFileAsync(
                process.execPath,
                [
                    '--input-type=module',
                    '--eval',
                    queuedRead,
                    root,
                    cause,
                    String(held),
                ],
                {
                    env: { ...process.env, UV_THREADPOOL_SIZE: '1' },
                    timeout: 10_000,
                }
            );
            const observed = JSON.parse(stdout);
            assert.equal(observed.settledBeforeDrain, true);
            assert.equal(observed.readSettled, false);
            t.diagnostic(stdout.trim());
        });
    }
}
