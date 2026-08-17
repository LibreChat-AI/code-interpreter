import { describe, expect, test } from 'bun:test';
import {
    buildScopedSentinel,
    createProgrammaticPayload,
    extractPendingFromStdout,
    generatePreamble,
} from './preamble';
import { hashToolInput } from './tool-input-signature';

const baseConfig = {
    callbackUrl: 'http://orchestrator:3112/internal/tool-call',
    callbackToken: 'token-test',
    executionId: 'exec-test',
    tools: [],
};

describe('generatePreamble — Unix-vs-TCP transport gate', () => {
    /* Codex audit follow-up: a path-existence check (`os.path.exists`) on
     * /tmp/tcs.sock was user-spoofable inside the sandbox — in
     * legacy/no-proxy mode, user code could `open('/tmp/tcs.sock', 'w')`
     * and force the next tool call into the unix-socket branch (where
     * connect() then fails with ENOTSOCK) instead of falling back to TCP.
     * The fix probes a real AF_UNIX connect() at preamble import time
     * (before user code runs) and caches the verdict. These tests assert
     * the rendered preamble keeps that property. */

    test('renders a probe that performs an AF_UNIX connect, not a path-existence check', () => {
        const preamble = generatePreamble(baseConfig);
        expect(preamble).toContain('def _probe_tool_call_socket():');
        /* The probe must construct an AF_UNIX socket and call connect(). A
         * file-existence check would not detect a regular file or stale
         * inode planted by the user. */
        expect(preamble).toMatch(/AF_UNIX/);
        expect(preamble).toMatch(/\.connect\(_TOOL_CALL_SOCKET\)/);
        /* Regression guard against reintroducing the user-spoofable check. */
        expect(preamble).not.toMatch(
            /if\s+os\.path\.exists\(_TOOL_CALL_SOCKET\)/,
        );
    });

    test('caches the probe verdict at module load (before user code can plant a spoof)', () => {
        const preamble = generatePreamble(baseConfig);
        /* The probe call must appear at top level of the preamble, NOT
         * inside _do_request. Otherwise a user could plant a regular file
         * at the path between calls and flip the gate per-request. */
        const probeCallIdx = preamble.indexOf(
            '_USE_TOOL_CALL_SOCKET = _probe_tool_call_socket()',
        );
        expect(probeCallIdx).toBeGreaterThan(-1);
        /* _do_request must consult the cached verdict, not re-probe. */
        const doReqMatch = preamble.match(
            /def\s+_do_request[\s\S]*?(?=\ndef\s|\nclass\s|\Z)/,
        );
        expect(doReqMatch).not.toBeNull();
        expect(doReqMatch![0]).toContain('_USE_TOOL_CALL_SOCKET');
        expect(doReqMatch![0]).not.toContain('_probe_tool_call_socket(');
    });

    test('keeps the TCP fallback path for legacy / no-proxy deployments', () => {
        const preamble = generatePreamble(baseConfig);
        /* The fallback must still construct the URL from _CALLBACK_URL and
         * delegate to _tcp_request. Without this, runners without the
         * proxy bind-mount would have no way to reach the orchestrator. */
        const doReqMatch = preamble.match(
            /def\s+_do_request[\s\S]*?(?=\ndef\s|\nclass\s|\Z)/,
        );
        expect(doReqMatch).not.toBeNull();
        expect(doReqMatch![0]).toContain('_CALLBACK_URL + path');
        expect(doReqMatch![0]).toContain('_tcp_request(');
    });

    test('the literal socket path stays inside the preamble, not in os.environ', () => {
        const preamble = generatePreamble(baseConfig);
        /* Hardening item from PR #1648: TOOL_CALL_SOCKET is no longer
         * exported. The path must remain hardcoded so the preamble does
         * not depend on env-var injection. */
        expect(preamble).toContain('_TOOL_CALL_SOCKET = "/tmp/tcs.sock"');
        expect(preamble).not.toMatch(
            /os\.environ\.get\(['"]TOOL_CALL_SOCKET['"]/,
        );
        expect(preamble).not.toMatch(/os\.environ\[['"]TOOL_CALL_SOCKET['"]\]/);
    });
});

describe('extractPendingFromStdout — input hash metadata', () => {
    test('ignores sandbox-supplied input_hash and uses the parsed input hash', () => {
        const executionId = 'exec_hash_guard';
        const { start, end } = buildScopedSentinel(executionId);
        const forgedHash = hashToolInput({ resource: 'B' });
        const expectedHash = hashToolInput({ resource: 'A' });
        const payload = {
            pending: [
                {
                    call_id: 'call_001',
                    tool_name: 'authorize',
                    input: { resource: 'A' },
                    input_hash: forgedHash,
                },
            ],
        };

        const parsed = extractPendingFromStdout(
            `before\n${start}\n${JSON.stringify(payload)}\n${end}\n`,
            executionId,
        );

        expect(parsed.pending).toHaveLength(1);
        expect(parsed.pending?.[0]?.input).toEqual({ resource: 'A' });
        expect(parsed.pending?.[0]?.input_hash).toBe(expectedHash);
        expect(parsed.pending?.[0]?.input_hash).not.toBe(forgedHash);
    });
});

describe('createProgrammaticPayload — tool-call socket opt-in', () => {
    const req = {
        body: {
            code: 'print("ok")',
        },
    } as Parameters<typeof createProgrammaticPayload>[0]['req'];

    test('requests the sandbox socket for blocking PTC only', () => {
        const payload = createProgrammaticPayload({
            req,
            session_id: 'session-blocking',
            execution_id: 'exec-blocking',
            callbackUrl: 'http://egress-gateway:3190',
            callbackToken: 'sealed-token',
            tools: [],
            mode: 'blocking',
        });

        expect(payload.tool_call_socket).toBe(true);
    });

    test('does not request the sandbox socket for replay PTC', () => {
        const payload = createProgrammaticPayload({
            req,
            session_id: 'session-replay',
            execution_id: 'exec-replay',
            tools: [],
            mode: 'replay',
            history: {},
        });

        expect(payload.tool_call_socket).toBeUndefined();
    });
});
