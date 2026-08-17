import { afterEach, describe, expect, test } from 'bun:test';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { config } from './config';
import {
    SessionWorkspace,
    bindSessionWorkspace,
    getBoundSessionWorkspace,
    parseSessionBinding,
    parseSessionBindingFromHeader,
    resetSessionWorkspaceStateForTests,
    unbindSessionWorkspace,
} from './session-workspace';

const savedEnabled = config.session_workspace_enabled;

afterEach(async () => {
    config.session_workspace_enabled = savedEnabled;
    await unbindSessionWorkspace().catch(() => {});
    resetSessionWorkspaceStateForTests();
});

describe('parseSessionBinding (gating)', () => {
    test('returns undefined when the image-level flag is off, regardless of payload', () => {
        config.session_workspace_enabled = false;
        expect(
            parseSessionBinding(
                JSON.stringify({
                    runtime_session_id: 'rt_1',
                    session_workspace: true,
                }),
            ),
        ).toBeUndefined();
    });

    test('binds only when enabled AND the payload opts in with a runtime_session_id', () => {
        config.session_workspace_enabled = true;
        expect(
            parseSessionBinding(
                JSON.stringify({
                    runtime_session_id: 'rt_1',
                    session_workspace: true,
                }),
            ),
        ).toEqual({ runtimeSessionId: 'rt_1' });
    });

    test('rejects payloads missing the opt-in flag or the session id', () => {
        config.session_workspace_enabled = true;
        expect(
            parseSessionBinding(JSON.stringify({ runtimeSessionId: 'rt_1' })),
        ).toBeUndefined();
        expect(
            parseSessionBinding(JSON.stringify({ session_workspace: true })),
        ).toBeUndefined();
        expect(
            parseSessionBinding(
                JSON.stringify({
                    session_workspace: true,
                    runtime_session_id: '',
                }),
            ),
        ).toBeUndefined();
    });
});

describe('parseSessionBindingFromHeader (per-request opt-in)', () => {
    test('returns undefined when the image-level flag is off', () => {
        config.session_workspace_enabled = false;
        expect(parseSessionBindingFromHeader('rt_abc123')).toBeUndefined();
    });

    test('binds a well-formed id when enabled (presence of the header is the opt-in)', () => {
        config.session_workspace_enabled = true;
        expect(parseSessionBindingFromHeader('rt_abc123')).toEqual({
            runtimeSessionId: 'rt_abc123',
        });
        expect(parseSessionBindingFromHeader('  rt_abc123  ')).toEqual({
            runtimeSessionId: 'rt_abc123',
        });
    });

    test('rejects missing, empty, repeated, or malformed headers', () => {
        config.session_workspace_enabled = true;
        expect(parseSessionBindingFromHeader(undefined)).toBeUndefined();
        expect(() => parseSessionBindingFromHeader('')).toThrow('malformed');
        expect(() => parseSessionBindingFromHeader(['rt_a', 'rt_b'])).toThrow(
            'exactly once',
        );
        expect(() => parseSessionBindingFromHeader('rt bad space')).toThrow(
            'malformed',
        );
        expect(() => parseSessionBindingFromHeader('a'.repeat(129))).toThrow(
            'malformed',
        );
    });

    test('tolerates absent and non-JSON payloads', () => {
        config.session_workspace_enabled = true;
        expect(parseSessionBinding(undefined)).toBeUndefined();
        expect(parseSessionBinding('')).toBeUndefined();
        expect(parseSessionBinding('not json')).toBeUndefined();
    });
});

describe('bindSessionWorkspace lifecycle', () => {
    test('binding is idempotent for the same runtime session and returns the same instance', () => {
        const a = bindSessionWorkspace({ runtimeSessionId: 'rt_1' });
        const b = bindSessionWorkspace({ runtimeSessionId: 'rt_1' });
        expect(a).toBe(b);
        expect(getBoundSessionWorkspace()).toBe(a);
    });

    /* One runner serves exactly one session for its lifetime: honoring a second
     * id would race the previous session's async wipe against the new session's
     * restore over the same directory. The bind must fail closed instead. */
    test('a different runtime session is rejected, never rebound', () => {
        const a = bindSessionWorkspace({ runtimeSessionId: 'rt_1' });
        const b = bindSessionWorkspace({ runtimeSessionId: 'rt_2' });
        expect(b).toBeUndefined();
        expect(getBoundSessionWorkspace()).toBe(a);
        expect(getBoundSessionWorkspace()?.runtimeSessionId).toBe('rt_1');
    });

    test('unbind clears the bound session', async () => {
        bindSessionWorkspace({ runtimeSessionId: 'rt_1' });
        await unbindSessionWorkspace();
        expect(getBoundSessionWorkspace()).toBeUndefined();
    });
});

describe('SessionWorkspace state', () => {
    test('surfaced and primed tracking, cleared on reset', async () => {
        const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sw-state-'));
        const savedPerJob = config.per_job_uids;
        config.per_job_uids = false;
        try {
            const ws = new SessionWorkspace({ runtimeSessionId: 'rt_1' });

            expect(ws.isSurfaced('out.csv', '10:100')).toBe(false);
            ws.markSurfaced('out.csv', '10:100');
            expect(ws.isSurfaced('out.csv', '10:100')).toBe(true);
            expect(ws.isSurfaced('out.csv', '11:200')).toBe(false);

            expect(ws.primedInputId('in.csv')).toBeUndefined();
            expect(ws.isPrimedInput('in.csv')).toBe(false);
            ws.markPrimed('in.csv', 'file_abc');
            expect(ws.primedInputId('in.csv')).toBe('file_abc');

            /* read-only primes report as not-primed so the caller re-downloads them
             * (a reused on-disk copy could have been tampered via the writable dir). */
            ws.markPrimed('skill.py', 'file_ro', true);
            expect(ws.primedInputId('skill.py')).toBeUndefined();
            /* ...but both still count as primed inputs, so a later turn that omits
             * them doesn't re-surface them as generated outputs. */
            expect(ws.isPrimedInput('in.csv')).toBe(true);
            expect(ws.isPrimedInput('skill.py')).toBe(true);
            expect(ws.isPrimedInput('never-primed.csv')).toBe(false);
            /* read-only primes are always suppressed (modifications dropped by
             * contract); writable ones are only suppressed while unchanged. */
            expect(ws.isPrimedReadOnly('skill.py')).toBe(true);
            expect(ws.isPrimedReadOnly('in.csv')).toBe(false);

            await ws.reset();
            expect(ws.isSurfaced('out.csv', '10:100')).toBe(false);
            expect(ws.primedInputId('in.csv')).toBeUndefined();
        } finally {
            config.per_job_uids = savedPerJob;
            await fsp.rm(root, { recursive: true, force: true });
        }
    });

    test('snapshotMeta/loadMeta round-trips priming + output-diff state into a fresh workspace', () => {
        const source = new SessionWorkspace({ runtimeSessionId: 'rt_1' });
        source.markSurfaced('out.csv', '10:100');
        source.markPrimed('in.csv', 'file_abc', false, 'ORIGHASH');
        source.markPrimed('skill.py', 'file_ro', true);

        /* A relaunched VM starts with an empty workspace and loads the checkpoint's
         * sidecar — without this it would re-download every input, overwriting a
         * restored in-place-modified file with the original. */
        const relaunched = new SessionWorkspace({ runtimeSessionId: 'rt_1' });
        relaunched.loadMeta(source.snapshotMeta());

        expect(relaunched.primedInputId('in.csv')).toBe('file_abc');
        expect(relaunched.isSurfaced('out.csv', '10:100')).toBe(true);
        /* the original upload hash survives so reuse baselines against it, not a
         * re-hash of a possibly-mutated on-disk copy */
        expect(relaunched.primedHash('in.csv')).toBe('ORIGHASH');
        /* read-only flag survives the round-trip, so it still re-downloads */
        expect(relaunched.primedInputId('skill.py')).toBeUndefined();
    });

    test("priming a path invalidates only that path's prior surfaced signature", () => {
        const workspace = new SessionWorkspace({
            runtimeSessionId: 'rt_reprime',
        });
        workspace.markSurfaced('artifact.txt', 'old-output-hash');
        workspace.markSurfaced('untouched.txt', 'unrelated-output-hash');

        workspace.markPrimed(
            'artifact.txt',
            'new-input-id',
            false,
            'new-input-hash',
        );

        expect(workspace.isSurfaced('artifact.txt', 'old-output-hash')).toBe(
            false,
        );
        expect(
            workspace.isSurfaced('untouched.txt', 'unrelated-output-hash'),
        ).toBe(true);
        expect(workspace.snapshotMeta()).toEqual({
            primed: [
                [
                    'artifact.txt',
                    {
                        id: 'new-input-id',
                        readOnly: false,
                        hash: 'new-input-hash',
                    },
                ],
            ],
            surfaced: [['untouched.txt', 'unrelated-output-hash']],
        });
    });

    test('a partial prime stays fail-closed until a successful restore loads metadata', () => {
        const workspace = new SessionWorkspace({
            runtimeSessionId: 'rt_dirty',
        });
        workspace.markDirty('partial input prime');
        expect(workspace.dirtyReason).toBe('partial input prime');

        workspace.loadMeta({ primed: [], surfaced: [] });
        expect(workspace.dirtyReason).toBeUndefined();
    });
});
