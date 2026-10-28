import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

export const tokenFile = () =>
    process.env.EXTRACTION_TOKEN_FILE ?? '/run/extraction/token';

export async function readToken(path: string = tokenFile()): Promise<string> {
    const file = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
    try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size !== 64 || (stat.mode & 0o777) !== 0o444)
            throw new Error('INVALID_TOKEN_FILE');
        const bytes = Buffer.alloc(65);
        const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
        const token = bytes.toString('utf8', 0, bytesRead);
        if (bytesRead !== 64 || !/^[a-f0-9]{64}$/.test(token))
            throw new Error('INVALID_TOKEN_FILE');
        return token;
    } finally {
        await file.close();
    }
}
