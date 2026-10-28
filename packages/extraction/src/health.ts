import { request } from 'node:http';
import { endpoint } from './config.js';
import { readToken } from './credential.js';

try {
    const { host, port } = endpoint();
    const req = request(
        {
            host:
                host === '::' ? '::1' : host === '0.0.0.0' ? '127.0.0.1' : host,
            port,
            path: '/v1/capabilities',
            headers: { Authorization: `Bearer ${await readToken()}` },
            timeout: 1000,
        },
        res => {
            res.resume();
            res.once('end', () => process.exit(res.statusCode === 200 ? 0 : 1));
        }
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => process.exit(1));
    req.end();
} catch {
    process.exit(1);
}
