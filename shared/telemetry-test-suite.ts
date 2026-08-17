import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'events';

type TraceMiddleware = (
    req: EventEmitter & {
        method?: string;
        originalUrl?: string;
        path?: string;
        url?: string;
        headers?: Record<string, string | string[] | undefined>;
    },
    res: EventEmitter & { statusCode?: number },
    next: () => void,
) => void;

type TelemetryTestSubject = {
    captureTraceCarrier: () => Record<string, string>;
    injectTraceHeaders: <T extends Record<string, string>>(
        headers?: T,
    ) => T & Record<string, string>;
    normalizeTracePath: (path: string) => string;
    traceHttpRequest: (name?: string) => TraceMiddleware;
    withTraceContext: <T>(
        carrier: Record<string, string | string[] | undefined> | undefined,
        fn: () => T,
    ) => T;
};

const TRACE_ID = '11111111111111111111111111111111';
const SPAN_ID = '2222222222222222';
const TRACEPARENT = `00-${TRACE_ID}-${SPAN_ID}-01`;

export function runTelemetryPrivacyGuardTests(
    telemetry: TelemetryTestSubject,
): void {
    describe('telemetry privacy guards', () => {
        test('preserves low-cardinality health and metrics paths', () => {
            expect(telemetry.normalizeTracePath('/metrics?token=secret')).toBe(
                '/metrics',
            );
            expect(telemetry.normalizeTracePath('/health?token=secret')).toBe(
                '/health',
            );
            expect(
                telemetry.normalizeTracePath('/v1/health?token=secret'),
            ).toBe('/v1/health');
            expect(telemetry.normalizeTracePath('/ready?token=secret')).toBe(
                '/ready',
            );
            expect(telemetry.normalizeTracePath('/live?token=secret')).toBe(
                '/live',
            );
        });

        test('normalizes session and object identifiers out of trace paths', () => {
            const sessionId = 'session_abcdefghijklmnopqrstuvwxyz';
            const objectId = 'object_abcdefghijklmnopqrstuvwxyz';

            expect(
                telemetry.normalizeTracePath(
                    `/sessions/${sessionId}/objects/${objectId}?download_token=secret`,
                ),
            ).toBe('/sessions/:session/objects/:object');
            expect(
                telemetry.normalizeTracePath(
                    `/sessions/${sessionId}/results?api_key=secret`,
                ),
            ).toBe('/sessions/:session/results');
        });

        test('normalizes egress grant identifiers out of internal trace paths', () => {
            const grantId = 'ceg1_abcdefghijklmnopqrstuvwxyz';

            expect(
                telemetry.normalizeTracePath(
                    `/internal/egress-grants/${grantId}/restore-result`,
                ),
            ).toBe('/internal/egress-grants/:grant/restore-result');
            expect(
                telemetry.normalizeTracePath(
                    `/internal/egress-grants/${grantId}/revoke`,
                ),
            ).toBe('/internal/egress-grants/:grant/revoke');
        });

        test('masks generic long ids and strips query strings from trace paths', () => {
            const secretLikeSegment = 'sk_abcdefghijklmnopqrstuvwxyz1234567890';
            const normalized = telemetry.normalizeTracePath(
                `/download/${secretLikeSegment}/artifact.txt?token=secret`,
            );

            expect(normalized).toBe('/download/:id/artifact.txt');
            expect(normalized).not.toContain(secretLikeSegment);
            expect(normalized).not.toContain('token=secret');
        });

        test('captures only trace context from incoming carriers', () => {
            const captured = telemetry.withTraceContext(
                {
                    traceparent: TRACEPARENT,
                    baggage: 'user_id=secret-user',
                    authorization: 'Bearer secret-token',
                    cookie: 'session=secret-cookie',
                },
                () => telemetry.captureTraceCarrier(),
            );

            expect(captured.traceparent).toStartWith(`00-${TRACE_ID}-`);
            expect(captured).not.toHaveProperty('baggage');
            expect(captured).not.toHaveProperty('authorization');
            expect(captured).not.toHaveProperty('cookie');
        });

        test('injects trace headers without dropping existing non-sensitive headers', () => {
            const headers = telemetry.withTraceContext(
                { traceparent: TRACEPARENT },
                () =>
                    telemetry.injectTraceHeaders({
                        Accept: 'application/json',
                    }),
            );

            expect(headers.Accept).toBe('application/json');
            expect(headers.traceparent).toStartWith(`00-${TRACE_ID}-`);
        });

        test('keeps trace context through downstream request stream callbacks', async () => {
            const req = Object.assign(new EventEmitter(), {
                method: 'POST',
                path: '/v1/execute',
                headers: { traceparent: TRACEPARENT },
            });
            const res = Object.assign(new EventEmitter(), { statusCode: 200 });

            const captured = new Promise<Record<string, string>>(resolve => {
                telemetry.traceHttpRequest('test.http.request')(
                    req,
                    res,
                    () => {
                        req.on('bodyParsed', async () => {
                            await Promise.resolve();
                            resolve(telemetry.captureTraceCarrier());
                        });
                    },
                );
            });

            req.emit('bodyParsed');
            const carrier = await captured;
            res.emit('finish');

            expect(carrier.traceparent).toStartWith(`00-${TRACE_ID}-`);
        });
    });
}
