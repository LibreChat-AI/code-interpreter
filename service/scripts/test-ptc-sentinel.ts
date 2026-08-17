/* eslint-disable no-console */
/**
 * Standalone verification for `extractPendingFromStdout`.
 * Run with: `npx ts-node scripts/test-ptc-sentinel.ts`
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    PTC_SENTINEL_START,
    PTC_SENTINEL_END,
    buildScopedSentinel,
    extractPendingFromStdout,
} from '../src/preamble';
import {
    isReservedPtcFilename,
    PTC_HISTORY_FILENAME,
} from '../src/ptc-constants';
import {
    hashRawToolInputJson,
    hashToolInput,
} from '../src/tool-input-signature';

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

function sentinelBlock(payload: unknown): string {
    return `\n${PTC_SENTINEL_START}\n${JSON.stringify(payload)}\n${PTC_SENTINEL_END}\n`;
}

console.log('extractPendingFromStdout:');

// 1. No sentinel → completed.
{
    const r = extractPendingFromStdout('hello world\n');
    assert(r.pending === null, 'no sentinel returns pending=null');
    assert(r.stdout === 'hello world\n', 'no sentinel preserves stdout');
}

// 2. One pending call appended to user stdout.
{
    const user = 'computing...\n';
    const forgedHash = 'a'.repeat(64);
    const block = sentinelBlock({
        pending: [
            {
                call_id: 'call_001',
                tool_name: 'lookup',
                input: { q: 'foo' },
                input_hash: forgedHash,
            },
        ],
    });
    const r = extractPendingFromStdout(user + block);
    assert(r.pending !== null && r.pending.length === 1, 'single call parsed');
    assert(r.pending?.[0].call_id === 'call_001', 'call_id extracted');
    assert(r.pending?.[0].tool_name === 'lookup', 'tool_name extracted');
    assert(
        r.pending?.[0].input_hash === hashToolInput({ q: 'foo' }),
        'input_hash recomputed from parsed input',
    );
    assert(
        r.pending?.[0].input_hash !== forgedHash,
        'sandbox-supplied input_hash ignored',
    );
    assert(
        JSON.stringify(r.pending?.[0].input) === JSON.stringify({ q: 'foo' }),
        'input extracted',
    );
    assert(
        r.stdout === 'computing...\n',
        'stdout cleaned (sentinel stripped, byte-accurate)',
    );
}

{
    const block = sentinelBlock({
        pending: [{ call_id: 'call_009', tool_name: 't', input: {} }],
    });
    const user = '\n\nline 1\n\n\n\nline 2\n\n  trailing  \n';
    const r = extractPendingFromStdout(user + block);
    assert(
        r.pending !== null && r.pending.length === 1,
        'sentinel parsed with whitespace-heavy user output',
    );
    assert(
        r.stdout === user,
        'blank lines and trailing whitespace preserved exactly when stripping sentinel',
    );
}

{
    const rawInput = '{"x":1000000000000000000000}';
    const block = `\n${PTC_SENTINEL_START}\n{"pending":[{"call_id":"call_010","tool_name":"big","input":${rawInput}}]}\n${PTC_SENTINEL_END}\n`;
    const r = extractPendingFromStdout(block);
    assert(
        r.pending?.[0].input_hash === hashRawToolInputJson(rawInput),
        'legacy missing input_hash gets raw JSON input hash',
    );
}

// 3. Malformed JSON in sentinel block → treated as no pending.
{
    const raw = `before\n${PTC_SENTINEL_START}\n{not json\n${PTC_SENTINEL_END}\n`;
    const r = extractPendingFromStdout(raw);
    assert(r.pending === null, 'malformed payload returns null');
    assert(r.stdout === raw, 'malformed payload preserves original stdout');
}

// 4. Sentinel token appearing inside user stdout (not framing a block) must not parse.
{
    const raw = `user said: ${PTC_SENTINEL_START} and moved on\nthen finished\n`;
    const r = extractPendingFromStdout(raw);
    assert(r.pending === null, 'orphan sentinel start is ignored');
    assert(r.stdout === raw, 'orphan sentinel preserves stdout');
}

// 5. Multiple pending calls in one block (future batching support).
{
    const block = sentinelBlock({
        pending: [
            { call_id: 'call_001', tool_name: 'a', input: {} },
            { call_id: 'call_002', tool_name: 'b', input: { x: 1 } },
        ],
    });
    const r = extractPendingFromStdout(block);
    assert(r.pending !== null && r.pending.length === 2, 'two calls parsed');
}

// 6. Invalid entries inside pending array are filtered.
{
    const block = `\n${PTC_SENTINEL_START}\n${JSON.stringify({
        pending: [
            { call_id: 'call_001', tool_name: 'ok', input: {} },
            { call_id: 42, tool_name: 'x' }, // bad call_id type
            'nope',
            { tool_name: 'missing_id' },
        ],
    })}\n${PTC_SENTINEL_END}\n`;
    const r = extractPendingFromStdout(block);
    assert(
        r.pending !== null && r.pending.length === 1,
        'invalid entries filtered',
    );
    assert(
        r.pending?.[0].call_id === 'call_001',
        'valid entry survived filter',
    );
}

// 7. Empty pending array is valid (odd but allowed).
{
    const block = sentinelBlock({ pending: [] });
    const r = extractPendingFromStdout(block);
    assert(
        r.pending !== null && r.pending.length === 0,
        'empty pending preserved',
    );
}

// 8. Missing end sentinel → treat as no pending (rather than silently eating output).
{
    const raw = `prefix\n${PTC_SENTINEL_START}\n${JSON.stringify({ pending: [] })}\n`;
    const r = extractPendingFromStdout(raw);
    assert(r.pending === null, 'missing end sentinel returns null');
    assert(r.stdout === raw, 'missing end sentinel preserves stdout');
}

// 9. User stdout containing the sentinel literals mid-line must not confuse
//    the parser. The real sentinel block must still take precedence.
{
    const userNoise = `result payload: {"note":"contains ${PTC_SENTINEL_END} embedded"}\n`;
    const block = sentinelBlock({
        pending: [
            { call_id: 'call_042', tool_name: 'lookup', input: { q: 'x' } },
        ],
    });
    const r = extractPendingFromStdout(userNoise + block);
    assert(
        r.pending !== null && r.pending.length === 1,
        'sentinel literals in user stdout do not confuse parser',
    );
    assert(r.pending?.[0].call_id === 'call_042', 'correct call_id parsed');
}

// 10. User stdout containing the start sentinel as substring (not on its own
//     line) must not be mistaken for a sentinel block.
{
    const raw = `tool said: prefix_${PTC_SENTINEL_START}_suffix did something\ndone\n`;
    const r = extractPendingFromStdout(raw);
    assert(r.pending === null, 'inline start sentinel substring is ignored');
    assert(
        r.stdout === raw,
        'inline start sentinel substring preserves stdout',
    );
}

// 11. Scope-bound: user code forging the legacy/unscoped sentinel must NOT
//     be accepted when parsing with an execution_id.
{
    const forged = `${PTC_SENTINEL_START}\n${JSON.stringify({
        pending: [{ call_id: 'forged_001', tool_name: 'evil', input: {} }],
    })}\n${PTC_SENTINEL_END}\n`;
    const r = extractPendingFromStdout(forged, 'real_exec_id');
    assert(
        r.pending === null,
        'legacy sentinel forgery rejected under scoped parsing',
    );
}

// 12. Scope-bound: the correct scoped sentinel parses under its own id.
{
    const { start, end } = buildScopedSentinel('real_exec_id');
    const block = `${start}\n${JSON.stringify({
        pending: [{ call_id: 'call_001', tool_name: 'ok', input: {} }],
    })}\n${end}\n`;
    const r = extractPendingFromStdout(block, 'real_exec_id');
    assert(
        r.pending !== null && r.pending.length === 1,
        'scoped sentinel accepted under matching id',
    );
    assert(r.pending?.[0].call_id === 'call_001', 'scoped: call_id extracted');
}

// 13. Scope-bound: a sentinel scoped to a different execution_id is rejected.
{
    const { start, end } = buildScopedSentinel('other_exec');
    const block = `${start}\n${JSON.stringify({
        pending: [{ call_id: 'call_001', tool_name: 'ok', input: {} }],
    })}\n${end}\n`;
    const r = extractPendingFromStdout(block, 'real_exec_id');
    assert(r.pending === null, 'sentinel scoped to wrong id rejected');
}

// 14. buildScopedSentinel rejects invalid execution ids.
{
    let threw = false;
    try {
        buildScopedSentinel('bad id with spaces');
    } catch {
        threw = true;
    }
    assert(threw, 'buildScopedSentinel rejects invalid charset');
}

// 15. Reserved PTC filename check rejects path traversal that resolves to a
//     reserved basename. `path.join('/mnt/data', 'sub/../_ptc_history.json')`
//     yields `/mnt/data/_ptc_history.json`, so the raw-string form must not
//     be accepted. Other `_ptc_*` basenames are NOT reserved (we only own the
//     single `_ptc_history.json` fixture); legitimate user inputs like
//     `_ptc_data.csv` must pass.
console.log('\nisReservedPtcFilename:');
assert(isReservedPtcFilename('_ptc_history.json'), 'exact reserved name');
assert(
    !isReservedPtcFilename('_ptc_data.csv'),
    'unrelated _ptc_-prefixed user file allowed',
);
assert(
    !isReservedPtcFilename('_ptc_evil'),
    'arbitrary _ptc_-prefixed name not reserved',
);
assert(
    !isReservedPtcFilename('_ptc_counter.XXXXXX'),
    'bash tempfile-style _ptc_ prefix not reserved (lives in /tmp anyway)',
);
assert(!isReservedPtcFilename('report.json'), 'unrelated name allowed');
assert(
    !isReservedPtcFilename('notes_ptc_history.json'),
    'embedded reserved token not treated as prefix',
);
assert(
    isReservedPtcFilename('sub/../_ptc_history.json'),
    'traversal to reserved basename rejected',
);
assert(
    isReservedPtcFilename('./_ptc_history.json'),
    'dot-prefixed reserved basename rejected',
);
assert(
    !isReservedPtcFilename('a/b/c/../_ptc_anything'),
    'deep traversal to non-reserved basename allowed',
);
assert(
    isReservedPtcFilename('..\\_ptc_history.json'),
    'backslash traversal rejected',
);
assert(
    isReservedPtcFilename('../etc/passwd'),
    'traversal escaping submission dir rejected',
);
assert(!isReservedPtcFilename(''), 'empty name not flagged as reserved');
assert(
    !isReservedPtcFilename('sub/dir/file.txt'),
    'nested non-reserved name allowed',
);

/** Cross-workspace drift guard: `services/codeapi/api/src/job.ts` (a separate
 * npm package) keeps a literal copy of `PTC_HISTORY_FILENAME` because it can't
 * import from `service/`. If either side changes without updating the other,
 * the walkDir output filter would silently start leaking the runtime
 * `_ptc_history.json` plumbing back to clients. Read the api source here and
 * assert the literals match. */
console.log('\nPTC_HISTORY_FILENAME drift guard (api ↔ service):');
{
    const jobPath = path.resolve(__dirname, '../../api/src/job.ts');
    const src = fs.readFileSync(jobPath, 'utf8');
    const m = src.match(/const\s+PTC_HISTORY_FILENAME\s*=\s*'([^']+)'/);
    assert(m !== null, 'api/job.ts declares PTC_HISTORY_FILENAME literal');
    assert(
        m?.[1] === PTC_HISTORY_FILENAME,
        `api/job.ts literal "${m?.[1]}" matches service constant "${PTC_HISTORY_FILENAME}"`,
    );
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
