import { readdir } from 'node:fs/promises';
import { RestrictedBackend } from './backend.js';
import { endpoint } from './config.js';
import { readToken } from './credential.js';
import { extractionServer } from './server.js';

const backend = new RestrictedBackend({
    jobs: '/jobs',
    guard: '/opt/extraction/guard',
    python: '/usr/local/bin/python3.13',
    worker: '/opt/extraction/extract.py',
});
try {
    const address = endpoint();
    const token = await readToken();
    if ((await readdir('/jobs')).length) throw new Error('DIRTY_SCRATCH');
    await backend.probe();
    const server = extractionServer(backend, token);
    server.on('error', () => {
        console.error('EXTRACTION_UNAVAILABLE');
        process.exit(1);
    });
    server.listen(address, () => console.log('Extraction service ready'));
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
