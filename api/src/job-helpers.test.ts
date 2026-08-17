import { describe, it, expect, mock } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    resolveOriginalName,
    isNormalizedObjectForSession,
    markerConflictsWithExplicitFile,
    aggregateBashExtras,
    ensureNodeModulesSymlink,
    isHiddenDirectory,
    inputsLiveUnder,
    mapWithConcurrency,
    mimeTypeFor,
} from './job';
import type { Runtime } from './runtime';
import type { TFile } from './job';
import * as semver from 'semver';

/**
 * Unit tests for the pure helpers extracted from job.ts during the flattening
 * refactor. These are tested directly (not through Job.execute) because they
 * are pure functions — easier to exercise every branch without spinning up
 * the sandbox infrastructure.
 */

function makeRuntime(
    overrides: Partial<Runtime> & { language: string; pkgdir: string },
): Runtime {
    return {
        version: new semver.SemVer('1.0.0'),
        aliases: [],
        compiled: false,
        env_vars: {},
        timeouts: { compile: 5000, run: 5000 },
        cpu_times: { compile: 5000, run: 5000 },
        memory_limits: { compile: 100_000_000, run: 100_000_000 },
        max_process_count: 100,
        max_open_files: 100,
        max_file_size: 10_000_000,
        output_max_size: 1_000_000,
        ...overrides,
    };
}

describe('resolveOriginalName', () => {
    function responseWithHeader(value?: string): Response {
        const headers = new Headers();
        if (value !== undefined) headers.set('content-disposition', value);
        return new Response(null, { headers });
    }

    it('returns file.name when no Content-Disposition is present', () => {
        expect(
            resolveOriginalName(responseWithHeader(), {
                name: 'script.py',
                id: 'abc',
            }),
        ).toBe('script.py');
    });

    it('extracts quoted filename from Content-Disposition', () => {
        expect(
            resolveOriginalName(
                responseWithHeader('attachment; filename="server-name.py"'),
                { name: 'client-name.py', id: 'abc' },
            ),
        ).toBe('server-name.py');
    });

    it('extracts unquoted filename from Content-Disposition', () => {
        expect(
            resolveOriginalName(
                responseWithHeader('attachment; filename=plain.txt'),
                { name: 'ignored.txt', id: 'abc' },
            ),
        ).toBe('plain.txt');
    });

    it('falls back to file.id when file.name is empty and no header exists', () => {
        expect(
            resolveOriginalName(responseWithHeader(), {
                name: '',
                id: 'file-id-123',
            }),
        ).toBe('file-id-123');
    });

    it('falls back to file.name when header is malformed (no filename token)', () => {
        expect(
            resolveOriginalName(responseWithHeader('attachment'), {
                name: 'fallback.py',
                id: 'abc',
            }),
        ).toBe('fallback.py');
    });

    it('stops at the closing quote when the quoted filename is followed by more params', () => {
        expect(
            resolveOriginalName(
                responseWithHeader('attachment; filename="foo.txt"; size=123'),
                { name: 'ignored', id: 'abc' },
            ),
        ).toBe('foo.txt');
    });

    it('stops at a semicolon when the unquoted filename is followed by more params', () => {
        expect(
            resolveOriginalName(
                responseWithHeader('attachment; filename=foo.txt; size=123'),
                { name: 'ignored', id: 'abc' },
            ),
        ).toBe('foo.txt');
    });

    it('stops at whitespace when the unquoted filename is followed by whitespace-separated params', () => {
        expect(
            resolveOriginalName(
                responseWithHeader('attachment; filename=foo.txt extra'),
                { name: 'ignored', id: 'abc' },
            ),
        ).toBe('foo.txt');
    });

    it('returns empty string when both name and id are absent', () => {
        expect(resolveOriginalName(responseWithHeader(), { name: '' })).toBe(
            '',
        );
    });

    it('returns empty string when name is empty, id is absent, and header is malformed', () => {
        expect(
            resolveOriginalName(responseWithHeader('attachment'), { name: '' }),
        ).toBe('');
    });

    it('decodes RFC 5987 filename*= preserving slashes for nested artifact paths', () => {
        expect(
            resolveOriginalName(
                responseWithHeader(
                    "attachment; filename*=UTF-8''test_folder%2Ftest_file.txt",
                ),
                { name: 'test_file.txt', id: 'abc' },
            ),
        ).toBe('test_folder/test_file.txt');
    });

    it('decodes RFC 5987 filename*= with a UTF-8 charset that includes a language tag', () => {
        expect(
            resolveOriginalName(
                responseWithHeader(
                    "attachment; filename*=UTF-8'en'foo%20bar.txt",
                ),
                { name: 'ignored', id: 'abc' },
            ),
        ).toBe('foo bar.txt');
    });

    it('decodes RFC 5987 filename*= with non-ASCII characters', () => {
        expect(
            resolveOriginalName(
                responseWithHeader(
                    "attachment; filename*=UTF-8''%E4%BD%A0%E5%A5%BD.txt",
                ),
                { name: 'ignored', id: 'abc' },
            ),
        ).toBe('你好.txt');
    });

    it('tolerates a filename*= form missing the UTF-8 prefix', () => {
        expect(
            resolveOriginalName(
                responseWithHeader('attachment; filename*=plain.txt'),
                { name: 'ignored', id: 'abc' },
            ),
        ).toBe('plain.txt');
    });

    it('falls through to legacy filename= when filename*= is malformed', () => {
        expect(
            resolveOriginalName(
                responseWithHeader(
                    'attachment; filename*=UTF-8\'\'bad%ZZ; filename="legacy.txt"',
                ),
                { name: 'ignored', id: 'abc' },
            ),
        ).toBe('legacy.txt');
    });

    it('prefers filename*= over a legacy filename= present in the same header', () => {
        expect(
            resolveOriginalName(
                responseWithHeader(
                    'attachment; filename="legacy.txt"; filename*=UTF-8\'\'nested%2Ffile.txt',
                ),
                { name: 'ignored', id: 'abc' },
            ),
        ).toBe('nested/file.txt');
    });
});

describe('mimeTypeFor', () => {
    it('returns the registered MIME for image extensions', () => {
        expect(mimeTypeFor('plot.png')).toBe('image/png');
        expect(mimeTypeFor('photo.jpg')).toBe('image/jpeg');
        expect(mimeTypeFor('photo.JPEG')).toBe('image/jpeg');
        expect(mimeTypeFor('icon.svg')).toBe('image/svg+xml');
    });

    it('returns the registered MIME for text extensions', () => {
        expect(mimeTypeFor('notes.txt')).toBe('text/plain');
        expect(mimeTypeFor('README.md')).toBe('text/markdown');
        expect(mimeTypeFor('data.csv')).toBe('text/csv');
        expect(mimeTypeFor('page.html')).toBe('text/html');
        expect(mimeTypeFor('config.json')).toBe('application/json');
    });

    it('returns the registered MIME for code extensions', () => {
        expect(mimeTypeFor('script.py')).toBe('text/x-python');
        expect(mimeTypeFor('app.js')).toBe('text/javascript');
        expect(mimeTypeFor('main.go')).toBe('text/x-go');
    });

    it('returns the registered MIME for archives', () => {
        expect(mimeTypeFor('bundle.zip')).toBe('application/zip');
        expect(mimeTypeFor('logs.tar.gz')).toBe('application/gzip');
    });

    it('falls back to application/octet-stream for unknown extensions', () => {
        expect(mimeTypeFor('mystery.qwerty')).toBe('application/octet-stream');
    });

    it('falls back to application/octet-stream for files with no extension', () => {
        expect(mimeTypeFor('Makefile')).toBe('application/octet-stream');
        expect(mimeTypeFor('README')).toBe('application/octet-stream');
    });

    it('uses the basename so directory-name dots do not false-trigger', () => {
        /* `proj.v1/notes` should yield `application/octet-stream` (no real
         * extension on `notes`), not `text/x-typescript` from a stray `.ts`
         * earlier in the path or anything else surprising. */
        expect(mimeTypeFor('proj.v1/notes')).toBe('application/octet-stream');
        expect(mimeTypeFor('a/b/c.png')).toBe('image/png');
    });

    it('handles Windows-style backslash separators in paths', () => {
        expect(mimeTypeFor('a\\b\\c.png')).toBe('image/png');
        expect(mimeTypeFor('proj.v1\\notes')).toBe('application/octet-stream');
    });

    it('treats dotfiles without a second extension as having no MIME', () => {
        /* `.gitignore` is a dotfile with no extension; the basename's first
         * char being `.` makes `dot === 0`, which we treat as no-extension
         * and fall back. */
        expect(mimeTypeFor('.gitignore')).toBe('application/octet-stream');
        expect(mimeTypeFor('.env')).toBe('application/octet-stream');
    });

    it('uses the LAST dot for compound extensions like .tar.gz', () => {
        /* `.tar.gz` is registered as gzip in the table; the lookup keys on
         * the suffix after the last dot, which is `.gz`. */
        expect(mimeTypeFor('archive.tar.gz')).toBe('application/gzip');
    });
});

describe('isHiddenDirectory', () => {
    it('returns true for typical runtime caches', () => {
        expect(isHiddenDirectory('.cache')).toBe(true);
        expect(isHiddenDirectory('.config')).toBe(true);
        expect(isHiddenDirectory('.local')).toBe(true);
    });

    it('returns false for normal directories', () => {
        expect(isHiddenDirectory('src')).toBe(false);
        expect(isHiddenDirectory('node_modules')).toBe(false);
    });

    it('returns false for `.` and `..` traversal markers', () => {
        expect(isHiddenDirectory('.')).toBe(false);
        expect(isHiddenDirectory('..')).toBe(false);
    });

    it('returns false for empty string', () => {
        expect(isHiddenDirectory('')).toBe(false);
    });
});

describe('inputsLiveUnder', () => {
    function inputs(...names: string[]): Map<string, TFile> {
        return new Map(names.map(n => [n, { name: n, id: 'x' }]));
    }

    it('returns true when an input file lives directly inside the directory', () => {
        expect(inputsLiveUnder(inputs('.config/foo.txt'), '.config')).toBe(
            true,
        );
    });

    it('returns true when an input file lives in a nested subdirectory', () => {
        expect(inputsLiveUnder(inputs('.config/sub/file.txt'), '.config')).toBe(
            true,
        );
    });

    it('returns true when an input is the directory path itself (e.g. a marker file)', () => {
        expect(inputsLiveUnder(inputs('.config'), '.config')).toBe(true);
    });

    it('returns false when no input lives under the directory', () => {
        expect(inputsLiveUnder(inputs('main.py', 'data.csv'), '.cache')).toBe(
            false,
        );
    });

    it('does not match prefix-without-separator (.cachedir vs .cache)', () => {
        expect(inputsLiveUnder(inputs('.cachedir/foo'), '.cache')).toBe(false);
    });

    it('returns false for empty input map', () => {
        expect(inputsLiveUnder(new Map(), '.cache')).toBe(false);
    });
});

describe('mapWithConcurrency', () => {
    function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
        let resolve!: (v: T) => void;
        const promise = new Promise<T>(r => {
            resolve = r;
        });
        return { promise, resolve };
    }

    it('returns an empty array for empty input without invoking fn', async () => {
        const fn = mock(async () => 'x');
        expect(await mapWithConcurrency([], 4, fn)).toEqual([]);
        expect(fn).not.toHaveBeenCalled();
    });

    it('preserves input order in the result regardless of completion order', async () => {
        const result = await mapWithConcurrency([3, 1, 2], 2, async n => {
            await new Promise(r => setTimeout(r, n * 5));
            return n * 10;
        });
        expect(result).toEqual([30, 10, 20]);
    });

    it('runs at most `concurrency` tasks in flight at once', async () => {
        const inFlight: number[] = [];
        let max = 0;
        const result = await mapWithConcurrency(
            [1, 2, 3, 4, 5, 6],
            2,
            async n => {
                inFlight.push(n);
                max = Math.max(max, inFlight.length);
                await new Promise(r => setTimeout(r, 5));
                inFlight.splice(inFlight.indexOf(n), 1);
                return n;
            },
        );
        expect(result).toEqual([1, 2, 3, 4, 5, 6]);
        expect(max).toBe(2);
    });

    it('starts the next item as soon as a worker frees up (no batching)', async () => {
        /* If items[0] takes forever and items[1..3] are fast, with cap=2 the
         * fast ones must complete in 1..3 even though item 0 is still pending —
         * proving workers are independent slots, not fixed-size batches. */
        const finished: number[] = [];
        const blocker = deferred<void>();
        const promise = mapWithConcurrency([0, 1, 2, 3], 2, async n => {
            if (n === 0) {
                await blocker.promise;
            } else {
                await new Promise(r => setTimeout(r, 1));
            }
            finished.push(n);
            return n;
        });
        /* Give the fast ones time to drain through the second slot. */
        await new Promise(r => setTimeout(r, 50));
        expect(finished).toEqual([1, 2, 3]);
        blocker.resolve();
        await promise;
        expect(finished).toEqual([1, 2, 3, 0]);
    });

    it('clamps a 0 or negative concurrency to 1 instead of deadlocking', async () => {
        expect(
            await mapWithConcurrency([1, 2, 3], 0, async n => n * 2),
        ).toEqual([2, 4, 6]);
        expect(
            await mapWithConcurrency([1, 2, 3], -5, async n => n * 2),
        ).toEqual([2, 4, 6]);
    });

    it('clamps a concurrency above input length without spawning idle workers', async () => {
        let calls = 0;
        const result = await mapWithConcurrency([1, 2], 999, async n => {
            calls++;
            return n;
        });
        expect(result).toEqual([1, 2]);
        expect(calls).toBe(2);
    });

    it('passes the index as the second arg to fn', async () => {
        const calls: Array<[string, number]> = [];
        await mapWithConcurrency(['a', 'b', 'c'], 2, async (item, idx) => {
            calls.push([item, idx]);
            return item;
        });
        expect(calls.sort()).toEqual([
            ['a', 0],
            ['b', 1],
            ['c', 2],
        ]);
    });
});

describe('isNormalizedObjectForSession', () => {
    it('accepts a well-formed object whose storage_session_id matches', () => {
        const guard = isNormalizedObjectForSession('sess-abc');
        expect(
            guard({ id: 'x', name: 'n', storage_session_id: 'sess-abc' }),
        ).toBe(true);
    });

    it('rejects an object whose storage_session_id is a shorter prefix (MinIO leak)', () => {
        const guard = isNormalizedObjectForSession('sess-abc');
        expect(guard({ id: 'x', name: 'n', storage_session_id: 'sess' })).toBe(
            false,
        );
    });

    it('rejects an object whose storage_session_id is a longer prefix-match', () => {
        const guard = isNormalizedObjectForSession('abc');
        expect(
            guard({ id: 'x', name: 'n', storage_session_id: 'abcdef' }),
        ).toBe(false);
    });

    it('rejects non-objects', () => {
        const guard = isNormalizedObjectForSession('s');
        expect(guard(null)).toBe(false);
        expect(guard(undefined)).toBe(false);
        expect(guard(42)).toBe(false);
        expect(guard('str')).toBe(false);
    });

    it('rejects objects missing any of id/name/storage_session_id', () => {
        const guard = isNormalizedObjectForSession('s');
        expect(guard({ name: 'n', storage_session_id: 's' })).toBe(false);
        expect(guard({ id: 'x', storage_session_id: 's' })).toBe(false);
        expect(guard({ id: 'x', name: 'n' })).toBe(false);
    });

    it('rejects objects whose fields are non-string', () => {
        const guard = isNormalizedObjectForSession('s');
        expect(guard({ id: 1, name: 'n', storage_session_id: 's' })).toBe(
            false,
        );
        expect(guard({ id: 'x', name: 2, storage_session_id: 's' })).toBe(
            false,
        );
        expect(guard({ id: 'x', name: 'n', storage_session_id: 3 })).toBe(
            false,
        );
    });
});

describe('markerConflictsWithExplicitFile', () => {
    it('returns false for a root-level .dirkeep marker', () => {
        expect(markerConflictsWithExplicitFile('.dirkeep', ['foo.py'])).toBe(
            false,
        );
    });

    it("returns true when an explicit file sits exactly at the marker's parent dir", () => {
        expect(markerConflictsWithExplicitFile('foo/.dirkeep', ['foo'])).toBe(
            true,
        );
    });

    it("returns true when an explicit file is an ancestor of the marker's parent dir", () => {
        expect(
            markerConflictsWithExplicitFile('foo/bar/baz/.dirkeep', [
                'foo/bar',
            ]),
        ).toBe(true);
    });

    it('returns false when explicit files live under a different subtree', () => {
        expect(
            markerConflictsWithExplicitFile('foo/.dirkeep', [
                'bar.py',
                'other/baz.py',
            ]),
        ).toBe(false);
    });

    it('does not treat prefix-without-separator as a conflict (foo vs foobar)', () => {
        expect(
            markerConflictsWithExplicitFile('foobar/.dirkeep', ['foo']),
        ).toBe(false);
    });
});

describe('aggregateBashExtras', () => {
    it('returns undefined when no other runtimes are installed', () => {
        const runtimes = [
            makeRuntime({ language: 'bash', pkgdir: '/pkg/bash' }),
        ];
        const env: Record<string, string> = { PATH: '/usr/bin' };
        expect(aggregateBashExtras('/pkg/bash', env, runtimes)).toBeUndefined();
        expect(env.PATH).toBe('/usr/bin');
    });

    it('collects one pkgdir per language, picking the highest version', () => {
        const runtimes = [
            makeRuntime({ language: 'bash', pkgdir: '/pkg/bash' }),
            makeRuntime({
                language: 'python',
                pkgdir: '/pkg/py311',
                version: new semver.SemVer('3.11.0'),
            }),
            makeRuntime({
                language: 'python',
                pkgdir: '/pkg/py310',
                version: new semver.SemVer('3.10.0'),
            }),
            makeRuntime({
                language: 'node',
                pkgdir: '/pkg/node20',
                version: new semver.SemVer('20.0.0'),
            }),
        ];
        const env: Record<string, string> = {};
        const extras = aggregateBashExtras('/pkg/bash', env, runtimes);
        expect(extras).toEqual(['/pkg/node20', '/pkg/py311']);
    });

    it('prepends PATH entries from other runtimes without duplicates', () => {
        const runtimes = [
            makeRuntime({ language: 'bash', pkgdir: '/pkg/bash' }),
            makeRuntime({
                language: 'python',
                pkgdir: '/pkg/py',
                env_vars: { PATH: '/pkg/py/bin:/usr/bin' },
            }),
            makeRuntime({
                language: 'node',
                pkgdir: '/pkg/node',
                env_vars: { PATH: '/pkg/node/bin:/usr/bin' },
            }),
        ];
        const env: Record<string, string> = { PATH: '/usr/bin' };
        aggregateBashExtras('/pkg/bash', env, runtimes);
        expect(env.PATH).toBe('/pkg/node/bin:/pkg/py/bin:/usr/bin');
    });

    it('merges NODE_PATH entries from JavaScript runtimes, preferring Node packages', () => {
        const runtimes = [
            makeRuntime({ language: 'bash', pkgdir: '/pkg/bash' }),
            makeRuntime({
                language: 'javascript',
                runtime: 'bun',
                pkgdir: '/pkg/bun',
                env_vars: { NODE_PATH: '/pkg/bun/node_modules' },
            }),
            makeRuntime({
                language: 'node',
                pkgdir: '/pkg/node',
                env_vars: { NODE_PATH: '/pkg/node/node_modules' },
            }),
        ];
        const env: Record<string, string> = {
            NODE_PATH: '/workspace/node_modules',
        };
        const linkTarget: { nodeModulesPath?: string } = {};
        aggregateBashExtras('/pkg/bash', env, runtimes, linkTarget);
        expect(env.NODE_PATH).toBe(
            '/workspace/node_modules:/pkg/node/node_modules:/pkg/bun/node_modules',
        );
        expect(linkTarget.nodeModulesPath).toBe('/pkg/node/node_modules');
    });

    it('prefers NODE_PATH from runtimes backed by node', () => {
        const runtimes = [
            makeRuntime({ language: 'bash', pkgdir: '/pkg/bash' }),
            makeRuntime({
                language: 'javascript',
                runtime: 'node',
                pkgdir: '/pkg/node-js',
                env_vars: { NODE_PATH: '/pkg/node-js/node_modules' },
            }),
            makeRuntime({
                language: 'typescript',
                runtime: 'bun',
                pkgdir: '/pkg/bun-ts',
                env_vars: { NODE_PATH: '/pkg/bun-ts/node_modules' },
            }),
        ];
        const env: Record<string, string> = {
            NODE_PATH: '/workspace/node_modules',
        };
        const linkTarget: { nodeModulesPath?: string } = {};
        aggregateBashExtras('/pkg/bash', env, runtimes, linkTarget);
        expect(env.NODE_PATH).toBe(
            '/workspace/node_modules:/pkg/node-js/node_modules:/pkg/bun-ts/node_modules',
        );
        expect(linkTarget.nodeModulesPath).toBe('/pkg/node-js/node_modules');
    });

    it('does not re-add the bash pkgdir itself', () => {
        const runtimes = [
            makeRuntime({ language: 'bash', pkgdir: '/pkg/bash' }),
            makeRuntime({ language: 'python', pkgdir: '/pkg/bash' }),
        ];
        const env: Record<string, string> = {};
        expect(aggregateBashExtras('/pkg/bash', env, runtimes)).toBeUndefined();
    });

    it('tolerates runtimes with no PATH in env_vars', () => {
        const runtimes = [
            makeRuntime({ language: 'bash', pkgdir: '/pkg/bash' }),
            makeRuntime({ language: 'python', pkgdir: '/pkg/py' }),
        ];
        const env: Record<string, string> = {};
        expect(aggregateBashExtras('/pkg/bash', env, runtimes)).toEqual([
            '/pkg/py',
        ]);
        expect(env.PATH).toBeUndefined();
    });

    it('initializes PATH with the first entry when env.PATH was unset', () => {
        const runtimes = [
            makeRuntime({ language: 'bash', pkgdir: '/pkg/bash' }),
            makeRuntime({
                language: 'python',
                pkgdir: '/pkg/py',
                env_vars: { PATH: '/pkg/py/bin' },
            }),
        ];
        const env: Record<string, string> = {};
        aggregateBashExtras('/pkg/bash', env, runtimes);
        expect(env.PATH).toBe('/pkg/py/bin');
    });
});

describe('ensureNodeModulesSymlink', () => {
    it('creates a node_modules symlink for bash-launched ESM imports', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeapi-job-'));
        const target = path.join(tmpDir, 'runtime-node_modules');
        const submissionDir = path.join(tmpDir, 'submission');

        try {
            fs.mkdirSync(target);
            fs.mkdirSync(submissionDir);
            ensureNodeModulesSymlink(submissionDir, target);

            const linkPath = path.join(submissionDir, 'node_modules');
            expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
            expect(fs.readlinkSync(linkPath)).toBe(target);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('does not replace an existing user-provided node_modules path', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeapi-job-'));
        const target = path.join(tmpDir, 'runtime-node_modules');
        const submissionDir = path.join(tmpDir, 'submission');
        const userNodeModules = path.join(submissionDir, 'node_modules');

        try {
            fs.mkdirSync(target);
            fs.mkdirSync(submissionDir);
            fs.mkdirSync(userNodeModules);
            ensureNodeModulesSymlink(submissionDir, target);

            const stat = fs.lstatSync(userNodeModules);
            expect(stat.isDirectory()).toBe(true);
            expect(stat.isSymbolicLink()).toBe(false);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});
