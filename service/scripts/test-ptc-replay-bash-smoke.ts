/* eslint-disable no-console */
/**
 * Smoke test for the bash replay preamble. Compiles the preamble + user code,
 * writes it to a temp file, runs with bash directly, and verifies:
 *   (a) first run (empty history) emits the PTC sentinel block with pending
 *   (b) re-run with populated history completes and prints captured result
 *   (c) cached error entries cause non-zero exit with stderr message
 *   (d) zero tool calls completes cleanly without a sentinel
 *
 * No nsjail/docker required. Run: `npx ts-node scripts/test-ptc-replay-bash-smoke.ts`
 */
import { execFileSync } from 'child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  extractPendingFromStdout,
  type LCTool,
} from '../src/preamble';
import { generateBashReplayPreamble, generateBashReplayPostamble } from '../src/preamble-bash';
import { hashToolInput } from '../src/tool-input-signature';

let passed = 0;
let failed = 0;
const assert = (cond: unknown, msg: string) => {
  if (cond) { passed++; console.log(`  ok  ${msg}`); }
  else { failed++; console.log(`  FAIL ${msg}`); }
};

interface RunResult { stdout: string; stderr: string; exitCode: number; signal?: string }

function runBash(
  script: string,
  history: Record<string, unknown>,
  timeoutMs = 30_000,
): RunResult {
  const dir = mkdtempSync(join(tmpdir(), 'ptc-bash-smoke-'));
  const file = join(dir, 'main.sh');
  const historyPath = join(dir, 'history.json');
  writeFileSync(file, script, { mode: 0o755 });
  writeFileSync(historyPath, JSON.stringify(history));
  try {
    const out = execFileSync('bash', [file], {
      cwd: dir,
      env: { ...process.env, PTC_HISTORY_PATH: historyPath },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
    });
    return { stdout: out, stderr: '', exitCode: 0 };
  } catch (err: unknown) {
    const e = err as {
      stdout?: Buffer | string;
      stderr?: Buffer | string;
      status?: number;
      signal?: string;
    };
    return {
      stdout: e.stdout ? String(e.stdout) : '',
      stderr: e.stderr ? String(e.stderr) : '',
      exitCode: e.status ?? 1,
      signal: e.signal,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const tools: LCTool[] = [
  {
    name: 'get_weather',
    description: 'Get weather for a city.',
    parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  },
  {
    name: 'calculate',
    description: 'Evaluate an expression.',
    parameters: { type: 'object', properties: { expression: { type: 'string' } }, required: ['expression'] },
  },
];

const BASH_SMOKE_EXEC_ID = 'exec_bash_test';
const preamble = generateBashReplayPreamble({ executionId: BASH_SMOKE_EXEC_ID, tools });
const postamble = generateBashReplayPostamble();
/** Mirror the real `buildBashPayload` assembly (preamble + user code + postamble)
 * so smoke tests exercise the same subshell-wrapped layout as production. */
const assemble = (user: string): string => preamble + user + '\n' + postamble;
const extractPending = (s: string) => extractPendingFromStdout(s, BASH_SMOKE_EXEC_ID);

console.log('bash replay preamble:');

{
  const user = `
result=$(get_weather '{"city":"Paris"}')
echo "Result: $result"
`;
  const r = runBash(assemble(user), {});
  const p = extractPending(r.stdout);
  assert(r.exitCode === 0, 'single: exit 0');
  assert(p.pending !== null && p.pending.length === 1, 'single: one pending call');
  assert(
    Boolean(p.pending?.[0]?.tool_name === 'get_weather'),
    'single: tool_name is get_weather',
  );
  assert(
    Boolean((p.pending?.[0]?.input as { city?: string } | undefined)?.city === 'Paris'),
    'single: input.city is Paris',
  );
  assert(p.pending?.[0]?.call_id === 'call_001', 'single: call_id is call_001');
  assert(
    typeof p.pending?.[0]?.input_hash === 'string' && p.pending[0].input_hash.length === 64,
    'single: bash input_hash metadata emitted',
  );
  assert(typeof p.pending?.[0]?.call_site === 'string', 'single: call_site metadata emitted');
}

{
  const user = `
result=$(get_weather '{"city":"Paris"}')
echo "Got: $result"
count=$(calculate '{"expression":"1+1"}')
echo "Count: $count"
`;

  const r1 = runBash(assemble(user), {});
  const p1 = extractPending(r1.stdout);
  assert(Boolean(p1.pending?.[0]?.call_id === 'call_001'), 'seq: first pending is call_001');

  const history1 = { call_001: { result: { temperature: 68, city: 'Paris' } } };
  const r2 = runBash(assemble(user), history1);
  const p2 = extractPending(r2.stdout);
  assert(Boolean(p2.pending?.[0]?.call_id === 'call_002'), 'seq: second pending is call_002');
  assert(
    Boolean(p2.pending?.[0]?.tool_name === 'calculate'),
    'seq: second pending is calculate',
  );
  assert(
    p2.stdout.includes('Got: {"temperature":68,"city":"Paris"}'),
    'seq: cached result appears in stdout',
  );

  const history2 = {
    ...history1,
    call_002: { result: 2 },
  };
  const r3 = runBash(assemble(user), history2);
  const p3 = extractPending(r3.stdout);
  assert(p3.pending === null, 'seq: third run has no pending');
  assert(p3.stdout.includes('Count: 2'), 'seq: second cached result appears');
}

{
  const user = `
result=$(get_weather '{"city":"Nowhere"}')
echo "UNREACHABLE: $result"
`;
  const history = { call_001: { is_error: true, error_message: 'city not found' } };
  const r = runBash(assemble(user), history);
  assert(r.exitCode === 1, 'error: exit 1');
  assert(r.stderr.includes('city not found'), 'error: stderr contains message');
  assert(!r.stdout.includes('UNREACHABLE'), 'error: aborted before next line');
}

{
  const user = `
echo "hello world"
`;
  const r = runBash(assemble(user), {});
  const p = extractPending(r.stdout);
  assert(r.exitCode === 0, 'no_calls: exit 0');
  assert(p.pending === null, 'no_calls: no pending');
  assert(p.stdout.includes('hello world'), 'no_calls: user output preserved');
}

{
  const user = `
sleep 3 &
echo "AFTER"
`;
  const r = runBash(assemble(user), {}, 1500);
  const p = extractPending(r.stdout);
  assert(r.signal !== 'SIGTERM', 'no_tool_background: did not wait for unrelated job');
  assert(r.exitCode === 0, 'no_tool_background: exit 0');
  assert(p.pending === null, 'no_tool_background: no pending');
  assert(p.stdout.includes('AFTER'), 'no_tool_background: stdout preserved');
}

{
  const user = `
get_weather '{"city":"Tokyo"}'
echo "AFTER"
`;
  const r = runBash(assemble(user), {});
  const p = extractPending(r.stdout);
  assert(p.pending !== null && p.pending.length === 1, 'bare: pending emitted');
  assert(
    Boolean((p.pending?.[0]?.input as { city?: string } | undefined)?.city === 'Tokyo'),
    'bare: correct input',
  );
  assert(!r.stdout.includes('AFTER'), 'bare: aborts after first tool call');
}

{
  const user = `
exec 9>lockfile
get_weather '{"city":"Seoul"}' > weather.json
echo "file=$(cat weather.json)"
`;
  const r1 = runBash(assemble(user), {});
  const p1 = extractPending(r1.stdout);
  assert(r1.exitCode === 0, 'redirect_pending: exit 0');
  assert(p1.pending !== null && p1.pending.length === 1, 'redirect_pending: pending emitted');
  assert(
    Boolean((p1.pending?.[0]?.input as { city?: string } | undefined)?.city === 'Seoul'),
    'redirect_pending: correct input',
  );
  assert(!p1.stdout.includes('file='), 'redirect_pending: aborts before reading file');

  const r2 = runBash(assemble(user), {
    call_001: { result: { temperature: 72, city: 'Seoul' } },
  });
  const p2 = extractPending(r2.stdout);
  assert(r2.exitCode === 0, 'redirect_replay: exit 0');
  assert(p2.pending === null, 'redirect_replay: no pending');
  assert(
    p2.stdout.includes('file={"temperature":72,"city":"Seoul"}'),
    'redirect_replay: redirected file contains tool output',
  );
}

{
  const user = `
get_weather '{"city":"Berlin"}' &
calculate '{"expression":"1+1"}' &
wait
echo "AFTER"
`;
  const r = runBash(assemble(user), {});
  const p = extractPending(r.stdout);
  assert(r.exitCode === 0, 'parallel_pending: exit 0');
  assert(p.pending !== null && p.pending.length === 2, 'parallel_pending: two pending calls emitted as one batch');
  assert(
    Boolean(p.pending?.some(call => call.tool_name === 'get_weather')),
    'parallel_pending: includes get_weather',
  );
  assert(
    Boolean(p.pending?.some(call => call.tool_name === 'calculate')),
    'parallel_pending: includes calculate',
  );
  assert(!r.stdout.includes('AFTER'), 'parallel_pending: aborts before post-wait command');
}

{
  const user = `
get_weather '{"city":"Lisbon"}' &
calculate '{"expression":"2+2"}' &
echo "launched"
`;
  const r = runBash(assemble(user), {});
  const p = extractPending(r.stdout);
  assert(r.exitCode === 0, 'parallel_no_wait: exit 0');
  assert(p.pending !== null && p.pending.length === 2, 'parallel_no_wait: background tool calls emitted as one batch');
  assert(p.stdout.includes('launched'), 'parallel_no_wait: user stdout before implicit join preserved');
  assert(
    Boolean(p.pending?.some(call => call.tool_name === 'get_weather')),
    'parallel_no_wait: includes get_weather',
  );
  assert(
    Boolean(p.pending?.some(call => call.tool_name === 'calculate')),
    'parallel_no_wait: includes calculate',
  );
}

{
  const user = `
FOO=1 get_weather '{"city":"Prague"}' &
BAR=2 calculate '{"expression":"3+4"}' &
echo "assigned"
`;
  const r = runBash(assemble(user), {});
  const p = extractPending(r.stdout);
  assert(r.exitCode === 0, 'assignment_parallel: exit 0');
  assert(p.pending !== null && p.pending.length === 2, 'assignment_parallel: assignment-prefixed tools batch');
  assert(p.stdout.includes('assigned'), 'assignment_parallel: user stdout before implicit join preserved');
  assert(
    Boolean(p.pending?.some(call => call.tool_name === 'get_weather')),
    'assignment_parallel: includes get_weather',
  );
  assert(
    Boolean(p.pending?.some(call => call.tool_name === 'calculate')),
    'assignment_parallel: includes calculate',
  );
}

{
  const user = `
FOO='hello world' get_weather '{"city":"Vienna"}' &
sleep 0.2
echo "quoted assignment mid"
calculate '{"expression":"4+5"}' &
wait
`;
  const r = runBash(assemble(user), {});
  const p = extractPending(r.stdout);
  assert(r.exitCode === 0, 'quoted_assignment_parallel: exit 0');
  assert(p.pending !== null && p.pending.length === 2, 'quoted_assignment_parallel: quoted assignment tools batch');
  assert(p.stdout.includes('quoted assignment mid'), 'quoted_assignment_parallel: intervening stdout preserved');
  assert(
    Boolean(p.pending?.some(call => call.tool_name === 'get_weather')),
    'quoted_assignment_parallel: includes get_weather',
  );
  assert(
    Boolean(p.pending?.some(call => call.tool_name === 'calculate')),
    'quoted_assignment_parallel: includes calculate',
  );
}

{
  const user = `
time get_weather '{"city":"Dublin"}' &
sleep 0.2
echo "time mid"
time calculate '{"expression":"5+6"}' &
wait
`;
  const r = runBash(assemble(user), {});
  const p = extractPending(r.stdout);
  assert(r.exitCode === 0, 'time_parallel: exit 0');
  assert(p.pending !== null && p.pending.length === 2, 'time_parallel: time-prefixed tools batch');
  assert(p.stdout.includes('time mid'), 'time_parallel: intervening stdout preserved');
  assert(
    Boolean(p.pending?.some(call => call.tool_name === 'get_weather')),
    'time_parallel: includes get_weather',
  );
  assert(
    Boolean(p.pending?.some(call => call.tool_name === 'calculate')),
    'time_parallel: includes calculate',
  );
}

{
  const user = `
(get_weather '{"city":"Helsinki"}') &
sleep 0.2
echo "group mid"
(calculate '{"expression":"6+7"}') &
wait
`;
  const r = runBash(assemble(user), {});
  const p = extractPending(r.stdout);
  assert(r.exitCode === 0, 'group_parallel: exit 0');
  assert(p.pending !== null && p.pending.length === 2, 'group_parallel: grouped tool calls batch');
  assert(p.stdout.includes('group mid'), 'group_parallel: intervening stdout preserved');
  assert(
    Boolean(p.pending?.some(call => call.tool_name === 'get_weather')),
    'group_parallel: includes get_weather',
  );
  assert(
    Boolean(p.pending?.some(call => call.tool_name === 'calculate')),
    'group_parallel: includes calculate',
  );
}

{
  const user = `
get_weather '{"city":"Oslo"}' &
sleep 5 &
echo "launched unrelated"
`;
  const r = runBash(assemble(user), {}, 1500);
  const p = extractPending(r.stdout);
  assert(r.signal !== 'SIGTERM', 'unrelated_background: did not wait for unrelated job');
  assert(r.exitCode === 0, 'unrelated_background: exit 0');
  assert(p.pending !== null && p.pending.length === 1, 'unrelated_background: one pending call');
  assert(p.stdout.includes('launched unrelated'), 'unrelated_background: stdout preserved');
  assert(
    Boolean((p.pending?.[0]?.input as { city?: string } | undefined)?.city === 'Oslo'),
    'unrelated_background: pending input is Oslo',
  );
}

{
  const user = `
sleep 0.2 &
result=$(get_weather '{"city":"Madrid"}')
echo "AFTER: $result"
wait
`;
  const r = runBash(assemble(user), {});
  const p = extractPending(r.stdout);
  assert(r.exitCode === 0, 'cmdsub_with_unrelated_job: exit 0');
  assert(p.pending !== null && p.pending.length === 1, 'cmdsub_with_unrelated_job: emits pending immediately');
  assert(
    Boolean((p.pending?.[0]?.input as { city?: string } | undefined)?.city === 'Madrid'),
    'cmdsub_with_unrelated_job: pending input is Madrid',
  );
  assert(!r.stdout.includes('AFTER'), 'cmdsub_with_unrelated_job: aborts before next command');
}

{
  const user = `
get_weather '{"city":"Oslo"}' &
result=$(calculate '{"expression":"2+3"}')
echo "SIDE_EFFECT: $result"
wait
`;
  const r = runBash(assemble(user), {}, 1500);
  const p = extractPending(r.stdout);
  assert(r.signal !== 'SIGTERM', 'mixed_background_cmdsub: did not wait for unrelated work before emitting');
  assert(r.exitCode === 0, 'mixed_background_cmdsub: exit 0');
  assert(p.pending !== null && p.pending.length === 2, 'mixed_background_cmdsub: emits both pending calls');
  assert(
    Boolean(p.pending?.some(call => call.tool_name === 'get_weather')),
    'mixed_background_cmdsub: includes background get_weather',
  );
  assert(
    Boolean(p.pending?.some(call => call.tool_name === 'calculate')),
    'mixed_background_cmdsub: includes command-substitution calculate',
  );
  assert(!p.stdout.includes('SIDE_EFFECT'), 'mixed_background_cmdsub: aborts before command-substitution side effect');
}

{
  const user = `
sleep 5 &
result=\`get_weather '{"city":"Porto"}'\`
echo "AFTER: $result"
wait
`;
  const r = runBash(assemble(user), {}, 1500);
  const p = extractPending(r.stdout);
  assert(r.signal !== 'SIGTERM', 'backtick_cmdsub_with_unrelated_job: did not wait for unrelated job');
  assert(r.exitCode === 0, 'backtick_cmdsub_with_unrelated_job: exit 0');
  assert(p.pending !== null && p.pending.length === 1, 'backtick_cmdsub_with_unrelated_job: emits pending immediately');
  assert(
    Boolean((p.pending?.[0]?.input as { city?: string } | undefined)?.city === 'Porto'),
    'backtick_cmdsub_with_unrelated_job: pending input is Porto',
  );
  assert(!r.stdout.includes('AFTER'), 'backtick_cmdsub_with_unrelated_job: aborts before next command');
}

{
  const initial = `
get_weather '{"city":"Zero","value":-0}' &
wait
`;
  const r1 = runBash(assemble(initial), {});
  const p1 = extractPending(r1.stdout);
  const bashInputHash = p1.pending?.[0]?.input_hash;
  assert(
    typeof bashInputHash === 'string' && bashInputHash.length === 64,
    'bash_hash_replay: first run emits bash-computed hash',
  );

  const user = `
(sleep 0.05; weather=$(get_weather '{"value":-0,"city":"Zero"}'); echo "weather=$weather") &
(calc=$(calculate '{"expression":"1+1"}'); echo "calc=$calc") &
wait
get_weather '{"city":"Rome"}'
`;
  const history = {
    call_001: {
      result: { temperature: 0, city: 'Zero' },
      tool_name: 'get_weather',
      input_hash: bashInputHash,
      received_at: 1,
    },
    call_002: {
      result: 2,
      tool_name: 'calculate',
      input_hash: hashToolInput({ expression: '1+1' }),
      received_at: 1,
    },
  };
  const r2 = runBash(assemble(user), history);
  const p2 = extractPending(r2.stdout);
  assert(r2.exitCode === 0, 'bash_hash_replay: exit 0');
  assert(
    p2.stdout.includes('weather={"temperature":0,"city":"Zero"}'),
    'bash_hash_replay: replay matched bash-computed input hash',
  );
  assert(p2.stdout.includes('calc=2'), 'bash_hash_replay: second result matched');
  assert(Boolean(p2.pending?.[0]?.call_id === 'call_003'), 'bash_hash_replay: next pending call_id is call_003');
}

{
  const user = `
(sleep 0.05; weather=$(get_weather '{"city":"Paris"}'); echo "weather=$weather") &
(calc=$(calculate '{"expression":"1+1"}'); echo "calc=$calc") &
wait
get_weather '{"city":"Rome"}'
`;
  const history = {
    call_001: {
      result: { temperature: 68, city: 'Paris' },
      tool_name: 'get_weather',
      input_hash: hashToolInput({ city: 'Paris' }),
      received_at: 1,
    },
    call_002: {
      result: 2,
      tool_name: 'calculate',
      input_hash: hashToolInput({ expression: '1+1' }),
      received_at: 1,
    },
  };
  const r = runBash(assemble(user), history);
  const p = extractPending(r.stdout);
  assert(r.exitCode === 0, 'parallel_replay: exit 0');
  assert(p.stdout.includes('calc=2'), 'parallel_replay: calculate result matched by tool signature');
  assert(
    p.stdout.includes('weather={"temperature":68,"city":"Paris"}'),
    'parallel_replay: weather result matched by tool signature',
  );
  assert(Boolean(p.pending?.[0]?.call_id === 'call_003'), 'parallel_replay: next pending call_id is call_003');
  assert(
    Boolean((p.pending?.[0]?.input as { city?: string } | undefined)?.city === 'Rome'),
    'parallel_replay: next pending call is Rome weather',
  );
}

{
  // Regression: input past ARG_MAX (~128KB) must still replay from history,
  // not get silently re-issued as a new pending call each run.
  const bigExpr = '1+1;#' + 'x'.repeat(300_000);
  const user = `
result=$(calculate '{"expression":"${bigExpr}"}')
echo "Result: $result"
`;
  const r1 = runBash(assemble(user), {});
  const p1 = extractPending(r1.stdout);
  assert(r1.exitCode === 0, 'large_input: first run exit 0');
  assert(p1.pending?.[0]?.call_id === 'call_001', 'large_input: first pending is call_001');
  assert(
    typeof p1.pending?.[0]?.input_hash === 'string' && p1.pending[0].input_hash.length === 64,
    'large_input: pending carries a hash for the oversized input',
  );

  const history = {
    call_001: {
      result: 'ok-large',
      tool_name: 'calculate',
      input_hash: hashToolInput({ expression: bigExpr }),
      received_at: 1,
    },
  };
  const r2 = runBash(assemble(user), history);
  const p2 = extractPending(r2.stdout);
  assert(r2.exitCode === 0, 'large_input_replay: exit 0');
  assert(p2.pending === null, 'large_input_replay: no pending re-emitted for the same oversized call');
  assert(p2.stdout.includes('Result: "ok-large"'), 'large_input_replay: cached result used instead of re-invoking');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
