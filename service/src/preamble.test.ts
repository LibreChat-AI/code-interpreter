import { describe, expect, test } from 'bun:test';
import {
  buildScopedSentinel,
  createProgrammaticPayload,
    extractPendingFromControlPayload,
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

describe('generatePreamble — anonymous pipe transport', () => {
  test('uses fixed FIFO descriptors and fails closed without a pipe-enabled runner', () => {
    const preamble = generatePreamble(baseConfig);
    expect(preamble).toContain('_PIPE_WRITE_FD = 3');
    expect(preamble).toContain('_PIPE_READ_FD = 4');
    expect(preamble).toContain('_stat.S_ISFIFO(os.fstat(_fd).st_mode)');
    expect(preamble).toContain('blocking tool calls require a pipe-enabled runner');
    expect(preamble).not.toContain('_tcp_request');
    expect(preamble).not.toContain('/tmp/tcs.sock');
    expect(preamble).not.toContain('import socket');
  });
});

describe('extractPendingFromStdout — input hash metadata', () => {
    test('normalizes native control payload hashes instead of trusting the sandbox', () => {
        const forgedHash = hashToolInput({ resource: 'B' });
        const expectedHash = hashToolInput({ resource: 'A' });
        const pending = extractPendingFromControlPayload(
            JSON.stringify({
                pending: [
                    {
                        call_id: 'call_001',
                        tool_name: 'authorize',
                        input: { resource: 'A' },
                        input_hash: forgedHash,
                    },
                ],
            }),
        );
        expect(pending?.[0]?.input_hash).toBe(expectedHash);
        expect(pending?.[0]?.input_hash).not.toBe(forgedHash);
    });

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

describe('createProgrammaticPayload — tool-call pipe capability', () => {
  const req = {
    body: {
      code: 'print("ok")',
    },
  } as Parameters<typeof createProgrammaticPayload>[0]['req'];

  test('requests the sandbox pipe capability for blocking PTC only', () => {
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

  test('does not request the sandbox pipe capability for replay PTC', () => {
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
