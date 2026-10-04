import { request } from 'node:http';
const req = request(
    {
        socketPath: '/socket/extraction.sock',
        path: '/v1/capabilities',
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
