/* eslint-disable no-console */
/**
 * Direct unit tests for `service/replay-state.ts`. Exercises the replay
 * Redis state machine against an in-memory `ioredis-mock` so error
 * branches, lock contention, idempotent retries, and atomicity guarantees
 * can be validated without spinning up Redis or BullMQ.
 *
 * Each test case acquires a fresh mock connection so keyspaces don't bleed
 * across tests. The module under test exposes `setRedisForTests` /
 * `resetRedisForTests` precisely for this purpose.
 *
 * CAVEAT — `ioredis-mock` Lua fidelity:
 *   The mock implements `defineCommand`/`EVAL`/`EVALSHA` and routes Lua
 *   scripts through its own Lua runner (not real Redis), so semantics for
 *   `redis.call`, return-value coercion, and error propagation are a
 *   *subset* of production Redis. Subtle divergences won't surface here.
 *   The integration suite under `service/integration-tests/` runs against
 *   a real Redis container and is the source of truth for Lua behaviour;
 *   these unit tests cover branch coverage and contract shape only.
 *
 * Run with: bun run scripts/test-replay-state.ts
 */
import IORedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';
import {
    type ExecutionState,
    ExecutionStateTooLargeError,
    EXECUTION_STATE_TTL,
    MAX_EXECUTION_STATE_BYTES,
    MAX_REPLAY_CALLS,
    MAX_TOOL_HISTORY_TOTAL_BYTES,
    MAX_TOOL_RESULT_BYTES,
    acquireExecutionLock,
    checkContinuationPreconditions,
    releaseExecutionLock,
    setExecutionState,
    getExecutionState,
    deleteExecutionState,
    setBlockingResult,
    getBlockingResult,
    deleteBlockingResult,
    setExecutionResult,
    setExecutionError,
    computeToolHistoryDelta,
    commitToolHistoryAndState,
    loadToolHistory,
    refreshExecutionTtl,
    scanKeys,
    cleanupExecution,
    cleanupStaleExecutions,
    validateContinuationBatch,
    validateToolResult,
    setRedisForTests,
    resetRedisForTests,
    historyKey,
} from '../src/service/replay-state';
import { hashToolInput } from '../src/tool-input-signature';

let passed = 0;
let failed = 0;

function assert(cond: boolean, label: string): void {
    if (cond) {
        passed++;
        console.log(`  ok  - ${label}`);
    } else {
        failed++;
        console.error(`  FAIL - ${label}`);
    }
}

function makeRedis(): Redis {
    return new (IORedisMock as unknown as new () => Redis)();
}

function makeState(overrides: Partial<ExecutionState> = {}): ExecutionState {
    const now = Date.now();
    return {
        execution_id:
            overrides.execution_id ??
            `exec_${Math.random().toString(36).slice(2, 10)}`,
        session_id:
            overrides.session_id ??
            `sess_${Math.random().toString(36).slice(2, 10)}`,
        sessionKey: overrides.sessionKey,
        userId: overrides.userId ?? 'user_test',
        tenantId: overrides.tenantId,
        canonicalUserId: overrides.canonicalUserId,
        orgId: overrides.orgId,
        serviceId: overrides.serviceId,
        externalUserId: overrides.externalUserId,
        principalSource: overrides.principalSource,
        authContextHash: overrides.authContextHash,
        apiKeyId: overrides.apiKeyId ?? 'key_test',
        startTime: overrides.startTime ?? now,
        lastActivity: overrides.lastActivity ?? now,
        mode: overrides.mode ?? 'replay',
        callCount: overrides.callCount ?? 0,
        historyBytes: overrides.historyBytes ?? 0,
        emittedCallIds: overrides.emittedCallIds,
        emittedToolCalls: overrides.emittedToolCalls,
        userCode: overrides.userCode,
        tools: overrides.tools,
        files: overrides.files,
        isPyPlot: overrides.isPyPlot,
        timeout: overrides.timeout,
        language: overrides.language,
        jobCompleted: overrides.jobCompleted,
        jobResult: overrides.jobResult,
        jobError: overrides.jobError,
    };
}

async function withRedis(fn: (r: Redis) => Promise<void>): Promise<void> {
    const r = makeRedis();
    /** ioredis-mock shares a global in-memory keyspace across instances by
     * default, which would let earlier test cases bleed garbage keys into
     * `scanKeys`/`cleanupStaleExecutions` assertions. Wipe it before every
     * test so each run sees a fresh keyspace. */
    await r.flushall();
    setRedisForTests(r);
    try {
        await fn(r);
    } finally {
        resetRedisForTests();
        await r.flushall().catch(() => {});
        await r.quit().catch(() => {});
    }
}

// ---------------------------------------------------------------------------
// validateToolResult (pure)
// ---------------------------------------------------------------------------

console.log('validateToolResult:');
{
    const ok = validateToolResult({ call_id: 'call_001', result: { x: 1 } });
    assert(
        'call_id' in ok && (ok as { call_id: string }).call_id === 'call_001',
        'minimal valid entry passes',
    );
}
{
    const r = validateToolResult(null);
    assert('error' in r, 'null rejected');
}
{
    const r = validateToolResult([]);
    assert('error' in r, 'array rejected');
}
{
    const r = validateToolResult({ call_id: 'wrong', result: 1 });
    assert(
        'error' in r && r.error.includes('call_id must match'),
        'bad call_id format rejected',
    );
}
{
    const r = validateToolResult({ call_id: 'call_001' });
    assert(
        'error' in r && r.error.includes('result is required'),
        'missing result rejected',
    );
}
{
    const r = validateToolResult({
        call_id: 'call_001',
        result: 1,
        is_error: 'no',
    });
    assert(
        'error' in r && r.error.includes('is_error must be a boolean'),
        'wrong is_error type rejected',
    );
}
{
    const r = validateToolResult({
        call_id: 'call_001',
        result: 1,
        error_message: 42,
    });
    assert(
        'error' in r && r.error.includes('error_message must be a string'),
        'wrong error_message type rejected',
    );
}
{
    const big = 'x'.repeat(MAX_TOOL_RESULT_BYTES + 100);
    const r = validateToolResult({ call_id: 'call_001', result: big });
    assert(
        'error' in r && r.error.includes('exceeds per-result cap'),
        `oversize result rejected (${MAX_TOOL_RESULT_BYTES} byte cap)`,
    );
}

// ---------------------------------------------------------------------------
// ExecutionState CRUD + size cap
// ---------------------------------------------------------------------------

console.log('\nExecutionState CRUD:');
await withRedis(async r => {
    const state = makeState();
    await setExecutionState(state);
    const loaded = await getExecutionState(state.execution_id);
    assert(loaded?.execution_id === state.execution_id, 'set/get round-trip');
    const ttl = await r.ttl(`exec_state:${state.execution_id}`);
    assert(ttl > 0 && ttl <= EXECUTION_STATE_TTL, 'TTL set on initial write');

    await deleteExecutionState(state.execution_id);
    const gone = await getExecutionState(state.execution_id);
    assert(gone === null, 'delete removes the key');
});

await withRedis(async () => {
    const huge = 'x'.repeat(MAX_EXECUTION_STATE_BYTES + 1000);
    const state = makeState({ userCode: huge });
    let threw = false;
    let isTyped = false;
    let bytes = 0;
    try {
        await setExecutionState(state);
    } catch (err) {
        threw = true;
        isTyped = err instanceof ExecutionStateTooLargeError;
        if (isTyped) bytes = (err as ExecutionStateTooLargeError).bytes;
    }
    assert(threw, 'oversize state throws');
    assert(
        isTyped,
        'thrown value is ExecutionStateTooLargeError (not a generic Error)',
    );
    assert(
        bytes > MAX_EXECUTION_STATE_BYTES,
        'error carries actual byte count',
    );
});

// ---------------------------------------------------------------------------
// Lock contention
// ---------------------------------------------------------------------------

console.log('\nacquire/releaseExecutionLock:');
await withRedis(async () => {
    const id = 'exec_lock_test';
    const t1 = await acquireExecutionLock(id);
    assert(
        typeof t1 === 'string' && t1.length > 0,
        'first acquirer gets a token',
    );
    const t2 = await acquireExecutionLock(id);
    assert(t2 === null, 'second acquirer is rejected while held');
    await releaseExecutionLock(id, t1!);
    const t3 = await acquireExecutionLock(id);
    assert(typeof t3 === 'string', 'lock can be re-acquired after release');

    /** Releasing with the wrong token must NOT delete the lock —
     * the script-eval CAS in releaseExecutionLock is what protects
     * a previous holder from clobbering the current one after its
     * lock expired. */
    await releaseExecutionLock(id, 'not-the-real-token');
    const t4 = await acquireExecutionLock(id);
    assert(t4 === null, 'wrong-token release does not free the lock');
    await releaseExecutionLock(id, t3!);
});

// ---------------------------------------------------------------------------
// computeToolHistoryDelta: empty + new + per-entry cap + immutability
// ---------------------------------------------------------------------------

console.log('\ncomputeToolHistoryDelta:');
await withRedis(async () => {
    const id = 'exec_delta_empty';
    const d = await computeToolHistoryDelta(id, []);
    assert(
        !('error' in d) && d.newCallIds.length === 0 && d.bytesDelta === 0,
        'empty results yields zero delta',
    );
});

await withRedis(async () => {
    const id = 'exec_delta_new';
    const d = await computeToolHistoryDelta(id, [
        {
            call_id: 'call_001',
            result: { x: 1 },
            tool_name: 'get_weather',
            input_hash: hashToolInput({ city: 'Paris' }),
            call_site: '101',
        },
        { call_id: 'call_002', result: { y: 2 }, is_error: false },
    ]);
    if ('error' in d) {
        assert(false, `unexpected error: ${d.error}`);
        return;
    }
    assert(d.newCallIds.length === 2, 'two new call_ids reported');
    assert(d.bytesDelta > 0, 'positive bytesDelta for new entries');
    assert(
        d.serializedByCallId.size === 2,
        'serialized payloads computed for new entries',
    );
    const entry = JSON.parse(d.serializedByCallId.get('call_001') ?? '{}') as {
        tool_name?: string;
        input_hash?: string;
        call_site?: string;
    };
    assert(
        entry.tool_name === 'get_weather',
        'tool metadata: name persisted in history entry',
    );
    assert(
        entry.input_hash === hashToolInput({ city: 'Paris' }),
        'tool metadata: input hash persisted in history entry',
    );
    assert(
        !('input' in entry),
        'tool metadata: raw input is not persisted in history entry',
    );
    assert(
        entry.call_site === '101',
        'tool metadata: call_site persisted in history entry',
    );
});

await withRedis(async () => {
    const id = 'exec_delta_oversize';
    const big = 'x'.repeat(MAX_TOOL_RESULT_BYTES + 1000);
    const d = await computeToolHistoryDelta(id, [
        { call_id: 'call_001', result: big },
    ]);
    assert(
        'error' in d && d.error.includes('exceeds per-entry cap'),
        'oversize entry rejected with per-entry cap error',
    );
});

await withRedis(async r => {
    /** Idempotent retry: same payload re-submitted under same call_id
     * must yield zero new call_ids and zero bytesDelta. The router
     * relies on this to make at-least-once client retries safe. */
    const id = 'exec_delta_idempotent';
    await r.hset(
        historyKey(id),
        'call_001',
        JSON.stringify({
            result: { x: 1 },
            is_error: false,
            error_message: undefined,
            received_at: 1000,
        }),
    );
    const d = await computeToolHistoryDelta(id, [
        { call_id: 'call_001', result: { x: 1 } },
    ]);
    if ('error' in d) {
        assert(false, `idempotent retry rejected: ${d.error}`);
        return;
    }
    assert(d.newCallIds.length === 0, 'idempotent retry: zero new call_ids');
    assert(d.bytesDelta === 0, 'idempotent retry: zero bytesDelta');
    assert(
        d.serializedByCallId.size === 0,
        'idempotent retry: nothing to HSET',
    );
});

await withRedis(async r => {
    /** Mutated retry: same call_id with a different payload must be
     * rejected with a 409-shaped error (immutability invariant). */
    const id = 'exec_delta_mutation';
    await r.hset(
        historyKey(id),
        'call_001',
        JSON.stringify({
            result: { x: 1 },
            is_error: false,
            error_message: undefined,
            received_at: 1000,
        }),
    );
    const d = await computeToolHistoryDelta(id, [
        { call_id: 'call_001', result: { x: 999 } },
    ]);
    assert(
        'error' in d && d.error.includes('immutable'),
        'mutated retry rejected as immutable',
    );
    assert(
        'status' in d && d.status === 409,
        'immutable mismatch carries status: 409',
    );
});

await withRedis(async r => {
    /** Malformed existing entry (non-JSON) must be treated as absent
     * so a single corrupted hash field doesn't permanently brick all
     * subsequent retries for the execution. */
    const id = 'exec_delta_malformed_existing';
    await r.hset(historyKey(id), 'call_001', '{not json');
    const d = await computeToolHistoryDelta(id, [
        { call_id: 'call_001', result: { x: 1 } },
    ]);
    if ('error' in d) {
        assert(
            false,
            `malformed existing should be treated as absent, got: ${d.error}`,
        );
        return;
    }
    assert(
        d.newCallIds.length === 1,
        'malformed existing: incoming entry treated as new',
    );
});

// ---------------------------------------------------------------------------
// commitToolHistoryAndState: atomicity + cap + TTL refresh
// ---------------------------------------------------------------------------

console.log('\ncommitToolHistoryAndState:');
await withRedis(async r => {
    const state = makeState({ callCount: 1, historyBytes: 0 });
    const d = await computeToolHistoryDelta(state.execution_id, [
        { call_id: 'call_001', result: { ok: true } },
    ]);
    if ('error' in d) {
        assert(false, `delta failed: ${d.error}`);
        return;
    }
    state.callCount = 1;
    state.historyBytes = d.bytesDelta;
    await commitToolHistoryAndState(state, d);

    const persistedState = await getExecutionState(state.execution_id);
    assert(
        persistedState?.callCount === 1,
        'committed: state callCount persisted',
    );

    const persistedHistory = await loadToolHistory(state.execution_id);
    assert(
        persistedHistory.call_001 != null &&
            JSON.stringify(persistedHistory.call_001.result) === '{"ok":true}',
        'committed: tool_history hash entry persisted',
    );

    const stateTtl = await r.ttl(`exec_state:${state.execution_id}`);
    const historyTtlAfter = await r.ttl(historyKey(state.execution_id));
    assert(
        stateTtl > 0 && stateTtl <= EXECUTION_STATE_TTL,
        'commit refreshes exec_state TTL',
    );
    assert(
        historyTtlAfter > 0 && historyTtlAfter <= EXECUTION_STATE_TTL,
        'commit refreshes tool_history TTL',
    );
});

await withRedis(async r => {
    /** Idempotent commit (delta empty) must STILL refresh the
     * tool_history TTL. Without this guarantee, a slow client whose
     * retry happens to be byte-identical would renew exec_state but
     * leak the prior tool_history TTL — a real bug fixed in an earlier
     * codex review round. The realistic shape is: history was
     * populated by an earlier successful commit, its TTL has decayed,
     * a retry comes in with no new entries; the empty-delta path must
     * still bump tool_history's TTL back to EXECUTION_STATE_TTL. */
    const id = 'exec_idempotent_ttl';
    const state = makeState({
        execution_id: id,
        callCount: 1,
        historyBytes: 100,
    });
    await setExecutionState(state);
    await r.hset(
        historyKey(id),
        'call_001',
        JSON.stringify({
            result: 1,
            is_error: false,
            received_at: 1,
        }),
    );
    /** Decay both TTLs to a value much smaller than EXECUTION_STATE_TTL so
     * the assertion can prove the refresh actually happened (vs. just
     * succeeding because the TTL hadn't moved). */
    await r.expire(`exec_state:${id}`, 5);
    await r.expire(historyKey(id), 5);

    await commitToolHistoryAndState(state, {
        serializedByCallId: new Map(),
        newCallIds: [],
        bytesDelta: 0,
    });

    const stateTtlAfter = await r.ttl(`exec_state:${id}`);
    const historyTtlAfter = await r.ttl(historyKey(id));
    assert(
        stateTtlAfter > 5,
        `idempotent commit refreshes exec_state TTL (got ${stateTtlAfter})`,
    );
    assert(
        historyTtlAfter > 5,
        `idempotent commit STILL refreshes tool_history TTL when delta is empty (got ${historyTtlAfter})`,
    );
    const persisted = await getExecutionState(id);
    assert(
        persisted !== null,
        'idempotent commit persists state without history mutation',
    );
});

await withRedis(async () => {
    const huge = 'x'.repeat(MAX_EXECUTION_STATE_BYTES + 1000);
    const state = makeState({ userCode: huge });
    let threwTyped = false;
    try {
        await commitToolHistoryAndState(state, {
            serializedByCallId: new Map(),
            newCallIds: [],
            bytesDelta: 0,
        });
    } catch (err) {
        threwTyped = err instanceof ExecutionStateTooLargeError;
    }
    assert(
        threwTyped,
        'oversize state on commit throws ExecutionStateTooLargeError (not a generic Error)',
    );
});

await withRedis(async r => {
    /** Atomicity check: simulate transaction failure by stubbing
     * `multi().exec()` to return null. Both keys must be left
     * untouched (partial application would leave callCount stale and
     * history advanced, or vice versa). */
    const state = makeState();
    await setExecutionState(state);
    const before = JSON.stringify(await getExecutionState(state.execution_id));

    const origMulti = r.multi.bind(r);
    /** Replace `multi` with one whose `exec()` resolves to null,
     * which `commitToolHistoryAndState` interprets as an aborted
     * transaction. */
    (r as unknown as { multi: () => unknown }).multi = (() => {
        const tx = origMulti();
        (tx as unknown as { exec: () => Promise<null> }).exec = () =>
            Promise.resolve(null);
        return tx;
    }) as unknown as Redis['multi'];

    let threw = false;
    try {
        await commitToolHistoryAndState(state, {
            serializedByCallId: new Map([
                [
                    'call_001',
                    JSON.stringify({
                        result: 1,
                        is_error: false,
                        received_at: 1,
                    }),
                ],
            ]),
            newCallIds: ['call_001'],
            bytesDelta: 100,
        });
    } catch {
        threw = true;
    }
    assert(threw, 'aborted MULTI/EXEC surfaces as a thrown error');

    /** Restore the real multi so the post-condition checks see truth. */
    (r as unknown as { multi: typeof origMulti }).multi = origMulti;

    const after = JSON.stringify(await getExecutionState(state.execution_id));
    assert(before === after, 'aborted MULTI/EXEC leaves exec_state unchanged');
    const history = await loadToolHistory(state.execution_id);
    assert(
        Object.keys(history).length === 0,
        'aborted MULTI/EXEC leaves tool_history empty (no partial HSET)',
    );
});

// ---------------------------------------------------------------------------
// loadToolHistory: drops malformed entries
// ---------------------------------------------------------------------------

console.log('\nloadToolHistory:');
await withRedis(async r => {
    const id = 'exec_load_history';
    await r.hset(
        historyKey(id),
        'call_001',
        JSON.stringify({
            result: { ok: 1 },
            is_error: false,
            error_message: undefined,
            received_at: 1,
        }),
    );
    await r.hset(historyKey(id), 'call_002', '{not json');
    const out = await loadToolHistory(id);
    assert(out.call_001 != null, 'valid entry survived');
    assert(out.call_002 === undefined, 'malformed entry dropped silently');
});

// ---------------------------------------------------------------------------
// Blocking-result key + setExecutionResult/Error
// ---------------------------------------------------------------------------

console.log('\nblocking result key:');
await withRedis(async () => {
    const id = 'exec_blocking_result';
    const result: Parameters<typeof setBlockingResult>[1] = {
        session_id: id,
        stdout: 'hi',
        stderr: '',
        files: [],
        code: 0,
    };
    await setBlockingResult(id, result);
    const got = await getBlockingResult(id);
    assert(got?.stdout === 'hi', 'set/get blocking result round-trip');
    await deleteBlockingResult(id);
    const gone = await getBlockingResult(id);
    assert(gone === null, 'deleteBlockingResult removes the key');
});

await withRedis(async () => {
    const state = makeState({ mode: 'blocking' });
    await setExecutionState(state);
    await setExecutionResult(state.execution_id, {
        session_id: state.session_id,
        stdout: 'done',
        stderr: '',
        files: [],
        code: 0,
    });
    const persisted = await getExecutionState(state.execution_id);
    assert(
        persisted?.jobCompleted === true,
        'setExecutionResult flips jobCompleted=true',
    );
    assert(
        persisted?.jobResult === undefined,
        'setExecutionResult clears legacy inline jobResult field',
    );
    const blocking = await getBlockingResult(state.execution_id);
    assert(
        blocking?.stdout === 'done',
        'setExecutionResult writes through to exec_result key',
    );
});

await withRedis(async () => {
    const state = makeState({ mode: 'blocking' });
    await setExecutionState(state);
    await setExecutionError(state.execution_id, new Error('boom'));
    const persisted = await getExecutionState(state.execution_id);
    assert(
        persisted?.jobCompleted === true,
        'setExecutionError flips jobCompleted=true',
    );
    assert(
        persisted?.jobError === 'boom',
        'setExecutionError captures error message',
    );
});

await withRedis(async r => {
    /** Race regression test (codex P2): blocking-mode tear-down can call
     * `cleanupExecution` between the BullMQ-completion callback's lookup
     * and write. The previous unguarded `setExecutionResult`/`setExecutionError`
     * implementations would resurrect torn-down state and orphan a fresh
     * `exec_result:` blob until TTL expiry. The conditional Lua eval makes
     * both a no-op once cleanup has won the race. */
    const id = 'exec_orphan_race';
    await setExecutionState(makeState({ execution_id: id, mode: 'blocking' }));
    await deleteExecutionState(id);
    /** Simulate the late-arriving completion callback firing AFTER cleanup. */
    await setExecutionResult(id, {
        session_id: id,
        stdout: 'big',
        stderr: '',
        files: [],
        code: 0,
    });
    assert(
        (await r.exists(`exec_state:${id}`)) === 0,
        'late setExecutionResult does NOT resurrect exec_state after cleanup',
    );
    assert(
        (await r.exists(`exec_result:${id}`)) === 0,
        'late setExecutionResult does NOT write an orphan exec_result blob after cleanup',
    );

    /** Same race for setExecutionError. */
    await setExecutionState(makeState({ execution_id: id, mode: 'blocking' }));
    await deleteExecutionState(id);
    await setExecutionError(id, new Error('late'));
    assert(
        (await r.exists(`exec_state:${id}`)) === 0,
        'late setExecutionError does NOT resurrect exec_state after cleanup',
    );
});

// ---------------------------------------------------------------------------
// refreshExecutionTtl
// ---------------------------------------------------------------------------

console.log('\nrefreshExecutionTtl:');
await withRedis(async r => {
    const state = makeState();
    await setExecutionState(state);
    await r.hset(
        historyKey(state.execution_id),
        'call_001',
        JSON.stringify({
            result: 1,
            is_error: false,
            received_at: 1,
        }),
    );
    /** Shorten TTLs to 5s, then refresh and confirm both are bumped
     * back to the full EXECUTION_STATE_TTL. */
    await r.expire(`exec_state:${state.execution_id}`, 5);
    await r.expire(historyKey(state.execution_id), 5);
    await refreshExecutionTtl(state.execution_id);
    const stateTtl = await r.ttl(`exec_state:${state.execution_id}`);
    const historyTtl = await r.ttl(historyKey(state.execution_id));
    assert(stateTtl > 5, 'refresh extends exec_state TTL');
    assert(historyTtl > 5, 'refresh extends tool_history TTL');
});

// ---------------------------------------------------------------------------
// scanKeys + cleanup
// ---------------------------------------------------------------------------

console.log('\nscanKeys + cleanup:');
await withRedis(async r => {
    await r.set('exec_state:a', 'x');
    await r.set('exec_state:b', 'x');
    await r.set('other_key', 'x');
    const found = await scanKeys('exec_state:*');
    assert(
        found.length === 2,
        `scanKeys returns matching keys (got ${found.length})`,
    );
    assert(
        !found.includes('other_key'),
        'scanKeys does not return non-matching keys',
    );
});

await withRedis(async r => {
    /** scanKeys must respect its limit so a degenerate dataset can't
     * OOM the janitor. Insert 25 keys; ask for 10. */
    for (let i = 0; i < 25; i++) await r.set(`exec_state:k${i}`, 'x');
    const found = await scanKeys('exec_state:*', 5, 10);
    assert(
        found.length === 10,
        `scanKeys honors limit (got ${found.length}, expected 10)`,
    );
});

await withRedis(async r => {
    const id = 'exec_cleanup';
    await setExecutionState(makeState({ execution_id: id, mode: 'replay' }));
    await r.hset(
        historyKey(id),
        'call_001',
        JSON.stringify({
            result: 1,
            is_error: false,
            received_at: 1,
        }),
    );
    await setBlockingResult(id, {
        session_id: id,
        stdout: '',
        stderr: '',
        files: [],
        code: 0,
    });
    await cleanupExecution(id, 'replay');
    assert(
        (await getExecutionState(id)) === null,
        'cleanupExecution drops exec_state',
    );
    assert(
        Object.keys(await loadToolHistory(id)).length === 0,
        'cleanupExecution drops tool_history',
    );
    assert(
        (await getBlockingResult(id)) === null,
        'cleanupExecution drops exec_result',
    );
});

await withRedis(async r => {
    /** Stale-execution sweep: an old, incomplete execution must be
     * reaped; a recent one must be left alone. The sweep delegates to
     * `cleanupExecution`, which is expected to drop ALL THREE keys
     * (`exec_state`, `tool_history`, `exec_result`). Earlier the test
     * only asserted `exec_state` was gone, which would let a regression
     * that drops only the state key — leaking history/blocking results —
     * sneak through. */
    const oldId = 'exec_stale_old';
    const freshId = 'exec_stale_fresh';
    const stamp = Date.now() - (EXECUTION_STATE_TTL * 1000 + 60_000);
    await setExecutionState(
        makeState({
            execution_id: oldId,
            mode: 'replay',
            startTime: stamp,
            lastActivity: stamp,
        }),
    );
    await r.hset(
        historyKey(oldId),
        'call_001',
        JSON.stringify({
            result: 1,
            is_error: false,
            received_at: 1,
        }),
    );
    await setBlockingResult(oldId, {
        session_id: oldId,
        stdout: '',
        stderr: '',
        files: [],
        code: 0,
    });
    await setExecutionState(
        makeState({
            execution_id: freshId,
            mode: 'replay',
        }),
    );

    const cleaned = await cleanupStaleExecutions();
    assert(
        cleaned >= 1,
        `cleanupStaleExecutions reaps stale entries (cleaned=${cleaned})`,
    );
    assert(
        (await getExecutionState(oldId)) === null,
        'sweep drops exec_state for stale execution',
    );
    assert(
        Object.keys(await loadToolHistory(oldId)).length === 0,
        'sweep drops tool_history for stale execution',
    );
    assert(
        (await getBlockingResult(oldId)) === null,
        'sweep drops exec_result for stale execution',
    );
    assert(
        (await getExecutionState(freshId)) !== null,
        'fresh execution retained',
    );
});

await withRedis(async () => {
    /** A completed execution should NOT be reaped by the sweeper —
     * jobCompleted is the ground truth signal. */
    const completedId = 'exec_stale_completed';
    const stamp = Date.now() - (EXECUTION_STATE_TTL * 1000 + 60_000);
    await setExecutionState(
        makeState({
            execution_id: completedId,
            mode: 'replay',
            startTime: stamp,
            lastActivity: stamp,
            jobCompleted: true,
        }),
    );
    await cleanupStaleExecutions();
    assert(
        (await getExecutionState(completedId)) !== null,
        'completed-but-old execution NOT reaped (jobCompleted is ground truth)',
    );
});

await withRedis(async r => {
    /** Malformed `exec_state:<id>` JSON (corrupt write, partial legacy
     * migration) must be reaped along with its sibling `tool_history`
     * and `exec_result` keys. Without that, the orphaned siblings sit
     * around eating Redis memory until their independent TTL fires —
     * which is what an earlier version of this branch did. */
    const id = 'exec_corrupt';
    await r.set(`exec_state:${id}`, '{not-json', 'EX', EXECUTION_STATE_TTL);
    await r.hset(
        historyKey(id),
        'call_001',
        JSON.stringify({
            result: 1,
            is_error: false,
            received_at: 1,
        }),
    );
    await setBlockingResult(id, {
        session_id: id,
        stdout: '',
        stderr: '',
        files: [],
        code: 0,
    });
    const reaped = await cleanupStaleExecutions();
    assert(
        reaped === 1,
        `malformed-key reap counted in return value (got ${reaped}, want 1)`,
    );
    assert(
        (await r.exists(`exec_state:${id}`)) === 0,
        'malformed exec_state key reaped',
    );
    assert(
        Object.keys(await loadToolHistory(id)).length === 0,
        'malformed sweep also drops tool_history sibling',
    );
    assert(
        (await getBlockingResult(id)) === null,
        'malformed sweep also drops exec_result sibling',
    );
});

// ===========================================================================
// Pure router pre-checks: validateContinuationBatch + checkContinuationPreconditions
// ===========================================================================
//
// These exercise the branches of `handleReplayContinuation` that don't
// require Redis or queue/axios — i.e. the cap, shape, and authorization
// gates pulled into pure helpers in `replay-state.ts`. They cover the
// matrix that previously had no unit-level test, since spinning up the
// router as a whole would also drag in BullMQ + the tool-call-server.

(() => {
    const ok = validateContinuationBatch([
        { call_id: 'call_001', result: 'x' },
    ]);
    assert(ok.ok === true, 'validateContinuationBatch: happy path returns ok');
    if (ok.ok) {
        assert(
            ok.results.length === 1 && ok.results[0].call_id === 'call_001',
            'validateContinuationBatch: passes through validated entries',
        );
    }
})();

(() => {
    const tooMany = new Array(MAX_REPLAY_CALLS + 1).fill(0).map((_, i) => ({
        call_id: `call_${String(i + 1).padStart(3, '0')}`,
        result: i,
    }));
    const out = validateContinuationBatch(tooMany);
    assert(
        !out.ok && out.status === 400 && out.error.includes('per-batch cap'),
        `validateContinuationBatch: > MAX_REPLAY_CALLS returns 400 ("${out.ok ? 'ok' : out.error}")`,
    );
})();

(() => {
    const out = validateContinuationBatch([
        { call_id: 'call_001', result: 'a' },
        { call_id: 'call_001', result: 'b' },
    ]);
    assert(
        !out.ok &&
            out.status === 400 &&
            out.error.includes('Duplicate call_id'),
        'validateContinuationBatch: dup call_id returns 400 with helpful message',
    );
})();

(() => {
    const out = validateContinuationBatch([
        { call_id: 'call_001', result: 'good' },
        { call_id: 'call_002' /* missing result */ },
    ]);
    assert(
        !out.ok && out.status === 400 && /required/i.test(out.error),
        'validateContinuationBatch: forwards per-entry validation errors verbatim',
    );
})();

function makeDelta(
    newCallIds: string[] = [],
    bytesDelta = 0,
): import('../src/service/replay-state').ToolHistoryDelta {
    return { serializedByCallId: new Map(), newCallIds, bytesDelta };
}

(() => {
    const state = makeState({
        mode: 'blocking',
        emittedCallIds: ['call_001'],
    });
    const out = checkContinuationPreconditions({
        state,
        results: [{ call_id: 'call_001', result: 'x' }],
        userId: state.userId,
        apiKeyId: state.apiKeyId,
        delta: makeDelta(['call_001'], 10),
    });
    assert(
        !out.ok && out.status === 400 && out.error.includes('blocking mode'),
        'checkContinuationPreconditions: blocking mode rejects with 400',
    );
})();

(() => {
    const state = makeState({ emittedCallIds: ['call_001'] });
    const out = checkContinuationPreconditions({
        state,
        results: [{ call_id: 'call_001', result: 'x' }],
        userId: 'someone_else',
        apiKeyId: state.apiKeyId,
        delta: makeDelta(['call_001'], 10),
    });
    assert(
        !out.ok && out.status === 403,
        'checkContinuationPreconditions: userId mismatch -> 403',
    );
})();

(() => {
    const state = makeState({
        emittedCallIds: ['call_001'],
        apiKeyId: 'key_orig',
    });
    const out = checkContinuationPreconditions({
        state,
        results: [{ call_id: 'call_001', result: 'x' }],
        userId: state.userId,
        apiKeyId: 'key_other',
        delta: makeDelta(['call_001'], 10),
    });
    assert(
        !out.ok && out.status === 403,
        'checkContinuationPreconditions: apiKeyId mismatch -> 403 (when state has apiKeyId set)',
    );
})();

(() => {
    const state = makeState({
        emittedCallIds: ['call_001'],
        tenantId: 'tenant_a',
    });
    const out = checkContinuationPreconditions({
        state,
        results: [{ call_id: 'call_001', result: 'x' }],
        userId: state.userId,
        apiKeyId: state.apiKeyId,
        tenantId: 'tenant_b',
        delta: makeDelta(['call_001'], 10),
    });
    assert(
        !out.ok && out.status === 403,
        'checkContinuationPreconditions: tenant mismatch -> 403',
    );
})();

(() => {
    const state = makeState({
        emittedCallIds: ['call_001'],
        tenantId: 'tenant_a',
    });
    const out = checkContinuationPreconditions({
        state,
        results: [{ call_id: 'call_001', result: 'x' }],
        userId: state.userId,
        apiKeyId: state.apiKeyId,
        delta: makeDelta(['call_001'], 10),
    });
    assert(
        !out.ok && out.status === 403,
        'checkContinuationPreconditions: missing tenant on tenant-bound execution -> 403',
    );
})();

(() => {
    const state = makeState({
        emittedCallIds: ['call_001'],
        authContextHash: 'hash_orig',
    });
    const out = checkContinuationPreconditions({
        state,
        results: [{ call_id: 'call_001', result: 'x' }],
        userId: state.userId,
        apiKeyId: state.apiKeyId,
        authContextHash: 'hash_other',
        delta: makeDelta(['call_001'], 10),
    });
    assert(
        !out.ok && out.status === 403,
        'checkContinuationPreconditions: authContextHash mismatch -> 403',
    );
})();

(() => {
    const state = makeState({
        emittedCallIds: ['call_001'],
        authContextHash: 'hash_orig',
    });
    const out = checkContinuationPreconditions({
        state,
        results: [{ call_id: 'call_001', result: 'x' }],
        userId: state.userId,
        apiKeyId: state.apiKeyId,
        delta: makeDelta(['call_001'], 10),
    });
    assert(
        !out.ok && out.status === 403,
        'checkContinuationPreconditions: missing authContextHash on hash-bound execution -> 403',
    );
})();

(() => {
    const state = makeState({ emittedCallIds: ['call_001'] });
    const out = checkContinuationPreconditions({
        state,
        results: [{ call_id: 'call_999', result: 'x' }],
        userId: state.userId,
        apiKeyId: state.apiKeyId,
        delta: makeDelta(['call_999'], 10),
    });
    assert(
        !out.ok && out.status === 400 && out.error.includes('not issued'),
        'checkContinuationPreconditions: non-issued call_id -> 400',
    );
})();

(() => {
    const state = makeState({
        emittedCallIds: Array.from(
            { length: MAX_REPLAY_CALLS },
            (_, i) => `call_${String(i + 1).padStart(3, '0')}`,
        ),
        callCount: MAX_REPLAY_CALLS,
    });
    const out = checkContinuationPreconditions({
        state,
        results: [{ call_id: 'call_001', result: 'x' }],
        userId: state.userId,
        apiKeyId: state.apiKeyId,
        delta: makeDelta(['call_extra'], 10),
    });
    assert(
        !out.ok &&
            out.status === 400 &&
            out.error.includes('maximum tool calls'),
        'checkContinuationPreconditions: callCount + new > cap -> 400',
    );
    assert(
        !out.ok && out.cleanupOnReject === true,
        'checkContinuationPreconditions: cap-exceeded sets cleanupOnReject so router can reap',
    );
})();

(() => {
    const state = makeState({
        emittedCallIds: ['call_001'],
        historyBytes: MAX_TOOL_HISTORY_TOTAL_BYTES - 100,
    });
    const out = checkContinuationPreconditions({
        state,
        results: [{ call_id: 'call_001', result: 'x' }],
        userId: state.userId,
        apiKeyId: state.apiKeyId,
        delta: makeDelta(['call_001'], 10_000),
    });
    assert(
        !out.ok && out.status === 400 && out.error.includes('exceeds cap'),
        'checkContinuationPreconditions: aggregate history bytes > cap -> 400',
    );
})();

(() => {
    const state = makeState({
        emittedCallIds: ['call_001', 'call_002'],
        callCount: 1,
        historyBytes: 50,
    });
    const out = checkContinuationPreconditions({
        state,
        results: [
            { call_id: 'call_001', result: 'x' },
            { call_id: 'call_002', result: 'y' },
        ],
        userId: state.userId,
        apiKeyId: state.apiKeyId,
        delta: makeDelta(['call_002'], 25),
    });
    assert(
        out.ok === true,
        'checkContinuationPreconditions: happy path returns ok',
    );
})();

(() => {
    /** State persisted with no `apiKeyId` (legacy / pre-auth tag executions)
     * must not be locked out by an apiKeyId presented at continuation time —
     * the auth check skips when state.apiKeyId is null. */
    const state = makeState({ emittedCallIds: ['call_001'] });
    delete (state as { apiKeyId?: string }).apiKeyId;
    const out = checkContinuationPreconditions({
        state,
        results: [{ call_id: 'call_001', result: 'x' }],
        userId: state.userId,
        apiKeyId: 'any_key',
        delta: makeDelta(['call_001'], 10),
    });
    assert(
        out.ok === true,
        'checkContinuationPreconditions: state.apiKeyId == null bypasses apiKey check',
    );
})();

console.log(`\n${passed} passed, ${failed} failed`);

/** The `replay-state` import transitively initializes a real ioredis client
 * (via `queue.ts`) which keeps trying to connect in the background. Without
 * an explicit exit the test process either hangs or spews ETIMEDOUT noise
 * after the assertions have already passed. Force-exit after disconnecting. */
try {
    const { connection } = await import('../src/queue');
    connection.disconnect();
} catch {
    /** ignore — we're exiting anyway */
}
process.exit(failed > 0 ? 1 : 0);
