import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import RedisMock from 'ioredis-mock';
import { env } from '../config';
import {
    checkContinuationPreconditions,
    cleanupExecution,
    resetRedisForTests,
    setRedisForTests,
    type ExecutionState,
    type ToolHistoryDelta,
} from './replay-state';

const VALID_RESULT = [{ call_id: 'call_001', result: 'ok' }];
const EMPTY_DELTA: ToolHistoryDelta = {
    serializedByCallId: new Map(),
    newCallIds: [],
    bytesDelta: 0,
};

function replayState(overrides: Partial<ExecutionState> = {}): ExecutionState {
    return {
        execution_id: 'exec_123',
        session_id: 'session_123',
        userId: 'user_123',
        tenantId: 'oss-default',
        apiKeyId: 'key_123',
        startTime: 1778250000000,
        lastActivity: 1778250000000,
        mode: 'replay',
        emittedCallIds: ['call_001'],
        ...overrides,
    };
}

describe('checkContinuationPreconditions', () => {
    test('compares replay continuations against the persisted storage namespace', () => {
        const result = checkContinuationPreconditions({
            state: replayState(),
            results: VALID_RESULT,
            userId: 'user_123',
            apiKeyId: 'key_123',
            tenantId: 'oss-default',
            delta: EMPTY_DELTA,
        });

        expect(result).toEqual({ ok: true });
    });

    test('rejects replay continuations whose storage namespace differs', () => {
        const result = checkContinuationPreconditions({
            state: replayState(),
            results: VALID_RESULT,
            userId: 'user_123',
            apiKeyId: 'key_123',
            tenantId: undefined,
            delta: EMPTY_DELTA,
        });

        expect(result).toEqual({ ok: false, status: 403, error: 'Forbidden' });
    });
});

describe('cleanupExecution', () => {
    let redis: InstanceType<typeof RedisMock>;
    let server: Server;
    let previousToolCallServerUrl: string;
    let requests: string[];

    beforeEach(async () => {
        redis = new RedisMock();
        setRedisForTests(
            redis as unknown as Parameters<typeof setRedisForTests>[0],
        );
        previousToolCallServerUrl = env.TOOL_CALL_SERVER_URL;
        requests = [];

        server = createServer((req, res) => {
            requests.push(`${req.method ?? ''} ${req.url ?? ''}`);
            req.resume();
            res.writeHead(204);
            res.end();
        });
        await new Promise<void>(resolve =>
            server.listen(0, '127.0.0.1', resolve),
        );
        const { port } = server.address() as AddressInfo;
        env.TOOL_CALL_SERVER_URL = `http://127.0.0.1:${port}`;
    });

    afterEach(async () => {
        env.TOOL_CALL_SERVER_URL = previousToolCallServerUrl;
        resetRedisForTests();
        await redis.disconnect();
        await new Promise<void>((resolve, reject) => {
            server.close(error => (error ? reject(error) : resolve()));
        });
    });

    test('blocking cleanup deletes the Tool Call Server session', async () => {
        await cleanupExecution('exec_cleanup_123', 'blocking');

        expect(requests).toContain('DELETE /sessions/exec_cleanup_123');
    });
});
