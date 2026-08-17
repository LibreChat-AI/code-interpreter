import { AsyncLocalStorage } from 'async_hooks';

type AttributeValue = string | number | boolean | null | undefined;
type Attributes = Record<string, AttributeValue>;
type TraceCarrier = Record<string, string | string[] | undefined>;
type SpanKind = 'INTERNAL' | 'SERVER' | 'CLIENT' | 'PRODUCER' | 'CONSUMER';
type OtelAttributeValue =
    string | number | boolean | string[] | number[] | boolean[];
type ContextLike = any;
type SpanLike = any;
type TracerLike = any;
type EventListener = (...args: unknown[]) => unknown;
type TraceEventEmitter = {
    on?: (event: string | symbol, listener: EventListener) => unknown;
    once?: (event: string | symbol, listener: EventListener) => unknown;
    addListener?: (event: string | symbol, listener: EventListener) => unknown;
    prependListener?: (
        event: string | symbol,
        listener: EventListener,
    ) => unknown;
    prependOnceListener?: (
        event: string | symbol,
        listener: EventListener,
    ) => unknown;
    removeListener?: (
        event: string | symbol,
        listener: EventListener,
    ) => unknown;
    off?: (event: string | symbol, listener: EventListener) => unknown;
};
type TelemetryProviderLike = {
    shutdown: () => Promise<void>;
};
type OtelDependencies = {
    ROOT_CONTEXT: ContextLike;
    OtelSpanKind: any;
    SpanStatusCode: { OK: number; ERROR: number };
    otelContext: { active: () => ContextLike };
    propagation: any;
    trace: any;
    W3CTraceContextPropagator: new () => any;
    sanitizeAttributes: any;
    OTLPTraceExporter: new () => any;
    defaultResource: () => any;
    detectResources: (options: { detectors: any[] }) => any;
    envDetector: unknown;
    resourceFromAttributes: (
        attributes: Record<string, OtelAttributeValue>,
    ) => any;
    BasicTracerProvider: new (options: {
        resource: any;
        spanLimits: { attributeValueLengthLimit: number };
        spanProcessors: any[];
    }) => TelemetryProviderLike;
    BatchSpanProcessor: new (exporter: any) => any;
};
type TelemetryConfig = {
    defaultServiceName: string;
    otel: OtelDependencies;
    resolveServiceName?: () => string;
};

export type TelemetrySpan = {
    setAttribute: (key: string, value: AttributeValue) => void;
    setStatus: (status: { code: 'OK' | 'ERROR'; message?: string }) => void;
    recordException: (error: unknown) => void;
    end: () => void;
};

const store = new AsyncLocalStorage<ContextLike>();
const MAX_ATTRIBUTE_LENGTH = 512;
const MAX_TRACESTATE_LENGTH = 512;

let initialized = false;
let tracingInitialized = false;
let tracer: TracerLike | undefined;
let telemetryProvider: TelemetryProviderLike | undefined;
let telemetryShutdownPromise: Promise<void> | undefined;
let telemetryConfig: Omit<TelemetryConfig, 'otel'> = {
    defaultServiceName: 'codeapi',
};
let otelDependencies: OtelDependencies | undefined;

export function configureTelemetry(config: TelemetryConfig): void {
    telemetryConfig = {
        defaultServiceName: config.defaultServiceName,
        resolveServiceName: config.resolveServiceName,
    };
    otelDependencies = config.otel;
    tracer = config.otel.trace.getTracer('codeapi.manual.telemetry');
}

function otel(): OtelDependencies {
    if (!otelDependencies) {
        throw new Error('Telemetry dependencies must be configured before use');
    }
    return otelDependencies;
}

export function positiveInt(raw: string | undefined, fallback: number): number {
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function serviceName(): string {
    const explicit = process.env.OTEL_SERVICE_NAME?.trim();
    if (explicit) return explicit;
    return (
        telemetryConfig.resolveServiceName?.() ??
        telemetryConfig.defaultServiceName
    );
}

function tracingEnabled(): boolean {
    return process.env.OTEL_TRACING_ENABLED === 'true';
}

function runtimeName(): string {
    return typeof Bun !== 'undefined'
        ? `bun/${Bun.version}`
        : `node/${process.version}`;
}

function cleanAttributeValue(value: AttributeValue): AttributeValue {
    if (typeof value === 'number' && !Number.isFinite(value)) return undefined;
    return value;
}

function setCleanAttribute(
    span: SpanLike,
    key: string,
    value: AttributeValue,
): void {
    if (value == null) return;
    const cleanValue = cleanAttributeValue(value);
    if (cleanValue !== undefined) span.setAttribute(key, cleanValue);
}

function cleanAttributes(
    attributes: Attributes,
): Record<string, OtelAttributeValue> {
    const finiteAttributes = Object.fromEntries(
        Object.entries(attributes).flatMap(([key, value]) => {
            if (typeof value === 'number' && !Number.isFinite(value)) return [];
            return [[key, value]];
        }),
    );
    return otel().sanitizeAttributes(finiteAttributes) as Record<
        string,
        OtelAttributeValue
    >;
}

function telemetryResource() {
    const deps = otel();
    return deps
        .defaultResource()
        .merge(deps.detectResources({ detectors: [deps.envDetector] }))
        .merge(
            deps.resourceFromAttributes(
                cleanAttributes({
                    'service.name': serviceName(),
                    'service.instance.id': process.env.INSTANCE_ID,
                    'process.runtime.name': runtimeName(),
                }),
            ),
        );
}

function ensureTelemetryInitialized(): void {
    if (initialized) return;
    initialized = true;
    const deps = otel();
    deps.propagation.setGlobalPropagator(new deps.W3CTraceContextPropagator());

    if (!tracingEnabled()) return;

    const exporter = new deps.OTLPTraceExporter();
    const processor = new deps.BatchSpanProcessor(exporter);
    telemetryProvider = new deps.BasicTracerProvider({
        resource: telemetryResource(),
        spanLimits: {
            attributeValueLengthLimit: MAX_ATTRIBUTE_LENGTH,
        },
        spanProcessors: [processor],
    });
    deps.trace.setGlobalTracerProvider(telemetryProvider);
    tracer = deps.trace.getTracer('codeapi.manual.telemetry');
    tracingInitialized = true;
}

export async function shutdownTelemetry(
    timeoutMillis = positiveInt(process.env.OTEL_SHUTDOWN_TIMEOUT, 3000),
): Promise<void> {
    const provider = telemetryProvider;
    if (!tracingInitialized || !provider) return;

    telemetryShutdownPromise ??= provider.shutdown().finally(() => {
        tracingInitialized = false;
        telemetryProvider = undefined;
    });

    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
            reject(
                new Error(
                    `OpenTelemetry shutdown timed out after ${timeoutMillis}ms`,
                ),
            );
        }, timeoutMillis);
        (timeout as { unref?: () => void }).unref?.();
    });

    try {
        await Promise.race([telemetryShutdownPromise, timeoutPromise]);
    } finally {
        if (timeout) clearTimeout(timeout);
    }
}

function carrierGetter(carrier: TraceCarrier, key: string): string | undefined {
    const value =
        carrier[key] ??
        carrier[key.toLowerCase()] ??
        carrier[key.toUpperCase()];
    if (Array.isArray(value)) return value[0];
    if (key.toLowerCase() === 'tracestate')
        return value?.slice(0, MAX_TRACESTATE_LENGTH);
    return value;
}

function sanitizedCarrier(carrier: TraceCarrier | undefined): TraceCarrier {
    if (!carrier) return {};
    const traceparent = carrierGetter(carrier, 'traceparent');
    const tracestate = carrierGetter(carrier, 'tracestate');
    return {
        ...(traceparent ? { traceparent } : {}),
        ...(tracestate ? { tracestate } : {}),
    };
}

export function extractTraceContext(
    carrier: TraceCarrier | undefined,
): ContextLike {
    ensureTelemetryInitialized();
    const deps = otel();
    return deps.propagation.extract(
        deps.ROOT_CONTEXT,
        sanitizedCarrier(carrier),
        {
            get: carrierGetter,
            keys: (c: TraceCarrier) => Object.keys(c),
        },
    );
}

export function withTraceContext<T>(
    carrier: TraceCarrier | undefined,
    fn: () => T,
): T {
    return store.run(extractTraceContext(carrier), fn);
}

export function captureTraceCarrier(): Record<string, string> {
    ensureTelemetryInitialized();
    const deps = otel();
    const carrier: Record<string, string> = {};
    deps.propagation.inject(store.getStore() ?? deps.ROOT_CONTEXT, carrier);
    return carrier;
}

export function injectTraceHeaders<T extends Record<string, string>>(
    headers?: T,
): T & Record<string, string> {
    return {
        ...((headers ?? {}) as T),
        ...captureTraceCarrier(),
    };
}

export function normalizeTracePath(path: string): string {
    const pathname = path.split('?')[0] || '/';
    if (
        pathname === '/' ||
        pathname === '/metrics' ||
        pathname === '/health' ||
        pathname === '/v1/health' ||
        pathname === '/ready' ||
        pathname === '/live'
    ) {
        return pathname;
    }
    if (pathname.startsWith('/sessions/')) {
        if (/^\/sessions\/[^/]+\/objects\/[^/]+$/.test(pathname))
            return '/sessions/:session/objects/:object';
        if (/^\/sessions\/[^/]+\/objects$/.test(pathname))
            return '/sessions/:session/objects';
        if (
            /^\/sessions\/[^/]+\/(results|status|complete|error)$/.test(
                pathname,
            )
        ) {
            return pathname.replace(
                /^\/sessions\/[^/]+\//,
                '/sessions/:session/',
            );
        }
    }
    if (/^\/internal\/egress-grants\/[^/]+\/restore-result$/.test(pathname)) {
        return '/internal/egress-grants/:grant/restore-result';
    }
    if (/^\/internal\/egress-grants\/[^/]+\/revoke$/.test(pathname)) {
        return '/internal/egress-grants/:grant/revoke';
    }
    return pathname
        .replace(/[0-9a-f]{24,}/gi, ':id')
        .replace(/[A-Za-z0-9_-]{24,}/g, ':id');
}

function otelSpanKind(kind: SpanKind): number {
    const { OtelSpanKind } = otel();
    switch (kind) {
        case 'SERVER':
            return OtelSpanKind.SERVER;
        case 'CLIENT':
            return OtelSpanKind.CLIENT;
        case 'PRODUCER':
            return OtelSpanKind.PRODUCER;
        case 'CONSUMER':
            return OtelSpanKind.CONSUMER;
        default:
            return OtelSpanKind.INTERNAL;
    }
}

function exceptionType(error: unknown): string {
    return error instanceof Error ? error.name : typeof error;
}

function safeStatusMessage(message: string | undefined): string | undefined {
    return message && /^HTTP \d{3}$/.test(message) ? message : undefined;
}

function createSpanFacade(span: SpanLike): TelemetrySpan {
    const { SpanStatusCode } = otel();
    let ended = false;
    let errorStatusSet = false;
    return {
        setAttribute: (key, value) => {
            setCleanAttribute(span, key, value);
        },
        setStatus: status => {
            if (status.code === 'ERROR') {
                errorStatusSet = true;
                span.setStatus({
                    code: SpanStatusCode.ERROR,
                    message: safeStatusMessage(status.message),
                });
                return;
            }
            if (!errorStatusSet) span.setStatus({ code: SpanStatusCode.OK });
        },
        recordException: error => {
            errorStatusSet = true;
            span.recordException?.(
                error instanceof Error ? error : String(error),
            );
            span.setAttribute('exception.type', exceptionType(error));
            span.setStatus({ code: SpanStatusCode.ERROR });
        },
        end: () => {
            if (ended) return;
            ended = true;
            span.end();
        },
    };
}

function bindEmitterToTraceContext(
    emitter: TraceEventEmitter,
    context: ContextLike,
): void {
    const bindings = new WeakMap<EventListener, EventListener>();
    const bindListener = (listener: EventListener): EventListener => {
        const existing = bindings.get(listener);
        if (existing) return existing;
        const bound = function boundTraceListener(
            this: unknown,
            ...args: unknown[]
        ) {
            return store.run(context, () => listener.apply(this, args));
        };
        bindings.set(listener, bound);
        return bound;
    };

    for (const method of [
        'on',
        'once',
        'addListener',
        'prependListener',
        'prependOnceListener',
    ] as const) {
        const original = emitter[method];
        if (!original) continue;
        emitter[method] = function tracedAddListener(
            this: TraceEventEmitter,
            event,
            listener,
        ) {
            return original.call(this, event, bindListener(listener));
        };
    }

    for (const method of ['removeListener', 'off'] as const) {
        const original = emitter[method];
        if (!original) continue;
        emitter[method] = function tracedRemoveListener(
            this: TraceEventEmitter,
            event,
            listener,
        ) {
            return original.call(
                this,
                event,
                bindings.get(listener) ?? listener,
            );
        };
    }
}

function noopSpan(): TelemetrySpan {
    return {
        setAttribute: () => undefined,
        setStatus: () => undefined,
        recordException: () => undefined,
        end: () => undefined,
    };
}

export async function withSpan<T>(
    name: string,
    attributes: Attributes,
    fn: (span: TelemetrySpan) => Promise<T> | T,
    kind: SpanKind = 'INTERNAL',
): Promise<T> {
    ensureTelemetryInitialized();
    if (!tracingInitialized) return fn(noopSpan());

    const deps = otel();
    const activeTracer =
        tracer ?? deps.trace.getTracer('codeapi.manual.telemetry');
    const parentContext = store.getStore() ?? deps.otelContext.active();
    const span = activeTracer.startSpan(
        name,
        {
            attributes: cleanAttributes(attributes),
            kind: otelSpanKind(kind),
        },
        parentContext,
    );
    const spanContext = deps.trace.setSpan(parentContext, span);
    const telemetrySpan = createSpanFacade(span);

    return store.run(spanContext, async () => {
        try {
            const result = await fn(telemetrySpan);
            telemetrySpan.setStatus({ code: 'OK' });
            return result;
        } catch (error) {
            telemetrySpan.recordException(error);
            throw error;
        } finally {
            telemetrySpan.end();
        }
    });
}

export function traceHttpRequest(name = 'codeapi.http.request') {
    return (
        req: TraceEventEmitter & {
            method?: string;
            originalUrl?: string;
            path?: string;
            url?: string;
            headers?: TraceCarrier;
        },
        res: TraceEventEmitter & {
            statusCode?: number;
        },
        next: () => void,
    ): void => {
        const parentContext = extractTraceContext(req.headers);
        const deps = otel();
        const route = normalizeTracePath(
            req.path ?? req.originalUrl ?? req.url ?? '/',
        );
        if (!tracingInitialized) {
            store.run(parentContext, () => {
                bindEmitterToTraceContext(req, parentContext);
                bindEmitterToTraceContext(res, parentContext);
                next();
            });
            return;
        }

        const activeTracer =
            tracer ?? deps.trace.getTracer('codeapi.manual.telemetry');
        const span = activeTracer.startSpan(
            name,
            {
                attributes: cleanAttributes({
                    'http.request.method': req.method ?? 'UNKNOWN',
                    'url.path': route,
                }),
                kind: deps.OtelSpanKind.SERVER,
            },
            parentContext,
        );
        const context = deps.trace.setSpan(parentContext, span);
        const telemetrySpan = createSpanFacade(span);
        let finished = false;
        const finish = (): void => {
            if (finished) return;
            finished = true;
            const statusCode = res.statusCode ?? 0;
            telemetrySpan.setAttribute('http.response.status_code', statusCode);
            if (statusCode >= 500)
                telemetrySpan.setStatus({
                    code: 'ERROR',
                    message: `HTTP ${statusCode}`,
                });
            else telemetrySpan.setStatus({ code: 'OK' });
            telemetrySpan.end();
        };

        store.run(context, () => {
            bindEmitterToTraceContext(req, context);
            bindEmitterToTraceContext(res, context);
            if (res.once) {
                res.once('finish', finish);
                res.once('close', finish);
            } else {
                res.on?.('finish', finish);
                res.on?.('close', finish);
            }
            next();
        });
    };
}
