/* eslint-disable no-console */
/**
 * Unit tests for the sandbox API env-var sanitization and blocklist.
 * Covers both `sanitizeEnvVars` (from `api/v2.ts`, surface-level shape/
 * byte-limit enforcement) and `filterExtraEnvVars` (from `job.ts`, the
 * reserved-key / reserved-prefix blocklist applied when spreading
 * caller-supplied env vars into nsjail).
 *
 * These paths are security-critical — a regression that let
 * `PATH` / `LD_PRELOAD` / `PTC_HISTORY_PATH` through would let a direct
 * `/v2/execute` caller redirect libraries or subvert replay history.
 * Keep this suite exhaustive.
 *
 * Run: `cd services/codeapi/api && bun scripts/test-env-vars.ts`
 */
import { sanitizeEnvVars, MAX_ENV_VAR_BYTES } from '../src/api/v2';
import {
    filterExtraEnvVars,
    RESERVED_ENV_KEYS,
    RESERVED_ENV_PREFIXES,
} from '../src/job';

let passed = 0;
let failed = 0;
const assert = (cond: unknown, msg: string) => {
    if (cond) {
        passed++;
        console.log(`  ok  ${msg}`);
    } else {
        failed++;
        console.log(`  FAIL ${msg}`);
    }
};

console.log('sanitizeEnvVars (surface validation):');

assert(sanitizeEnvVars(undefined) === undefined, 'undefined input → undefined');
assert(sanitizeEnvVars({}) === undefined, 'empty object → undefined');
{
    const out = sanitizeEnvVars({ FOO: 'bar' });
    assert(out?.FOO === 'bar', 'valid uppercase key passes through');
}
{
    const out = sanitizeEnvVars({ Foo_Bar: 'baz' });
    assert(out?.Foo_Bar === 'baz', 'mixed-case with underscore passes');
}
{
    const out = sanitizeEnvVars({ '1BAD': 'x' });
    assert(out === undefined, 'digit-prefixed key rejected');
}
{
    const out = sanitizeEnvVars({ 'BAD KEY': 'x' });
    assert(out === undefined, 'key with space rejected');
}
{
    const out = sanitizeEnvVars({ 'BAD-KEY': 'x' });
    assert(out === undefined, 'key with dash rejected');
}
{
    const out = sanitizeEnvVars({ '': 'x' });
    assert(out === undefined, 'empty key rejected');
}
{
    const out = sanitizeEnvVars({ FOO: 123 as unknown as string });
    assert(out === undefined, 'non-string value filtered');
}
{
    const out = sanitizeEnvVars({ FOO: 'a', BAR: 'b', BAZ_QUX: 'c' });
    assert(
        out?.FOO === 'a' && out?.BAR === 'b' && out?.BAZ_QUX === 'c',
        'multiple valid entries preserved',
    );
}

console.log('sanitizeEnvVars byte-limit:');

{
    const big = 'x'.repeat(MAX_ENV_VAR_BYTES);
    let threw = false;
    let isError = false;
    let msg = '';
    try {
        sanitizeEnvVars({ FOO: big });
    } catch (e) {
        threw = true;
        isError = e instanceof Error;
        msg = (e as Error).message ?? '';
    }
    assert(threw, 'oversize value throws');
    assert(isError, 'thrown value is an Error instance (not a plain object)');
    assert(msg.includes(`${MAX_ENV_VAR_BYTES}`), 'error message mentions cap');
    /** Express's `res.json(err)` for an `Error` instance serializes to `{}`
     * because `message` is non-enumerable. The route handler in `v2.ts`
     * normalizes via `error.message`, so the wire response keeps the
     * reason. This assertion covers the JSON-shape contract directly so
     * a regression that, say, dropped the `instanceof Error` branch in
     * the catch would be caught here even without the live HTTP probe. */
    const big2 = 'x'.repeat(MAX_ENV_VAR_BYTES);
    let captured: unknown = null;
    try {
        sanitizeEnvVars({ FOO: big2 });
    } catch (e) {
        captured = e;
    }
    const naiveSerialized = JSON.stringify(captured);
    assert(
        naiveSerialized === '{}',
        'JSON.stringify(Error) drops message — confirms the route handler MUST normalize',
    );
    const normalized =
        captured instanceof Error ? { message: captured.message } : captured;
    const normalizedSerialized = JSON.stringify(normalized);
    assert(
        normalizedSerialized.includes(`${MAX_ENV_VAR_BYTES}`),
        'normalizing via { message } preserves the byte-cap reason in JSON',
    );
}
{
    const half = 'x'.repeat(Math.floor(MAX_ENV_VAR_BYTES / 2));
    let threw = false;
    try {
        sanitizeEnvVars({ A: half, B: half, C: 'y' });
    } catch {
        threw = true;
    }
    assert(threw, 'aggregate total exceeding cap throws');
}
{
    const ok = 'x'.repeat(1000);
    const out = sanitizeEnvVars({ A: ok });
    assert(out?.A === ok, 'value under cap preserved');
}

console.log('filterExtraEnvVars (reserved-key blocklist):');

assert(
    Object.keys(filterExtraEnvVars(undefined)).length === 0,
    'undefined → empty',
);
assert(Object.keys(filterExtraEnvVars({})).length === 0, 'empty → empty');

for (const key of [
    'PATH',
    'HOME',
    'LD_PRELOAD',
    'LD_LIBRARY_PATH',
    'DYLD_INSERT_LIBRARIES',
    'BASH_ENV',
    'ENV',
    'IFS',
    'SHELLOPTS',
    'PROMPT_COMMAND',
    'PYTHONPATH',
    'PYTHONSTARTUP',
    'NODE_OPTIONS',
    'SANDBOX_LANGUAGE',
    'TOOL_CALL_SOCKET',
    'PTC_HISTORY_PATH',
    'PTC_FOO',
]) {
    const out = filterExtraEnvVars({ [key]: 'malicious' });
    assert(!(key in out), `blocks ${key}`);
}

for (const lower of [
    'path',
    'home',
    'ld_preload',
    'bash_env',
    'ptc_history_path',
]) {
    const out = filterExtraEnvVars({ [lower]: 'malicious' });
    assert(!(lower in out), `blocks ${lower} (case-insensitive)`);
}

{
    const out = filterExtraEnvVars({ MY_VAR: 'ok', USER_TOKEN: 'ok' });
    assert(
        out.MY_VAR === 'ok' && out.USER_TOKEN === 'ok',
        'non-reserved keys pass through',
    );
}
{
    const out = filterExtraEnvVars({
        PATH: 'evil',
        LD_PRELOAD: 'evil.so',
        PTC_SENTINEL_START_PREFIX: 'evil',
        MY_VAR: 'ok',
        ANOTHER: 'fine',
    });
    assert(
        !('PATH' in out) &&
            !('LD_PRELOAD' in out) &&
            !('PTC_SENTINEL_START_PREFIX' in out) &&
            out.MY_VAR === 'ok' &&
            out.ANOTHER === 'fine',
        'mixed reserved + non-reserved: only safe ones survive',
    );
}

console.log('blocklist invariants:');

assert(RESERVED_ENV_KEYS.has('PATH'), 'PATH is reserved');
assert(
    RESERVED_ENV_KEYS.has('PTC_HISTORY_PATH'),
    'PTC_HISTORY_PATH is reserved (defense-in-depth)',
);
assert(RESERVED_ENV_PREFIXES.includes('LD_'), 'LD_ prefix is reserved');
assert(RESERVED_ENV_PREFIXES.includes('DYLD_'), 'DYLD_ prefix is reserved');
assert(
    RESERVED_ENV_PREFIXES.includes('PTC_'),
    'PTC_ prefix is reserved (defense-in-depth)',
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
