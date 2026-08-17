import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import * as semver from 'semver';
import { Job, type TFile } from './job';
import type { Runtime } from './runtime';
import { config } from './config';
import { DIRKEEP } from './validation';
import { SessionWorkspace } from './session-workspace';

/**
 * Integration tests for Job.walkDir and its extracted helpers. These tests
 * touch the real filesystem via a per-test temp directory (AGENTS.md: "real
 * logic over mocks") and invoke walkDir directly through a narrow cast that
 * exposes the private surface without leaking `any`.
 */

/** Structural mirror of Job's private surface used by these tests. If any
 * field or method is renamed in Job, the `as unknown as` cast below will
 * still compile but tests fail at runtime — update this interface to match. */
interface WalkerInternals {
    submissionDir: string;
    entryPointName: string | undefined;
    generatedFiles: Array<{ id: string; name: string; path: string }>;
    sessionFiles: Array<{
        id: string;
        name: string;
        storage_session_id: string;
        modified_from?: { id: string; storage_session_id: string };
        inherited?: true;
        entity_id?: string;
    }>;
    inheritedRefs: Array<{
        id: string;
        name: string;
        storage_session_id: string;
        inherited?: true;
        entity_id?: string;
    }>;
    pendingSurfaced: Map<string, { name: string; signature: string }>;
    inputFileHashes: Map<
        string,
        {
            hash: string;
            path: string;
            originalId?: string;
            originalSessionId?: string;
            readOnly?: boolean;
        }
    >;
    files: TFile[];
    reusePrimedInput: (file: TFile) => Promise<boolean>;
    writeFile: (file: TFile) => Promise<void>;
    walkDir: (
        dir: string,
        depth: number,
        inputByName: Map<string, TFile>,
    ) => Promise<'collected' | 'empty' | 'skipped'>;
    handleSessionFiles: () => Promise<void>;
}

function asInternals(job: Job): WalkerInternals {
    return job as unknown as WalkerInternals;
}

function makeRuntime(language = 'python', maxFileSize = 10_000_000): Runtime {
    return {
        language,
        version: new semver.SemVer('3.11.0'),
        aliases: [],
        pkgdir: '/tmp',
        compiled: false,
        env_vars: {},
        timeouts: { compile: 5000, run: 5000 },
        cpu_times: { compile: 5000, run: 5000 },
        memory_limits: { compile: 100_000_000, run: 100_000_000 },
        max_process_count: 100,
        max_open_files: 100,
        max_file_size: maxFileSize,
        output_max_size: 1_000_000,
    };
}

function makeJob(
    opts: {
        files?: TFile[];
        language?: string;
        /* The Job-constructor seed for `this.uuid` — top-level execution
         * session id (one sandbox `/exec` invocation), not the per-file
         * `storage_session_id` carried on each file ref. */
        session_id?: string;
        maxFileSize?: number;
        session?: SessionWorkspace;
    } = {},
): Job {
    return new Job({
        session_id: opts.session_id ?? 'test-session',
        runtime: makeRuntime(opts.language, opts.maxFileSize),
        files: opts.files ?? [],
        args: [],
        stdin: '',
        timeouts: { compile: 5000, run: 5000 },
        cpu_times: { compile: 5000, run: 5000 },
        memory_limits: { compile: 100_000_000, run: 100_000_000 },
        session: opts.session,
    });
}

function sha256(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex');
}

let tmpDir: string;

beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'codeapi-walker-'));
});

afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
});

function buildInputByName(files: TFile[]): Map<string, TFile> {
    return new Map(files.map(f => [f.name, f]));
}

describe('walkDir / empty-directory detection', () => {
    it('creates a .dirkeep marker for a genuinely empty subdirectory', async () => {
        await fsp.mkdir(path.join(tmpDir, 'empty'));

        const job = makeJob();
        const internals = asInternals(job);
        internals.submissionDir = tmpDir;

        const status = await internals.walkDir(tmpDir, 0, new Map());

        expect(status).toBe('collected');
        expect(internals.generatedFiles).toHaveLength(1);
        expect(internals.generatedFiles[0].name).toBe(
            path.join('empty', DIRKEEP),
        );
        expect(internals.sessionFiles[0].name).toBe(
            path.join('empty', DIRKEEP),
        );
        await fsp.access(path.join(tmpDir, 'empty', DIRKEEP));
    });

    it('does not create a marker for non-empty directories', async () => {
        await fsp.mkdir(path.join(tmpDir, 'hasfile'));
        await fsp.writeFile(
            path.join(tmpDir, 'hasfile', 'code.py'),
            'print(1)',
        );

        const job = makeJob();
        const internals = asInternals(job);
        internals.submissionDir = tmpDir;

        await internals.walkDir(tmpDir, 0, new Map());

        const names = internals.generatedFiles.map(f => f.name);
        expect(names).toContain(path.join('hasfile', 'code.py'));
        expect(names).not.toContain(path.join('hasfile', DIRKEEP));
    });
});

describe('walkDir / inherited .dirkeep preservation', () => {
    it('echoes unchanged inherited .dirkeep via inheritedRefs (no re-upload)', async () => {
        await fsp.mkdir(path.join(tmpDir, 'preserved'));
        const keepRel = path.join('preserved', DIRKEEP);
        const keepFull = path.join(tmpDir, keepRel);
        await fsp.writeFile(keepFull, '');

        const inheritedFile: TFile = {
            id: 'prior-id',
            storage_session_id: 'prior-session',
            name: keepRel,
        };
        const job = makeJob();
        const internals = asInternals(job);
        internals.submissionDir = tmpDir;
        internals.inputFileHashes.set(keepRel, {
            hash: sha256(''),
            path: keepFull,
            originalId: 'prior-id',
            originalSessionId: 'prior-session',
        });

        await internals.walkDir(tmpDir, 0, buildInputByName([inheritedFile]));

        expect(internals.generatedFiles).toHaveLength(0);
        expect(internals.inheritedRefs).toHaveLength(1);
        expect(internals.inheritedRefs[0]).toEqual({
            id: 'prior-id',
            name: keepRel,
            storage_session_id: 'prior-session',
            inherited: true,
        });
    });

    it('refreshes modified inherited .dirkeep with modified_from', async () => {
        await fsp.mkdir(path.join(tmpDir, 'preserved'));
        const keepRel = path.join('preserved', DIRKEEP);
        const keepFull = path.join(tmpDir, keepRel);
        await fsp.writeFile(keepFull, 'modified');

        const inheritedFile: TFile = {
            id: 'prior-id',
            storage_session_id: 'prior-session',
            name: keepRel,
        };
        const job = makeJob({ session_id: 'current-session' });
        const internals = asInternals(job);
        internals.submissionDir = tmpDir;
        internals.inputFileHashes.set(keepRel, {
            hash: sha256(''),
            path: keepFull,
            originalId: 'prior-id',
            originalSessionId: 'prior-session',
        });

        await internals.walkDir(tmpDir, 0, buildInputByName([inheritedFile]));

        expect(internals.inheritedRefs).toHaveLength(0);
        expect(internals.generatedFiles).toHaveLength(1);
        expect(internals.sessionFiles).toHaveLength(1);
        expect(internals.sessionFiles[0].storage_session_id).toBe(
            'current-session',
        );
        expect(internals.sessionFiles[0].modified_from).toEqual({
            id: 'prior-id',
            storage_session_id: 'prior-session',
        });
    });
});

describe('walkDir / inline .dirkeep files', () => {
    it('preserves user-submitted inline .dirkeep content on disk (never overwritten with empty marker)', async () => {
        await fsp.mkdir(path.join(tmpDir, 'dir'));
        const keepRel = path.join('dir', DIRKEEP);
        const keepFull = path.join(tmpDir, keepRel);
        await fsp.writeFile(keepFull, 'user-supplied');

        const userKeep: TFile = { name: keepRel, content: 'user-supplied' };
        const job = makeJob();
        const internals = asInternals(job);
        internals.submissionDir = tmpDir;
        internals.inputFileHashes.set(keepRel, {
            hash: sha256('user-supplied'),
            path: keepFull,
        });

        await internals.walkDir(tmpDir, 0, buildInputByName([userKeep]));

        /* The safety guarantee: the user's content stays intact on disk —
         * walkDir never clobbers a user-supplied .dirkeep with an empty marker. */
        const stillPresent = await fsp.readFile(keepFull, 'utf8');
        expect(stillPresent).toBe('user-supplied');
    });

    it('re-emits unchanged inline .dirkeep with a fresh id so the client can carry it to continuations', async () => {
        await fsp.mkdir(path.join(tmpDir, 'dir'));
        const keepRel = path.join('dir', DIRKEEP);
        const keepFull = path.join(tmpDir, keepRel);
        await fsp.writeFile(keepFull, 'user-supplied');

        const userKeep: TFile = { name: keepRel, content: 'user-supplied' };
        const job = makeJob();
        const internals = asInternals(job);
        internals.submissionDir = tmpDir;
        internals.inputFileHashes.set(keepRel, {
            hash: sha256('user-supplied'),
            path: keepFull,
        });

        await internals.walkDir(tmpDir, 0, buildInputByName([userKeep]));

        /* Inline inputs have no persistent id, so skipping re-emission would
         * make the empty directory disappear on the next request. The client
         * must receive a fresh {id, storage_session_id} ref for each run. */
        const emitted = internals.generatedFiles.find(f => f.name === keepRel);
        expect(emitted).toBeDefined();
        const sessionRef = internals.sessionFiles.find(f => f.name === keepRel);
        expect(sessionRef).toBeDefined();
        expect(sessionRef?.id).toBe(emitted!.id);
    });

    it('re-emits modified user .dirkeep as a generated output', async () => {
        await fsp.mkdir(path.join(tmpDir, 'dir'));
        const keepRel = path.join('dir', DIRKEEP);
        const keepFull = path.join(tmpDir, keepRel);
        await fsp.writeFile(keepFull, 'changed-by-code');

        const userKeep: TFile = { name: keepRel, content: 'original' };
        const job = makeJob();
        const internals = asInternals(job);
        internals.submissionDir = tmpDir;
        internals.inputFileHashes.set(keepRel, {
            hash: sha256('original'),
            path: keepFull,
        });

        await internals.walkDir(tmpDir, 0, buildInputByName([userKeep]));

        expect(internals.generatedFiles).toHaveLength(1);
        expect(internals.generatedFiles[0].name).toBe(keepRel);
    });
});

describe('walkDir / regular file handling', () => {
    it('echoes unchanged downloaded inputs via inheritedRefs (not re-uploaded)', async () => {
        const name = 'inherited.py';
        const full = path.join(tmpDir, name);
        await fsp.writeFile(full, 'print("hi")');

        const downloaded: TFile = {
            id: 'download-id',
            storage_session_id: 'prev-session',
            name,
        };
        const job = makeJob();
        const internals = asInternals(job);
        internals.submissionDir = tmpDir;
        internals.inputFileHashes.set(name, {
            hash: sha256('print("hi")'),
            path: full,
            originalId: 'download-id',
            originalSessionId: 'prev-session',
        });

        await internals.walkDir(tmpDir, 0, buildInputByName([downloaded]));

        expect(internals.inheritedRefs).toHaveLength(1);
        expect(internals.inheritedRefs[0].id).toBe('download-id');
        expect(internals.inheritedRefs[0].storage_session_id).toBe(
            'prev-session',
        );
        expect(internals.inheritedRefs[0].inherited).toBe(true);
        expect(internals.generatedFiles).toHaveLength(0);
    });

    it('echoes per-file entity_id on inherited refs (round-trip preservation)', async () => {
        /* Round-trip contract: when an input arrives with `entity_id` (the
         * caller's per-file authorization scope), the inherited-ref echo
         * back in the response MUST carry it. Tests the FULL path through
         * the Job constructor — earlier versions of this test built
         * `inputByName` from raw TFiles and bypassed the constructor's
         * field-selection map, hiding the constructor's silent strip of
         * unknown fields. With the fix, the constructor preserves
         * `entity_id` so the walker can find it on `existingFile`. */
        const name = 'pptx/pptxgenjs.md';
        const full = path.join(tmpDir, name);
        await fsp.mkdir(path.dirname(full), { recursive: true });
        await fsp.writeFile(full, 'docs');

        const downloaded: TFile = {
            id: 'doc-id',
            storage_session_id: 'storage-session-A',
            name,
            entity_id: 'skill-pptx-123',
        };
        /* Pass the file via the constructor — same path the worker uses
         * when handling a real `/exec` request body. */
        const job = makeJob({ files: [downloaded] });
        const internals = asInternals(job);
        internals.submissionDir = tmpDir;
        internals.inputFileHashes.set(name, {
            hash: sha256('docs'),
            path: full,
            originalId: 'doc-id',
            originalSessionId: 'storage-session-A',
        });

        /* Build `inputByName` from the post-constructor `internals.files`,
         * not the raw input array. Anything the constructor dropped is
         * invisible from here on out — which is the production failure
         * mode this test now actually catches. */
        await internals.walkDir(tmpDir, 0, buildInputByName(internals.files));

        expect(internals.inheritedRefs).toHaveLength(1);
        expect(internals.inheritedRefs[0]).toEqual({
            id: 'doc-id',
            name,
            storage_session_id: 'storage-session-A',
            inherited: true,
            entity_id: 'skill-pptx-123',
        });
    });

    it('omits entity_id on inherited refs when the input had none (legacy clients)', async () => {
        /* Wire-compat: pre-entity_id callers send TFiles without the field;
         * the response stays clean (no stray `entity_id: undefined`). */
        const name = 'inherited.py';
        const full = path.join(tmpDir, name);
        await fsp.writeFile(full, 'print("hi")');

        const downloaded: TFile = {
            id: 'download-id',
            storage_session_id: 'prev-session',
            name,
        };
        const job = makeJob();
        const internals = asInternals(job);
        internals.submissionDir = tmpDir;
        internals.inputFileHashes.set(name, {
            hash: sha256('print("hi")'),
            path: full,
            originalId: 'download-id',
            originalSessionId: 'prev-session',
        });

        await internals.walkDir(tmpDir, 0, buildInputByName([downloaded]));

        expect(internals.inheritedRefs).toHaveLength(1);
        expect(internals.inheritedRefs[0]).not.toHaveProperty('entity_id');
    });

    it('treats a by-ref-shaped file without a hash baseline as generated', async () => {
        const name = 'inherited.py';
        const full = path.join(tmpDir, name);
        /* Defense in depth for callers that construct a Job directly without
         * priming it. Normal execution now fails before running when a required
         * download cannot be completed. */
        await fsp.writeFile(full, 'print("new bytes produced by the run")');

        const downloaded: TFile = {
            id: 'stale-id',
            storage_session_id: 'prev-session',
            name,
        };
        const job = makeJob();
        const internals = asInternals(job);
        internals.submissionDir = tmpDir;

        await internals.walkDir(tmpDir, 0, buildInputByName([downloaded]));

        expect(internals.inheritedRefs).toHaveLength(0);
        expect(internals.generatedFiles).toHaveLength(1);
        expect(internals.generatedFiles[0].id).not.toBe('stale-id');
        const sessionRef = internals.sessionFiles.find(f => f.name === name);
        expect(sessionRef?.id).toBe(internals.generatedFiles[0].id);
        expect(sessionRef?.storage_session_id).toBe('test-session');
    });

    it('skips unchanged inline entry-point source (no round-trip)', async () => {
        const name = 'main.py';
        const full = path.join(tmpDir, name);
        await fsp.writeFile(full, 'print(1)');

        const inline: TFile = { name, content: 'print(1)' };
        const job = makeJob({ files: [inline] });
        const internals = asInternals(job);
        internals.submissionDir = tmpDir;
        internals.entryPointName = name;
        internals.inputFileHashes.set(name, {
            hash: sha256('print(1)'),
            path: full,
        });

        await internals.walkDir(tmpDir, 0, buildInputByName([inline]));

        expect(internals.generatedFiles).toHaveLength(0);
        expect(internals.inheritedRefs).toHaveLength(0);
        expect(internals.sessionFiles).toHaveLength(0);
    });

    it('re-emits unchanged inline auxiliary file so client gets an id for continuation', async () => {
        const name = 'helper.py';
        const full = path.join(tmpDir, name);
        await fsp.writeFile(full, 'def h(): return 1');

        const inline: TFile = { name, content: 'def h(): return 1' };
        const job = makeJob({ files: [inline], session_id: 'cur' });
        const internals = asInternals(job);
        internals.submissionDir = tmpDir;
        internals.entryPointName = 'main.py';
        internals.inputFileHashes.set(name, {
            hash: sha256('def h(): return 1'),
            path: full,
        });

        await internals.walkDir(tmpDir, 0, buildInputByName([inline]));

        expect(internals.generatedFiles).toHaveLength(1);
        expect(internals.generatedFiles[0].name).toBe(name);
        expect(internals.sessionFiles[0].storage_session_id).toBe('cur');
        expect(internals.sessionFiles[0].modified_from).toBeUndefined();
    });

    it('tags modified downloaded inputs with modified_from', async () => {
        const name = 'data.py';
        const full = path.join(tmpDir, name);
        await fsp.writeFile(full, 'new-content');

        const downloaded: TFile = {
            id: 'orig-id',
            storage_session_id: 'orig-session',
            name,
        };
        const job = makeJob({ session_id: 'cur' });
        const internals = asInternals(job);
        internals.submissionDir = tmpDir;
        internals.inputFileHashes.set(name, {
            hash: sha256('original'),
            path: full,
            originalId: 'orig-id',
            originalSessionId: 'orig-session',
        });

        await internals.walkDir(tmpDir, 0, buildInputByName([downloaded]));

        expect(internals.generatedFiles).toHaveLength(1);
        expect(internals.sessionFiles[0].modified_from).toEqual({
            id: 'orig-id',
            storage_session_id: 'orig-session',
        });
        /* Modified-input refresh emits a brand-new ref the caller owns; it must NOT
         * carry the `inherited` flag (callers should download it like any output). */
        expect(internals.sessionFiles[0].inherited).toBeUndefined();
        expect(internals.inheritedRefs).toHaveLength(0);
    });

    it('deduplicates a surfaced modified input when its original ref is re-sent', async () => {
        const name = 'data.csv';
        const original = 'original';
        const firstModification = 'first modification';
        const secondModification = 'second modification';
        const stableCacheKey = 'a'.repeat(64);
        const downloaded: TFile = {
            id: 'orig-id',
            storage_session_id: 'orig-session',
            input_cache_key: stableCacheKey,
            name,
        };
        const session = new SessionWorkspace({
            runtimeSessionId: 'rt_resent_ref',
        });
        session.markPrimed(name, stableCacheKey, false, sha256(original));
        session.markSurfaced(name, sha256(firstModification));
        await fsp.writeFile(path.join(tmpDir, name), firstModification);

        const reusedJob = makeJob({ session });
        const reused = asInternals(reusedJob);
        reused.submissionDir = tmpDir;
        expect(await reused.reusePrimedInput(downloaded)).toBe(true);
        await reused.walkDir(tmpDir, 0, buildInputByName([downloaded]));

        expect(reused.generatedFiles).toHaveLength(0);
        expect(reused.sessionFiles).toHaveLength(0);

        /* A later mutation no longer matches the surfaced signature and must be
         * emitted as a fresh modified-input output. */
        await fsp.writeFile(path.join(tmpDir, name), secondModification);
        const changedAgainJob = makeJob({ session });
        const changedAgain = asInternals(changedAgainJob);
        changedAgain.submissionDir = tmpDir;
        expect(await changedAgain.reusePrimedInput(downloaded)).toBe(true);
        await changedAgain.walkDir(tmpDir, 0, buildInputByName([downloaded]));

        expect(changedAgain.generatedFiles.map(file => file.name)).toEqual([
            name,
        ]);
        expect(changedAgain.sessionFiles[0].modified_from).toEqual({
            id: 'orig-id',
            storage_session_id: 'orig-session',
        });
    });

    it('surfaces a primed input changed back to bytes matching a prior output', async () => {
        const name = 'artifact.txt';
        const priorOutput = 'prior output bytes';
        const replacementInput = 'new input bytes';
        const session = new SessionWorkspace({
            runtimeSessionId: 'rt_replaced_output',
        });
        session.markSurfaced(name, sha256(priorOutput));

        /* A later request successfully replaces the old output with a new inline
         * session input at the same path. Priming must invalidate the old output
         * signature before this state can be checkpointed. */
        const primeJob = makeJob({ session });
        const primeInternals = asInternals(primeJob);
        primeInternals.submissionDir = tmpDir;
        await primeInternals.writeFile({ name, content: replacementInput });
        expect(session.isSurfaced(name, sha256(priorOutput))).toBe(false);

        /* On a subsequent turn, sandbox code changes the persisted input back to
         * the old output bytes. The primed baseline proves this is a modification,
         * so the stale signature must not suppress the refreshed artifact. */
        await fsp.writeFile(path.join(tmpDir, name), priorOutput);
        const nextJob = makeJob({ session });
        const nextInternals = asInternals(nextJob);
        nextInternals.submissionDir = tmpDir;
        await nextInternals.walkDir(tmpDir, 0, new Map());

        expect(nextInternals.generatedFiles.map(file => file.name)).toEqual([
            name,
        ]);
        expect(nextInternals.sessionFiles.map(file => file.name)).toEqual([
            name,
        ]);
        const refreshed = [...nextInternals.pendingSurfaced.values()];
        expect(refreshed).toEqual([
            {
                name,
                signature: sha256(priorOutput),
            },
        ]);

        /* Once that refreshed artifact uploads, normal output deduplication still
         * applies. This guards against fixing the stale lineage by globally
         * bypassing surfaced checks for every modified primed path. */
        session.markSurfaced(refreshed[0].name, refreshed[0].signature);
        const dedupJob = makeJob({ session });
        const dedupInternals = asInternals(dedupJob);
        dedupInternals.submissionDir = tmpDir;
        await dedupInternals.walkDir(tmpDir, 0, new Map());
        expect(dedupInternals.generatedFiles).toHaveLength(0);
        expect(dedupInternals.sessionFiles).toHaveLength(0);
    });

    it('filters out unsupported extensions', async () => {
        await fsp.writeFile(path.join(tmpDir, 'keep.py'), 'print(1)');
        await fsp.writeFile(path.join(tmpDir, 'skip.exe'), 'binary');

        const job = makeJob();
        const internals = asInternals(job);
        internals.submissionDir = tmpDir;

        await internals.walkDir(tmpDir, 0, new Map());

        const names = internals.generatedFiles.map(f => f.name);
        expect(names).toEqual(['keep.py']);
    });

    it('keeps supported extensionless output basenames', async () => {
        await fsp.writeFile(path.join(tmpDir, 'Dockerfile'), 'FROM scratch');
        await fsp.mkdir(path.join(tmpDir, 'ci'));
        await fsp.writeFile(
            path.join(tmpDir, 'ci', 'Jenkinsfile'),
            'pipeline {}',
        );
        await fsp.mkdir(path.join(tmpDir, 'infra'));
        await fsp.writeFile(
            path.join(tmpDir, 'infra', 'Vagrantfile'),
            'Vagrant.configure("2")',
        );

        const job = makeJob();
        const internals = asInternals(job);
        internals.submissionDir = tmpDir;

        await internals.walkDir(tmpDir, 0, new Map());

        const names = internals.generatedFiles.map(f => f.name).sort();
        expect(names).toEqual(
            [
                'Dockerfile',
                path.join('ci', 'Jenkinsfile'),
                path.join('infra', 'Vagrantfile'),
            ].sort(),
        );
    });

    it('filters files exceeding max_file_size', async () => {
        await fsp.writeFile(path.join(tmpDir, 'big.py'), 'x'.repeat(100));

        const job = makeJob({ maxFileSize: 50 });
        const internals = asInternals(job);
        internals.submissionDir = tmpDir;

        await internals.walkDir(tmpDir, 0, new Map());

        expect(internals.generatedFiles).toHaveLength(0);
    });

    it('drops only root-level trim.txt for go (nested trim.txt is a legitimate user output)', async () => {
        await fsp.writeFile(path.join(tmpDir, 'trim.txt'), 'go-artifact');
        await fsp.mkdir(path.join(tmpDir, 'reports'));
        await fsp.writeFile(
            path.join(tmpDir, 'reports', 'trim.txt'),
            'user-output',
        );

        const job = makeJob({ language: 'go' });
        const internals = asInternals(job);
        internals.submissionDir = tmpDir;

        await internals.walkDir(tmpDir, 0, new Map());

        const names = internals.generatedFiles.map(f => f.name).sort();
        expect(names).toEqual([path.join('reports', 'trim.txt')]);
    });
});

describe('walkDir / read-only inputs', () => {
    let tmpDir: string;

    beforeEach(async () => {
        tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'codeapi-walker-'));
    });
    afterEach(async () => {
        await fsp.rm(tmpDir, { recursive: true, force: true });
    });

    /**
     * The contract: when an input was uploaded with `read_only=true` (skill
     * files etc.), modifications by sandboxed code MUST NOT surface as a
     * generated artifact. The walker echoes the original ref via
     * inheritedRefs even when the file's hash differs from the baseline.
     */
    it('echoes a MODIFIED read-only input as inherited (no upload, no modified_from)', async () => {
        /* Use path.join so relativePath matches walkDir's path.relative output
         * on both POSIX (`pptx/SKILL.md`) and Windows (`pptx\SKILL.md`). */
        const name = path.join('pptx', 'SKILL.md');
        const full = path.join(tmpDir, name);
        await fsp.mkdir(path.dirname(full), { recursive: true });
        await fsp.writeFile(full, 'sandbox-mutated-bytes');

        const downloaded: TFile = {
            id: 'skill-id',
            storage_session_id: 'skill-session',
            name,
        };
        const job = makeJob({ session_id: 'cur' });
        const internals = asInternals(job);
        internals.submissionDir = tmpDir;
        internals.inputFileHashes.set(name, {
            hash: sha256('original-skill-bytes'),
            path: full,
            originalId: 'skill-id',
            originalSessionId: 'skill-session',
            readOnly: true,
        });

        await internals.walkDir(tmpDir, 0, buildInputByName([downloaded]));

        expect(internals.generatedFiles).toHaveLength(0);
        expect(internals.inheritedRefs).toHaveLength(1);
        expect(internals.inheritedRefs[0]).toEqual({
            id: 'skill-id',
            name,
            storage_session_id: 'skill-session',
            inherited: true,
        });
    });

    it('echoes an UNMODIFIED read-only input as inherited (same path as non-read-only unchanged)', async () => {
        const name = path.join('pptx', 'LICENSE.txt');
        const full = path.join(tmpDir, name);
        await fsp.mkdir(path.dirname(full), { recursive: true });
        const bytes = 'apache-2.0';
        await fsp.writeFile(full, bytes);

        const downloaded: TFile = {
            id: 'lic-id',
            storage_session_id: 'skill-session',
            name,
        };
        const job = makeJob({ session_id: 'cur' });
        const internals = asInternals(job);
        internals.submissionDir = tmpDir;
        internals.inputFileHashes.set(name, {
            hash: sha256(bytes),
            path: full,
            originalId: 'lic-id',
            originalSessionId: 'skill-session',
            readOnly: true,
        });

        await internals.walkDir(tmpDir, 0, buildInputByName([downloaded]));

        expect(internals.generatedFiles).toHaveLength(0);
        expect(internals.inheritedRefs).toHaveLength(1);
        expect(internals.inheritedRefs[0].id).toBe('lic-id');
        expect(internals.inheritedRefs[0].inherited).toBe(true);
    });

    it('non-read-only modified input still surfaces as a generated artifact (regression guard)', async () => {
        /* Sanity check: read_only is opt-in. Without the flag, modified
         * inputs continue to upload as generated outputs with `modified_from`
         * — that's the user-content edit path and must not be regressed. */
        const name = 'data.csv';
        const full = path.join(tmpDir, name);
        await fsp.writeFile(full, 'user-edited-bytes');

        const downloaded: TFile = {
            id: 'data-id',
            storage_session_id: 'prev',
            name,
        };
        const job = makeJob({ session_id: 'cur' });
        const internals = asInternals(job);
        internals.submissionDir = tmpDir;
        internals.inputFileHashes.set(name, {
            hash: sha256('original'),
            path: full,
            originalId: 'data-id',
            originalSessionId: 'prev',
            // readOnly intentionally absent
        });

        await internals.walkDir(tmpDir, 0, buildInputByName([downloaded]));

        expect(internals.generatedFiles).toHaveLength(1);
        expect(internals.inheritedRefs).toHaveLength(0);
        expect(internals.sessionFiles[0].modified_from).toEqual({
            id: 'data-id',
            storage_session_id: 'prev',
        });
    });
});

describe('walkDir / output caps', () => {
    it('respects max_output_files cap on generated files', async () => {
        const cap = config.max_output_files;
        for (let i = 0; i < cap + 5; i++) {
            await fsp.writeFile(path.join(tmpDir, `f${i}.py`), String(i));
        }

        const job = makeJob();
        const internals = asInternals(job);
        internals.submissionDir = tmpDir;

        await internals.walkDir(tmpDir, 0, new Map());

        expect(internals.generatedFiles.length).toBeLessThanOrEqual(cap);
    });

    it('respects max_output_files cap on inherited refs', async () => {
        const cap = config.max_output_files;
        const inputs: TFile[] = [];
        for (let i = 0; i < cap + 5; i++) {
            const name = `inh${i}.py`;
            const full = path.join(tmpDir, name);
            await fsp.writeFile(full, `content-${i}`);
            inputs.push({ id: `id-${i}`, storage_session_id: 'prev', name });
        }

        const job = makeJob();
        const internals = asInternals(job);
        internals.submissionDir = tmpDir;
        for (const f of inputs) {
            internals.inputFileHashes.set(f.name, {
                hash: sha256(`content-${f.name.slice(3, -3)}`),
                path: path.join(tmpDir, f.name),
                originalId: f.id,
                originalSessionId: f.storage_session_id,
            });
        }

        await internals.walkDir(tmpDir, 0, buildInputByName(inputs));

        expect(internals.inheritedRefs.length).toBeLessThanOrEqual(cap);
        expect(internals.generatedFiles).toHaveLength(0);
    });
});

describe('walkDir / depth cap', () => {
    it('stops recursing at max_nesting_depth', async () => {
        let cursor = tmpDir;
        const depthToCreate = config.max_nesting_depth + 2;
        for (let i = 0; i < depthToCreate; i++) {
            cursor = path.join(cursor, `d${i}`);
            await fsp.mkdir(cursor);
        }
        await fsp.writeFile(path.join(cursor, 'deep.py'), '1');

        const job = makeJob();
        const internals = asInternals(job);
        internals.submissionDir = tmpDir;

        await internals.walkDir(tmpDir, 0, new Map());

        const deepName = path.relative(tmpDir, path.join(cursor, 'deep.py'));
        expect(internals.generatedFiles.map(f => f.name)).not.toContain(
            deepName,
        );
    });
});

describe('handleSessionFiles / priority-fill composition', () => {
    it('fills sessionFiles with generated files first, then back-fills with inherited refs up to cap', async () => {
        const cap = config.max_output_files;
        /* Mix: (cap - 2) fresh generated outputs + 5 inherited refs. Total
         * (cap + 3) candidates must be capped at `cap` with generated first. */
        const generatedCount = Math.max(1, cap - 2);
        const inheritedCount = 5;

        await fsp.mkdir(path.join(tmpDir, 'gen'));
        for (let i = 0; i < generatedCount; i++) {
            await fsp.writeFile(
                path.join(tmpDir, 'gen', `new${i}.py`),
                `new-${i}`,
            );
        }
        await fsp.mkdir(path.join(tmpDir, 'inh'));
        const inherited: TFile[] = [];
        for (let i = 0; i < inheritedCount; i++) {
            const name = path.join('inh', `prev${i}.py`);
            const full = path.join(tmpDir, name);
            await fsp.writeFile(full, `prev-${i}`);
            inherited.push({
                id: `prev-id-${i}`,
                storage_session_id: 'prev-session',
                name,
            });
        }

        const job = makeJob({ files: inherited, session_id: 'cur' });
        const internals = asInternals(job);
        internals.submissionDir = tmpDir;
        internals.files = inherited;
        for (const f of inherited) {
            internals.inputFileHashes.set(f.name, {
                hash: sha256(`prev-${f.name.match(/prev(\d+)/)![1]}`),
                path: path.join(tmpDir, f.name),
                originalId: f.id,
                originalSessionId: f.storage_session_id,
            });
        }

        await internals.handleSessionFiles();

        expect(internals.sessionFiles.length).toBeLessThanOrEqual(cap);
        /* Generated files are emitted into sessionFiles during walkDir; inherited
         * refs are held separately and back-filled afterward. The resulting array
         * must have all generated entries appearing before any inherited ref. */
        const generatedIds = new Set(internals.generatedFiles.map(g => g.id));
        let sawInherited = false;
        for (const entry of internals.sessionFiles) {
            if (generatedIds.has(entry.id)) {
                expect(sawInherited).toBe(false);
            } else {
                sawInherited = true;
            }
        }
        expect(
            internals.sessionFiles.filter(f => generatedIds.has(f.id)).length,
        ).toBe(generatedCount);
    });

    it('drops inherited refs that would exceed the combined cap', async () => {
        const cap = config.max_output_files;
        /* Exactly `cap` generated files leaves zero slots for inherited refs. */
        await fsp.mkdir(path.join(tmpDir, 'gen'));
        for (let i = 0; i < cap; i++) {
            await fsp.writeFile(
                path.join(tmpDir, 'gen', `new${i}.py`),
                `new-${i}`,
            );
        }
        await fsp.mkdir(path.join(tmpDir, 'inh'));
        const inheritedName = path.join('inh', 'prev.py');
        const inheritedFull = path.join(tmpDir, inheritedName);
        await fsp.writeFile(inheritedFull, 'prev');
        const inherited: TFile[] = [
            {
                id: 'prev-id',
                storage_session_id: 'prev-session',
                name: inheritedName,
            },
        ];

        const job = makeJob({ files: inherited, session_id: 'cur' });
        const internals = asInternals(job);
        internals.submissionDir = tmpDir;
        internals.files = inherited;
        internals.inputFileHashes.set(inheritedName, {
            hash: sha256('prev'),
            path: inheritedFull,
            originalId: 'prev-id',
            originalSessionId: 'prev-session',
        });

        await internals.handleSessionFiles();

        expect(internals.sessionFiles.length).toBe(cap);
        const inheritedIds = new Set(internals.inheritedRefs.map(r => r.id));
        const leakedInherited = internals.sessionFiles.filter(f =>
            inheritedIds.has(f.id),
        );
        expect(leakedInherited).toHaveLength(0);
    });
});

describe('walkDir / dirent classification', () => {
    it('ignores symlinks (never classifies them as file or dir)', async () => {
        await fsp.writeFile(path.join(tmpDir, 'real.py'), 'print(1)');
        await fsp.symlink(
            path.join(tmpDir, 'real.py'),
            path.join(tmpDir, 'link.py'),
        );

        const job = makeJob();
        const internals = asInternals(job);
        internals.submissionDir = tmpDir;

        await internals.walkDir(tmpDir, 0, new Map());

        const names = internals.generatedFiles.map(f => f.name);
        expect(names).toContain('real.py');
        expect(names).not.toContain('link.py');
    });
});

describe('createDirkeepMarker / symlink safety', () => {
    it('tracks a successfully uploaded synthetic marker across session turns', async () => {
        await fsp.mkdir(path.join(tmpDir, 'empty'));
        const keepRel = path.join('empty', DIRKEEP);
        const session = new SessionWorkspace({
            runtimeSessionId: 'rt_dirkeep',
        });

        const first = asInternals(makeJob({ session }));
        first.submissionDir = tmpDir;
        await first.walkDir(tmpDir, 0, new Map());

        const marker = first.generatedFiles.find(file => file.name === keepRel);
        expect(marker).toBeDefined();
        const pending = first.pendingSurfaced.get(marker!.id);
        expect(pending).toEqual({ name: keepRel, signature: sha256('') });

        /* uploadGeneratedFiles commits this exact pending entry only after the
         * object PUT succeeds. Model that successful commit, then scan the same
         * persistent workspace on the next turn. */
        session.markSurfaced(pending!.name, pending!.signature);
        const second = asInternals(makeJob({ session }));
        second.submissionDir = tmpDir;
        await second.walkDir(tmpDir, 0, new Map());

        expect(second.generatedFiles.some(file => file.name === keepRel)).toBe(
            false,
        );
        expect(second.sessionFiles.some(file => file.name === keepRel)).toBe(
            false,
        );
    });

    it('refuses to write a .dirkeep marker through an existing symlink', async () => {
        /* Simulate a malicious sandbox that plants a .dirkeep symlink pointing
         * to a sensitive file outside the empty directory. The marker write
         * must fail (O_EXCL) rather than clobbering the link target. */
        await fsp.mkdir(path.join(tmpDir, 'victim'));
        const outsideTarget = path.join(tmpDir, 'victim', 'secret.txt');
        await fsp.writeFile(outsideTarget, 'do-not-overwrite');

        await fsp.mkdir(path.join(tmpDir, 'empty'));
        const keepRel = path.join('empty', DIRKEEP);
        await fsp.symlink(outsideTarget, path.join(tmpDir, keepRel));

        const job = makeJob();
        const internals = asInternals(job);
        internals.submissionDir = tmpDir;

        await internals.walkDir(tmpDir, 0, new Map());

        const untouched = await fsp.readFile(outsideTarget, 'utf8');
        expect(untouched).toBe('do-not-overwrite');
        const markerNames = internals.generatedFiles
            .filter(f => f.name === keepRel)
            .map(f => f.name);
        expect(markerNames).toHaveLength(0);
    });
});

describe('handleInlineUserDirkeep / ENOENT recovery', () => {
    it('synthesizes a fresh marker when the user inline .dirkeep was deleted during execution', async () => {
        await fsp.mkdir(path.join(tmpDir, 'dir'));
        const keepRel = path.join('dir', DIRKEEP);
        const keepFull = path.join(tmpDir, keepRel);

        /* User submitted inline .dirkeep with content, but the sandboxed run
         * deleted it. inputFileHashes still has the original hash entry, but
         * the file is gone from disk. */
        const userKeep: TFile = { name: keepRel, content: 'original' };
        const job = makeJob();
        const internals = asInternals(job);
        internals.submissionDir = tmpDir;
        internals.inputFileHashes.set(keepRel, {
            hash: sha256('original'),
            path: keepFull,
        });

        await internals.walkDir(tmpDir, 0, buildInputByName([userKeep]));

        /* Directory should still appear in outputs via a freshly created marker. */
        const marker = internals.generatedFiles.find(f => f.name === keepRel);
        expect(marker).toBeDefined();
        const onDisk = await fsp.readFile(keepFull, 'utf8');
        expect(onDisk).toBe('');
    });
});

describe('isOutputCapFull / early termination when generated files hit cap', () => {
    interface CapProbe {
        isOutputCapFull: () => boolean;
    }
    const asProbe = (job: Job): CapProbe => job as unknown as CapProbe;

    it('returns true as soon as generatedFiles reaches the cap, regardless of inheritedRefs', () => {
        const cap = config.max_output_files;
        const job = makeJob();
        const internals = asInternals(job);

        for (let i = 0; i < cap; i++) {
            internals.generatedFiles.push({
                id: `g${i}`,
                name: `f${i}.py`,
                path: `/tmp/f${i}.py`,
            });
        }
        /* inheritedRefs is intentionally empty — the old implementation only
         * short-circuited when BOTH lists were full, so this specifically
         * guards against that regression. */
        expect(asProbe(job).isOutputCapFull()).toBe(true);
    });

    it('returns false when only inheritedRefs reaches cap — generated files still take priority on back-fill', () => {
        const cap = config.max_output_files;
        const job = makeJob();
        const internals = asInternals(job);

        for (let i = 0; i < cap; i++) {
            internals.inheritedRefs.push({
                id: `i${i}`,
                name: `f${i}.py`,
                storage_session_id: 'prev',
            });
        }
        /* Stopping walk here would silently drop later-visited generated files;
         * per-push guards already bound inheritedRefs memory. */
        expect(asProbe(job).isOutputCapFull()).toBe(false);
    });

    it('returns false when both lists are under their caps', () => {
        const job = makeJob();
        const internals = asInternals(job);
        internals.generatedFiles.push({
            id: 'g',
            name: 'g.py',
            path: '/tmp/g.py',
        });
        internals.inheritedRefs.push({
            id: 'i',
            name: 'i.py',
            storage_session_id: 'prev',
        });
        expect(asProbe(job).isOutputCapFull()).toBe(false);
    });
});

describe('walkDir / hidden-directory filter', () => {
    it('skips runtime-cache hidden directories like matplotlib .cache and .config', async () => {
        /* Recreates the matplotlib pollution shape: user wrote a real artifact at
         * /mnt/data/plot.png, but the runtime also dropped a font cache at
         * .cache/matplotlib/fontlist-v390.json and a .config/matplotlib/.dirkeep.
         * walkDir must surface plot.png and ignore the dotdir tree entirely. */
        await fsp.writeFile(path.join(tmpDir, 'plot.png'), 'real-image-bytes');
        await fsp.mkdir(path.join(tmpDir, '.cache', 'matplotlib'), {
            recursive: true,
        });
        await fsp.writeFile(
            path.join(tmpDir, '.cache', 'matplotlib', 'fontlist-v390.json'),
            '{"fonts":[]}',
        );
        await fsp.mkdir(path.join(tmpDir, '.config', 'matplotlib'), {
            recursive: true,
        });
        await fsp.writeFile(
            path.join(tmpDir, '.config', 'matplotlib', DIRKEEP),
            '',
        );

        const job = makeJob();
        const internals = asInternals(job);
        internals.submissionDir = tmpDir;

        await internals.walkDir(tmpDir, 0, new Map());

        const names = internals.generatedFiles.map(f => f.name);
        expect(names).toContain('plot.png');
        expect(names.some(n => n.startsWith('.cache'))).toBe(false);
        expect(names.some(n => n.startsWith('.config'))).toBe(false);
    });

    it('still walks a hidden directory when the user explicitly primed an input under it', async () => {
        /* Escape hatch: a user who actually asked for `.config/foo.txt` to be
         * inherited shouldn't have it silently dropped. Presence in inputByName
         * (whether as the dir itself or any file under it) opts the dir back in. */
        await fsp.mkdir(path.join(tmpDir, '.config'), { recursive: true });
        const inputRel = path.join('.config', 'foo.txt');
        const inputFull = path.join(tmpDir, inputRel);
        await fsp.writeFile(inputFull, 'hello');

        const inputFile: TFile = {
            id: 'i1',
            storage_session_id: 'prev',
            name: inputRel,
        };
        const job = makeJob();
        const internals = asInternals(job);
        internals.submissionDir = tmpDir;
        internals.inputFileHashes.set(inputRel, {
            hash: sha256('hello'),
            path: inputFull,
            originalId: 'i1',
            originalSessionId: 'prev',
        });

        await internals.walkDir(tmpDir, 0, buildInputByName([inputFile]));

        /* Unchanged inherited input becomes an inheritedRef rather than a fresh
         * generated upload — the same guarantee non-hidden inherited files get. */
        expect(internals.inheritedRefs.map(r => r.name)).toContain(inputRel);
    });

    it('passes through real artifacts at root even when a hidden dir is also present', async () => {
        /* The filter is dir-only: real user artifacts like `data.csv` keep flowing
         * into generatedFiles even when sibling `.cache/` etc. exist. */
        await fsp.writeFile(path.join(tmpDir, 'data.csv'), 'a,b\n1,2');
        await fsp.mkdir(path.join(tmpDir, '.cache'), { recursive: true });
        await fsp.writeFile(path.join(tmpDir, '.cache', 'noise.txt'), 'noise');

        const job = makeJob();
        const internals = asInternals(job);
        internals.submissionDir = tmpDir;

        await internals.walkDir(tmpDir, 0, new Map());

        const names = internals.generatedFiles.map(f => f.name);
        expect(names).toContain('data.csv');
        expect(names.some(n => n.includes('noise.txt'))).toBe(false);
    });

    it('emits a .dirkeep marker for a directory whose ONLY contents are filtered hidden dirs', async () => {
        /* Regression for a subtle bug: a user-created directory like
         * `<tmpDir>/proj/` whose only entry is a runtime-cache `.cache/` was
         * being treated as `'skipped'` (because `.cache` was counted in
         * `nonDirkeepCount` before the filter), so `walkSubdirectory` never
         * called `handleEmptyDirectory` and `proj/` had no .dirkeep marker.
         * Result: the directory silently disappeared on the next prime() even
         * though the user intentionally created it.
         *
         * Fix: subtract filtered hidden dirs from the empty-detection tally
         * so `proj/` gets a `.dirkeep` and the directory survives. */
        await fsp.mkdir(path.join(tmpDir, 'proj', '.cache'), {
            recursive: true,
        });
        await fsp.writeFile(
            path.join(tmpDir, 'proj', '.cache', 'fontcache.json'),
            '{}',
        );

        const job = makeJob();
        const internals = asInternals(job);
        internals.submissionDir = tmpDir;

        await internals.walkDir(tmpDir, 0, new Map());

        const names = internals.generatedFiles.map(f => f.name);
        /* proj/.dirkeep should have been emitted so the empty-from-the-user's-
         * perspective `proj/` directory survives the next continuation. */
        expect(names).toContain(path.join('proj', DIRKEEP));
        /* The filtered .cache contents should still be excluded. */
        expect(names.some(n => n.includes('.cache'))).toBe(false);
        /* And the marker should physically exist on disk for the upload step. */
        await fsp.access(path.join(tmpDir, 'proj', DIRKEEP));
    });
});
