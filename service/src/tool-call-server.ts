import IORedis from 'ioredis';
import { nanoid } from 'nanoid';
import type * as tls from 'tls';
import {
    httpLatencyElapsedSeconds,
    httpLatencyStartMs,
    metricsResponse,
    recordHttpRequest,
    toolCalls,
    toolCallTimeouts,
    toolCallActiveSessions,
} from './metrics';
import {
    internalServiceAuthEnabled,
    isAuthorizedInternalServiceRequest,
} from './internal-service-auth';
import { isRegisteredToolName } from './tool-scope';
import {
    normalizeTracePath,
    shutdownTelemetry,
    withSpan,
    withTraceContext,
} from './telemetry';
import logger from './toolCallServerLogger';
import { redisKeepAliveOptions } from './redis-options';

const INSTANCE_ID = process.env.INSTANCE_ID ?? nanoid();
const PORT = Number(process.env.TOOL_CALL_SERVER_PORT) || 3033;
const REQUEST_TIMEOUT = Number(process.env.TOOL_CALL_REQUEST_TIMEOUT) || 300000; // 5 minutes
const SESSION_EXPIRY = Number(process.env.TOOL_CALL_SESSION_EXPIRY) || 600; // 10 minutes in seconds

if (!internalServiceAuthEnabled()) {
    logger.warn(
        'CODEAPI_INTERNAL_SERVICE_TOKEN is not set; tool-call session management routes are unauthenticated',
    );
}

// Redis connection
const useAltDnsLookup = process.env.REDIS_USE_ALTERNATIVE_DNS_LOOKUP === 'true';

const redis = new IORedis({
    host: process.env.REDIS_HOST ?? 'redis',
    port: Number(process.env.REDIS_PORT) || 6379,
    password: process.env.REDIS_PASSWORD,
    enableReadyCheck: false,
    tls:
        process.env.REDIS_TLS === 'true'
            ? ({
                  rejectUnauthorized: false,
              } as tls.ConnectionOptions)
            : undefined,
    connectTimeout: 10000,
    ...redisKeepAliveOptions(),
    maxRetriesPerRequest: 3,
    retryStrategy(times: number): number {
        const delay = Math.min(times * 500, 2000);
        return delay;
    },
    reconnectOnError(err: Error): boolean {
        const targetError = 'READONLY';
        if (err.message.includes(targetError)) {
            return true;
        }
        return false;
    },
    // Alternative DNS lookup for AWS ElastiCache TLS connections
    ...(useAltDnsLookup
        ? {
              dnsLookup: (
                  address: string,
                  callback: (err: Error | null, addr: string) => void,
              ): void => callback(null, address),
          }
        : {}),
});

redis.on('error', err => {
    logger.error('Redis Client Error', { error: err });
});

redis.on('connect', () => {
    logger.info('Redis Client Connected', {
        host: process.env.REDIS_HOST,
        port: process.env.REDIS_PORT,
    });
});

redis.on('ready', () => {
    logger.info('Redis Client Ready');
});

// Types
interface ToolCallSession {
    execution_id: string;
    session_id: string;
    callback_token: string;
    status: 'running' | 'waiting' | 'completed' | 'error';
    tools: Array<{
        name: string;
        description?: string;
        parameters?: Record<string, unknown>;
    }>;
    created_at: number;
    updated_at: number;
    timeout: number;
}

interface ToolCallRequest {
    call_id: string;
    tool_name: string;
    tool_input: Record<string, unknown>;
    timestamp: number;
}

interface ToolCallResult {
    call_id: string;
    result: unknown;
    is_error: boolean;
    error_message?: string;
    received_at: number;
}

// Helper functions
function jsonResponse(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

function errorResponse(error: string, status = 400): Response {
    return jsonResponse({ error }, status);
}

async function getSession(
    executionId: string,
): Promise<ToolCallSession | null> {
    const data = await redis.get(`tool_call:session:${executionId}`);
    return data != null && data !== '' ? JSON.parse(data) : null;
}

async function setSession(session: ToolCallSession): Promise<void> {
    await redis.set(
        `tool_call:session:${session.execution_id}`,
        JSON.stringify(session),
        'EX',
        SESSION_EXPIRY,
    );
}

// Route handlers
async function handleCreateSession(req: Request): Promise<Response> {
    try {
        const body = (await req.json()) as {
            execution_id: string;
            session_id: string;
            timeout?: number;
            tools?: ToolCallSession['tools'];
        };

        const {
            execution_id,
            session_id,
            timeout = REQUEST_TIMEOUT,
            tools = [],
        } = body;

        if (!execution_id || !session_id) {
            return errorResponse(
                'Missing required fields: execution_id, session_id',
                400,
            );
        }

        const callback_token = nanoid(32);

        const session: ToolCallSession = {
            execution_id,
            session_id,
            callback_token,
            status: 'running',
            tools,
            created_at: Date.now(),
            updated_at: Date.now(),
            timeout,
        };

        await setSession(session);
        toolCallActiveSessions.inc();

        logger.info(`[${INSTANCE_ID}] Session created: ${execution_id}`);

        return jsonResponse({
            success: true,
            execution_id,
            callback_url: `http://localhost:${PORT}`,
            callback_token,
        });
    } catch (error) {
        logger.error('Error creating session:', { error });
        return errorResponse('Internal server error', 500);
    }
}

async function handleGetPending(executionId: string): Promise<Response> {
    try {
        const session = await getSession(executionId);
        if (!session) {
            return errorResponse('Session not found', 404);
        }

        // Get pending calls from Redis list
        const pendingData = await redis.lrange(
            `tool_call:pending:${executionId}`,
            0,
            -1,
        );
        const pendingCalls: ToolCallRequest[] = pendingData.map(d =>
            JSON.parse(d),
        );

        return jsonResponse({
            status: session.status,
            pending_calls: pendingCalls,
            partial_stdout: '',
            partial_stderr: '',
        });
    } catch (error) {
        logger.error('Error getting pending calls:', { error });
        return errorResponse('Internal server error', 500);
    }
}

async function handleSubmitResults(
    executionId: string,
    req: Request,
): Promise<Response> {
    try {
        const session = await getSession(executionId);
        if (!session) {
            return errorResponse('Session not found', 404);
        }

        const body = (await req.json()) as { results: ToolCallResult[] };
        const { results } = body;

        if (!Array.isArray(results)) {
            return errorResponse('Invalid results format', 400);
        }

        let processed = 0;

        // Get all pending calls once
        const pendingData = await redis.lrange(
            `tool_call:pending:${executionId}`,
            0,
            -1,
        );

        for (const result of results) {
            const resultData: ToolCallResult = {
                call_id: result.call_id,
                result: result.result,
                is_error: result.is_error || false,
                error_message: result.error_message,
                received_at: Date.now(),
            };

            // Store result
            await redis.set(
                `tool_call:result:${executionId}:${result.call_id}`,
                JSON.stringify(resultData),
                'EX',
                SESSION_EXPIRY,
            );

            // Publish for waiting subscribers
            await redis.publish(
                `tool_call:result:${executionId}:${result.call_id}`,
                JSON.stringify(resultData),
            );

            // Remove from pending list - find the exact string that was stored
            const pendingToRemove = pendingData.find(p => {
                try {
                    return JSON.parse(p).call_id === result.call_id;
                } catch {
                    return false;
                }
            });

            if (pendingToRemove != null && pendingToRemove !== '') {
                await redis.lrem(
                    `tool_call:pending:${executionId}`,
                    1,
                    pendingToRemove,
                );
                logger.info(
                    `[${INSTANCE_ID}] Removed pending call ${result.call_id} from ${executionId}`,
                );
            }

            processed++;
        }

        // Update session status
        const remainingPending = await redis.llen(
            `tool_call:pending:${executionId}`,
        );
        if (remainingPending === 0) {
            session.status = 'running';
            session.updated_at = Date.now();
            await setSession(session);
        }

        logger.info(
            `[${INSTANCE_ID}] Results submitted for ${executionId}: ${processed} processed`,
        );

        return jsonResponse({ success: true, processed });
    } catch (error) {
        logger.error('Error submitting results:', { error });
        return errorResponse('Internal server error', 500);
    }
}

async function handleGetStatus(executionId: string): Promise<Response> {
    try {
        const session = await getSession(executionId);
        if (!session) {
            return errorResponse('Session not found', 404);
        }

        return jsonResponse({
            status: session.status,
            execution_id: session.execution_id,
            session_id: session.session_id,
            created_at: session.created_at,
            updated_at: session.updated_at,
        });
    } catch (error) {
        logger.error('Error getting status:', { error });
        return errorResponse('Internal server error', 500);
    }
}

async function handleComplete(
    executionId: string,
    req: Request,
): Promise<Response> {
    try {
        const session = await getSession(executionId);
        if (!session) {
            return errorResponse('Session not found', 404);
        }

        const body = (await req.json()) as {
            stdout?: string;
            stderr?: string;
            exit_code?: number;
        };

        const wasActive =
            session.status !== 'completed' && session.status !== 'error';
        session.status = 'completed';
        session.updated_at = Date.now();
        await setSession(session);
        if (wasActive) {
            toolCallActiveSessions.dec();
        }

        // Store completion data
        await redis.set(
            `tool_call:complete:${executionId}`,
            JSON.stringify({
                ...body,
                completed_at: Date.now(),
            }),
            'EX',
            SESSION_EXPIRY,
        );

        logger.info(`[${INSTANCE_ID}] Execution completed: ${executionId}`);

        return jsonResponse({ success: true });
    } catch (error) {
        logger.error('Error marking complete:', { error });
        return errorResponse('Internal server error', 500);
    }
}

async function handleError(
    executionId: string,
    req: Request,
): Promise<Response> {
    try {
        const session = await getSession(executionId);
        if (!session) {
            return errorResponse('Session not found', 404);
        }

        const body = (await req.json()) as {
            error: string;
            error_type?: string;
            stderr?: string;
        };

        const wasActive =
            session.status !== 'completed' && session.status !== 'error';
        session.status = 'error';
        session.updated_at = Date.now();
        await setSession(session);
        if (wasActive) {
            toolCallActiveSessions.dec();
        }

        // Store error data
        await redis.set(
            `tool_call:error:${executionId}`,
            JSON.stringify({
                ...body,
                error_at: Date.now(),
            }),
            'EX',
            SESSION_EXPIRY,
        );

        logger.info(`[${INSTANCE_ID}] Execution error: ${executionId}`);

        return jsonResponse({ success: true });
    } catch (error) {
        logger.error('Error marking error:', { error });
        return errorResponse('Internal server error', 500);
    }
}

async function handleDeleteSession(executionId: string): Promise<Response> {
    try {
        // Check session status before deleting — only decrement if still active
        const session = await getSession(executionId);
        const wasActive =
            session != null &&
            session.status !== 'completed' &&
            session.status !== 'error';

        const keys = await redis.keys(`tool_call:*:${executionId}*`);
        if (keys.length > 0) {
            await redis.del(...keys);
        }

        if (wasActive) {
            toolCallActiveSessions.dec();
        }
        logger.info(
            `[${INSTANCE_ID}] Session deleted: ${executionId}, cleaned ${keys.length} keys`,
        );

        return jsonResponse({ success: true, cleaned_keys: keys.length });
    } catch (error) {
        logger.error('Error deleting session:', { error });
        return errorResponse('Internal server error', 500);
    }
}

async function handleToolCall(req: Request): Promise<Response> {
    try {
        const executionId = req.headers.get('X-Execution-ID') ?? '';
        const callbackToken = req.headers.get('X-Callback-Token') ?? '';
        const callId = req.headers.get('X-Tool-Call-ID') ?? '';

        if (!executionId || !callbackToken || !callId) {
            return errorResponse('Missing required headers', 400);
        }

        const session = await getSession(executionId);
        if (!session) {
            return errorResponse('Session not found', 404);
        }

        if (session.callback_token !== callbackToken) {
            return errorResponse('Invalid callback token', 401);
        }

        const body = (await req.json()) as {
            tool_name: string;
            input: Record<string, unknown>;
        };

        const { tool_name, input } = body;
        if (typeof tool_name !== 'string' || tool_name === '') {
            return errorResponse('Invalid tool name', 400);
        }
        if (!isRegisteredToolName(tool_name, session.tools)) {
            logger.warn(
                `[${INSTANCE_ID}] Rejected unregistered tool call: ${executionId}/${callId} - ${tool_name}`,
            );
            return errorResponse(
                'Tool is not registered for this execution',
                403,
            );
        }

        // Create pending call record
        const toolCall: ToolCallRequest = {
            call_id: callId,
            tool_name,
            tool_input: input,
            timestamp: Date.now(),
        };

        // Add to pending list
        await redis.rpush(
            `tool_call:pending:${executionId}`,
            JSON.stringify(toolCall),
        );

        // Update session status
        session.status = 'waiting';
        session.updated_at = Date.now();
        await setSession(session);

        toolCalls.inc();
        logger.info(
            `[${INSTANCE_ID}] Tool call received: ${executionId}/${callId} - ${tool_name}`,
        );

        // Wait for result (blocking)
        const result = await waitForResult(
            executionId,
            callId,
            session.timeout,
        );

        if (result === null) {
            toolCallTimeouts.inc();
            return jsonResponse(
                {
                    success: false,
                    error: 'timeout',
                    message: 'Tool call timed out waiting for result',
                },
                408,
            );
        }

        return jsonResponse({
            success: true,
            result: result.result,
            is_error: result.is_error,
            error_message: result.error_message,
        });
    } catch (error) {
        logger.error('Error handling tool call:', { error });
        return errorResponse('Internal server error', 500);
    }
}

async function waitForResult(
    executionId: string,
    callId: string,
    timeout: number,
): Promise<ToolCallResult | null> {
    const resultKey = `tool_call:result:${executionId}:${callId}`;
    const startTime = Date.now();
    const pollInterval = 100; // 100ms

    while (Date.now() - startTime < timeout) {
        const result = await redis.get(resultKey);
        if (result != null && result !== '') {
            await redis.del(resultKey); // Consume the result
            return JSON.parse(result);
        }
        await new Promise(resolve => setTimeout(resolve, pollInterval));
    }

    return null;
}

// Health check
async function handleHealth(): Promise<Response> {
    try {
        await redis.ping();
        return jsonResponse({
            status: 'healthy',
            redis: true,
            uptime: process.uptime(),
            instance_id: INSTANCE_ID,
        });
    } catch (error) {
        return jsonResponse(
            {
                status: 'unhealthy',
                redis: false,
                error: (error as Error).message,
            },
            503,
        );
    }
}

// Router
async function routeToolCallRequest(
    req: Request,
): Promise<{ response: Response; route: string }> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    // Health check
    if (path === '/health' && method === 'GET') {
        return { response: await handleHealth(), route: '/health' };
    }

    // Prometheus metrics
    if (path === '/metrics' && method === 'GET') {
        const { body, contentType } = await metricsResponse();
        return {
            response: new Response(body, {
                status: 200,
                headers: { 'Content-Type': contentType },
            }),
            route: '/metrics',
        };
    }

    if (
        (path === '/sessions' || path.startsWith('/sessions/')) &&
        !isAuthorizedInternalServiceRequest(req.headers)
    ) {
        return {
            response: errorResponse('Unauthorized', 401),
            route: '/sessions/*',
        };
    }

    // POST /sessions - Create session
    if (path === '/sessions' && method === 'POST') {
        return { response: await handleCreateSession(req), route: '/sessions' };
    }

    // POST /tool-call - Tool call (blocking)
    if (path === '/tool-call' && method === 'POST') {
        return { response: await handleToolCall(req), route: '/tool-call' };
    }

    // Session-specific routes
    const sessionMatch = path.match(/^\/sessions\/([^/]+)(\/(.+))?$/);
    if (sessionMatch) {
        const executionId = sessionMatch[1];
        const subPath = sessionMatch[3];

        // GET /sessions/:id
        if (!subPath && method === 'GET') {
            return {
                response: await handleGetStatus(executionId),
                route: '/sessions/:executionId',
            };
        }

        // DELETE /sessions/:id
        if (!subPath && method === 'DELETE') {
            return {
                response: await handleDeleteSession(executionId),
                route: '/sessions/:executionId',
            };
        }

        if (subPath === 'pending' && method === 'GET') {
            return {
                response: await handleGetPending(executionId),
                route: '/sessions/:executionId/pending',
            };
        }

        // POST /sessions/:id/results
        if (subPath === 'results' && method === 'POST') {
            return {
                response: await handleSubmitResults(executionId, req),
                route: '/sessions/:executionId/results',
            };
        }

        // GET /sessions/:id/status
        if (subPath === 'status' && method === 'GET') {
            return {
                response: await handleGetStatus(executionId),
                route: '/sessions/:executionId/status',
            };
        }

        // POST /sessions/:id/complete
        if (subPath === 'complete' && method === 'POST') {
            return {
                response: await handleComplete(executionId, req),
                route: '/sessions/:executionId/complete',
            };
        }

        // POST /sessions/:id/error
        if (subPath === 'error' && method === 'POST') {
            return {
                response: await handleError(executionId, req),
                route: '/sessions/:executionId/error',
            };
        }
    }

    return { response: errorResponse('Not found', 404), route: 'unmatched' };
}

async function handleRequest(req: Request): Promise<Response> {
    return withTraceContext(Object.fromEntries(req.headers.entries()), () =>
        withSpan(
            'codeapi.tool_call_server.request',
            {
                'http.request.method': req.method,
                'url.path': normalizeTracePath(new URL(req.url).pathname),
            },
            async span => {
                const start = httpLatencyStartMs();
                let route = 'unmatched';
                try {
                    const { response, route: matchedRoute } =
                        await routeToolCallRequest(req);
                    route = matchedRoute;
                    span.setAttribute(
                        'http.response.status_code',
                        response.status,
                    );
                    span.setAttribute('http.route', route);
                    recordHttpRequest({
                        method: req.method,
                        route,
                        statusCode: response.status,
                        durationSeconds: httpLatencyElapsedSeconds(start),
                    });
                    return response;
                } catch (error) {
                    recordHttpRequest({
                        method: req.method,
                        route,
                        statusCode: 500,
                        durationSeconds: httpLatencyElapsedSeconds(start),
                    });
                    throw error;
                }
            },
            'SERVER',
        ),
    );
}

// Start server
const server = Bun.serve({
    port: PORT,
    fetch: handleRequest,
});

logger.info(`[${INSTANCE_ID}] Tool Call Server running on port ${PORT}`);

// Graceful shutdown
let shuttingDown = false;

async function shutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`[${INSTANCE_ID}] Shutting down...`);
    try {
        server.stop();
        await redis.quit();
        try {
            await shutdownTelemetry();
        } catch (telemetryError) {
            logger.warn(`[${INSTANCE_ID}] OpenTelemetry shutdown failed`, {
                error: telemetryError,
            });
        }
        process.exit(0);
    } catch (error) {
        logger.error(`[${INSTANCE_ID}] Shutdown failed`, { error });
        try {
            await shutdownTelemetry();
        } catch (telemetryError) {
            logger.warn(`[${INSTANCE_ID}] OpenTelemetry shutdown failed`, {
                error: telemetryError,
            });
        }
        process.exit(1);
    }
}

process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());

process.on('uncaughtException', error => {
    logger.error('Uncaught Exception', { error });
});

process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Rejection', { reason, promise });
});

export { server };
