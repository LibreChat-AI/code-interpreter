import { chmod, lstat, readdir, unlink } from 'node:fs/promises';
import { connect } from 'node:net';
import { RestrictedBackend } from './backend.js';
import { extractionServer } from './server.js';

// Deployment-owned locations, not caller-selected paths or runtimes.
const backend = new RestrictedBackend({
    jobs: '/jobs',
    guard: '/opt/extraction/guard',
    python: '/usr/local/bin/python3.13',
    worker: '/opt/extraction/extract.py',
});
try {
    if ((await readdir('/jobs')).length) throw new Error('DIRTY_SCRATCH');
    try {
        const stat = await lstat('/socket/extraction.sock');
        if (!stat.isSocket()) throw new Error('INVALID_SOCKET');
        await new Promise<void>((resolve, reject) => {
            const client = connect('/socket/extraction.sock');
            client.setTimeout(1000, () => {
                client.destroy();
                reject(new Error('SOCKET_EXISTS'));
            });
            client.once('connect', () => {
                client.destroy();
                reject(new Error('SOCKET_EXISTS'));
            });
            client.once('error', error => {
                if ((error as NodeJS.ErrnoException).code === 'ECONNREFUSED')
                    resolve();
                else reject(error);
            });
        });
        await unlink('/socket/extraction.sock');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await backend.probe();
    const server = extractionServer(backend);
    server.on('error', () => {
        console.error('EXTRACTION_UNAVAILABLE');
        process.exit(1);
    });
    process.umask(0o007);
    server.listen('/socket/extraction.sock', async () => {
        try {
            await chmod('/socket/extraction.sock', 0o660);
        } catch {
            console.error('EXTRACTION_UNAVAILABLE');
            process.exit(1);
        }
        console.log('Extraction service ready');
    });
    const shutdown = () => {
        server.close();
        server.closeAllConnections();
        setTimeout(() => process.exit(0), 12_000).unref();
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
} catch {
    console.error('EXTRACTION_UNAVAILABLE');
    process.exit(1);
}
