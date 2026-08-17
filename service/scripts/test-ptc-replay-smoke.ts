/* eslint-disable no-console */
/**
 * Smoke test for the replay preamble: compiles the replay preamble + a piece
 * of user code and runs it locally with python3, verifying:
 *   (a) first run (empty history) ends with the PTC sentinel block
 *   (b) re-run with populated history completes and prints expected output
 *   (c) cached error entries raise ToolExecutionError in user code
 *
 * No nsjail/docker required. Run via: `npx ts-node scripts/test-ptc-replay-smoke.ts`
 */
import { execFileSync } from 'child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
    generateReplayPreamble,
    extractPendingFromStdout,
    type LCTool,
} from '../src/preamble';

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

function runPython(
    code: string,
    history: Record<string, unknown>,
): { stdout: string; stderr: string; status: number } {
    const dir = mkdtempSync(join(tmpdir(), 'ptc-py-smoke-'));
    const historyPath = join(dir, 'history.json');
    writeFileSync(historyPath, JSON.stringify(history));
    try {
        const out = execFileSync('python3', ['-c', code], {
            env: { ...process.env, PTC_HISTORY_PATH: historyPath },
            encoding: 'utf-8',
            timeout: 30_000,
        });
        return { stdout: out, stderr: '', status: 0 };
    } catch (err) {
        const e = err as { stdout?: string; stderr?: string; status?: number };
        return {
            stdout: e.stdout ?? '',
            stderr: e.stderr ?? '',
            status: e.status ?? 1,
        };
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

const tools: LCTool[] = [
    {
        name: 'get_weather',
        description: 'Get weather for a city.',
        parameters: {
            type: 'object',
            properties: { city: { type: 'string' } },
            required: ['city'],
        },
    },
    {
        name: 'calculate',
        description: 'Evaluate an expression.',
        parameters: {
            type: 'object',
            properties: { expression: { type: 'string' } },
            required: ['expression'],
        },
    },
];

const SMOKE_EXEC_ID = 'smoke-exec';
const preamble = generateReplayPreamble({ executionId: SMOKE_EXEC_ID, tools });
const extractPending = (s: string) =>
    extractPendingFromStdout(s, SMOKE_EXEC_ID);

function wrapUser(userBody: string): string {
    const indented = userBody
        .split('\n')
        .map(line => (line.trim() === '' ? '' : `    ${line}`))
        .join('\n');
    return (
        preamble +
        '\nasync def __user_main__():\n' +
        indented +
        '\n\nif __name__ == "__main__":\n    import asyncio\n    asyncio.run(__user_main__())\n'
    );
}

// -----------------------------------------------------------------------------
// 1. First run (empty history) with a single tool call -> sentinel emitted.
// -----------------------------------------------------------------------------
console.log('replay preamble smoke:');

{
    const code = wrapUser(`
print("before tool call")
result = await get_weather(city="San Francisco")
print(f"weather result: {result}")
`);
    const { stdout, status } = runPython(code, {});
    const parsed = extractPending(stdout);

    assert(status === 0, 'process exited 0 on cache miss');
    assert(parsed.pending !== null, 'sentinel detected on cache miss');
    assert(
        parsed.pending?.[0]?.call_id === 'call_001',
        'first call uses call_001',
    );
    assert(
        parsed.pending?.[0]?.tool_name === 'get_weather',
        'tool_name propagated',
    );
    assert(
        JSON.stringify(parsed.pending?.[0]?.input) ===
            JSON.stringify({ city: 'San Francisco' }),
        'input propagated',
    );
    assert(
        parsed.stdout.includes('before tool call'),
        'pre-sentinel stdout preserved',
    );
    assert(
        !parsed.stdout.includes('weather result:'),
        'post-sentinel code did not execute',
    );
}

// -----------------------------------------------------------------------------
// 2. Replay with populated history -> completes, code prints final output.
// -----------------------------------------------------------------------------
{
    const code = wrapUser(`
print("before tool call")
result = await get_weather(city="San Francisco")
print(f"weather result: {result['temperature']} degrees, {result['condition']}")
`);
    const history = {
        call_001: {
            result: { temperature: 68, condition: 'foggy' },
            is_error: false,
            received_at: Date.now(),
        },
    };
    const { stdout, stderr, status } = runPython(code, history);
    const parsed = extractPending(stdout);
    if (status !== 0) console.error('  stderr:', stderr);
    assert(status === 0, 'replay exits cleanly');
    assert(parsed.pending === null, 'replay: no sentinel (completed)');
    assert(stdout.includes('before tool call'), 'pre-call stdout on replay');
    assert(
        stdout.includes('weather result: 68 degrees, foggy'),
        'post-call stdout on replay',
    );
}

// -----------------------------------------------------------------------------
// 3. Two sequential calls: run 1 emits call_001, run 2 emits call_002.
// -----------------------------------------------------------------------------
{
    const code = wrapUser(`
a = await get_weather(city="New York")
b = await get_weather(city="London")
print(a, b)
`);

    const first = runPython(code, {});
    const p1 = extractPending(first.stdout);
    assert(
        p1.pending?.[0]?.call_id === 'call_001',
        'seq: first miss = call_001',
    );
    assert(p1.pending?.length === 1, 'seq: one call per round-trip in v1');

    const second = runPython(code, {
        call_001: {
            result: { temperature: 45, condition: 'cloudy' },
            is_error: false,
            received_at: Date.now(),
        },
    });
    const p2 = extractPending(second.stdout);
    assert(
        p2.pending?.[0]?.call_id === 'call_002',
        'seq: second miss = call_002',
    );
    assert(
        Boolean(
            p2.pending?.[0]?.input &&
            (p2.pending[0].input as Record<string, unknown>).city === 'London',
        ),
        'seq: second call has correct input',
    );

    const third = runPython(code, {
        call_001: {
            result: { temperature: 45, condition: 'cloudy' },
            is_error: false,
            received_at: Date.now(),
        },
        call_002: {
            result: { temperature: 52, condition: 'rainy' },
            is_error: false,
            received_at: Date.now(),
        },
    });
    assert(third.status === 0, 'seq: full replay exits 0');
    const p3 = extractPending(third.stdout);
    assert(p3.pending === null, 'seq: full replay completed');
    assert(
        third.stdout.includes("'temperature': 45") &&
            third.stdout.includes("'temperature': 52"),
        'seq: both results printed',
    );
}

// -----------------------------------------------------------------------------
// 4. Cached error result -> raises ToolExecutionError in user code.
// -----------------------------------------------------------------------------
{
    const code = wrapUser(`
try:
    r = await calculate(expression="1/0")
    print(f"unexpected: {r}")
except ToolExecutionError as e:
    print(f"caught: {e}")
`);
    const run1 = runPython(code, {});
    const p1 = extractPending(run1.stdout);
    assert(
        p1.pending?.[0]?.call_id === 'call_001',
        'error: first call emitted',
    );

    const run2 = runPython(code, {
        call_001: {
            result: null,
            is_error: true,
            error_message: 'division by zero',
            received_at: Date.now(),
        },
    });
    assert(
        run2.status === 0,
        'error: replay still exits 0 (exception was caught)',
    );
    assert(
        run2.stdout.includes('caught: division by zero'),
        'error: ToolExecutionError surfaced with error_message',
    );
}

// -----------------------------------------------------------------------------
// 5. No tool calls in user code -> finishes in one run with no sentinel.
// -----------------------------------------------------------------------------
{
    const code = wrapUser(`
total = sum(range(10))
print(f"sum = {total}")
`);
    const { stdout, status } = runPython(code, {});
    const parsed = extractPending(stdout);
    assert(status === 0, 'no-call: exits 0');
    assert(parsed.pending === null, 'no-call: no sentinel');
    assert(
        parsed.stdout.includes('sum = 45'),
        'no-call: user output preserved',
    );
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
