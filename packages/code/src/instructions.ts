import { constants } from 'node:fs';
import { open, lstat, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, relative, isAbsolute, sep } from 'node:path';

import { REPOSITORY_INSTRUCTION_MAX_BYTES } from './protocol.js';
import type { RepositoryInstructionDescriptor } from './protocol.js';
export interface RepositoryInstructionSnapshot {
    descriptor: RepositoryInstructionDescriptor;
    content: string;
}

/** Fixed-name, root-confined discovery. An unreadable AGENTS.md never selects a fallback. */
export async function readRepositoryInstructions(
    root: string,
): Promise<RepositoryInstructionSnapshot | undefined> {
    let path: RepositoryInstructionDescriptor['path'] = 'AGENTS.md';
    try {
        await lstat(resolve(root, path));
    } catch (error) {
        if (
            !(error instanceof Error) ||
            !('code' in error) ||
            error.code !== 'ENOENT'
        )
            return;
        path = 'CLAUDE.md';
    }
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
        const candidate = resolve(root, path);
        if (!(await lstat(candidate)).isFile()) return;
        handle = await open(
            candidate,
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        const opened = await handle.stat();
        const canonical = await realpath(candidate);
        const offset = relative(root, canonical);
        const current = await stat(canonical);
        if (
            !opened.isFile() ||
            isAbsolute(offset) ||
            offset === '..' ||
            offset.startsWith(`..${sep}`) ||
            opened.dev !== current.dev ||
            opened.ino !== current.ino
        )
            return;
        const buffer = Buffer.alloc(REPOSITORY_INSTRUCTION_MAX_BYTES + 1);
        let length = 0;
        while (length < buffer.length) {
            const read = await handle.read(
                buffer,
                length,
                buffer.length - length,
                length,
            );
            if (read.bytesRead === 0) break;
            length += read.bytesRead;
        }
        const truncated = length > REPOSITORY_INSTRUCTION_MAX_BYTES;
        const decoder = new TextDecoder('utf-8', {
            fatal: true,
            ignoreBOM: true,
        });
        const content = decoder.decode(
            buffer.subarray(
                0,
                Math.min(length, REPOSITORY_INSTRUCTION_MAX_BYTES),
            ),
            { stream: truncated },
        );
        if (content.includes('\0')) return;
        return {
            descriptor: {
                path,
                bytes: Buffer.byteLength(content),
                sha256: createHash('sha256').update(content).digest('hex'),
                truncated,
            },
            content,
        };
    } catch {
        return;
    } finally {
        await handle?.close().catch(() => undefined);
    }
}
