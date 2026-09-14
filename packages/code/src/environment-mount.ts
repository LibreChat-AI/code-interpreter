import { open } from 'node:fs/promises';
import { posix } from 'node:path';

interface Mount {
    device: string;
    root: string;
    point: string;
}
const inside = (root: string, path: string): boolean =>
    path === root || path.startsWith(root === '/' ? '/' : `${root}/`);
const decode = (path: string): string => {
    if (!path.startsWith('/') || /\\(?!040|011|012|134)/.test(path))
        throw new Error('Invalid environment mount table');
    return path.replace(/\\(040|011|012|134)/g, (_, octal: string) =>
        String.fromCharCode(parseInt(octal, 8)),
    );
};

/** Compare filesystem coordinates, not mount aliases. Include mounted descendants of each grant. */
export function createEnvironmentMountIsolation(
    table: string,
): (controls: readonly string[], roots: readonly string[]) => void {
    if (Buffer.byteLength(table) > 4 * 1024 * 1024)
        throw new Error('Environment mount table exceeds limit');
    const mounts: Mount[] = table
        .trimEnd()
        .split('\n')
        .map(line => {
            const fields = line.split(' ');
            const separator = fields.indexOf('-', 6);
            if (
                separator < 6 ||
                fields.length !== separator + 4 ||
                !/^\d+:\d+$/.test(fields[2] ?? '')
            )
                throw new Error('Invalid environment mount table');
            return {
                device: fields[2],
                root: decode(fields[3] ?? ''),
                point: decode(fields[4] ?? ''),
            };
        });
    const cache = new Map<string, { device: string; path: string }[]>();
    const coordinate = (path: string): { device: string; path: string }[] => {
        const cached = cache.get(path);
        if (cached) return cached;
        // Include every possible backing mapping. Hidden/stacked mounts may cause
        // conservative rejection but must never hide an accessible control path.
        const result = mounts
            .filter(mount => inside(mount.point, path))
            .map(mount => ({
                device: mount.device,
                path: posix.join(mount.root, posix.relative(mount.point, path)),
            }));
        if (!result.length || result.length > 256)
            throw new Error(
                'Environment path has an unsupported mount mapping',
            );
        cache.set(path, result);
        return result;
    };
    return (controls, roots) => {
        const points = new Set(roots);
        for (const mount of mounts)
            if (roots.some(root => inside(root, mount.point)))
                points.add(mount.point);
        if (points.size > 256)
            throw new Error('Too many workspace mount boundaries');
        const exposed = [...points].flatMap(coordinate);
        if (exposed.length > 1024)
            throw new Error('Too many workspace mount mappings');
        for (const control of controls) {
            const target = coordinate(control);
            if (
                target.some(target =>
                    exposed.some(
                        root =>
                            root.device === target.device &&
                            inside(root.path, target.path),
                    ),
                )
            ) {
                throw new Error(
                    'Environment control path is writable through a workspace mount alias',
                );
            }
        }
    };
}

export function assertEnvironmentMountIsolation(
    table: string,
    controls: readonly string[],
    roots: readonly string[],
): void {
    createEnvironmentMountIsolation(table)(controls, roots);
}

export async function readEnvironmentMountTable(): Promise<string | undefined> {
    if (process.platform !== 'linux') return undefined;
    const handle = await open('/proc/self/mountinfo', 'r');
    try {
        const buffer = Buffer.alloc(4 * 1024 * 1024 + 1);
        let length = 0;
        while (length < buffer.length) {
            const result = await handle.read(
                buffer,
                length,
                buffer.length - length,
                null,
            );
            if (!result.bytesRead) break;
            length += result.bytesRead;
        }
        if (length === buffer.length)
            throw new Error('Environment mount table exceeds limit');
        return new TextDecoder('utf-8', { fatal: true }).decode(
            buffer.subarray(0, length),
        );
    } finally {
        await handle.close();
    }
}
