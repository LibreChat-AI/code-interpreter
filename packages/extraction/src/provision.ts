import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, open, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readToken, tokenFile } from './credential.js';

export async function provision(path: string = tokenFile()): Promise<void> {
    try {
        await readToken(path);
        return;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const directory = dirname(path);
    const stat = await lstat(directory);
    if (!stat.isDirectory() || (stat.mode & 0o777) !== 0o755)
        throw new Error('INVALID_TOKEN_DIRECTORY');
    const temporary = join(
        directory,
        `.token-${randomBytes(16).toString('hex')}`
    );
    const file = await open(
        temporary,
        constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW,
        0o600
    );
    try {
        try {
            await file.writeFile(randomBytes(32).toString('hex'), 'ascii');
            await file.chmod(0o444);
            await file.sync();
        } finally {
            await file.close();
        }
        try {
            // Publish complete bytes without replacing a concurrent provisioner's token.
            await link(temporary, path);
            const directoryFile = await open(
                directory,
                constants.O_RDONLY |
                    constants.O_DIRECTORY |
                    constants.O_NOFOLLOW
            );
            try {
                await directoryFile.sync();
            } finally {
                await directoryFile.close();
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
        await readToken(path);
    } finally {
        await unlink(temporary);
    }
}

if (
    process.argv[1] &&
    import.meta.url === pathToFileURL(process.argv[1]).href
) {
    provision().catch(() => {
        console.error('EXTRACTION_PROVISION_UNAVAILABLE');
        process.exitCode = 1;
    });
}
