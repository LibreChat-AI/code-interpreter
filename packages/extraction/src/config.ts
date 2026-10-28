import { isIP } from 'node:net';

export function endpoint() {
    const host = process.env.EXTRACTION_HOST ?? '0.0.0.0';
    const port = process.env.EXTRACTION_PORT ?? '8000';
    if (!isIP(host) || !/^[1-9]\d{0,4}$/.test(port) || Number(port) > 65535)
        throw new Error('INVALID_ENDPOINT');
    return { host, port: Number(port) };
}
