import {
    ROOT_CONTEXT,
    SpanKind as OtelSpanKind,
    SpanStatusCode,
    context as otelContext,
    propagation,
    trace,
} from '@opentelemetry/api';
import {
    W3CTraceContextPropagator,
    sanitizeAttributes,
} from '@opentelemetry/core';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import {
    defaultResource,
    detectResources,
    envDetector,
    resourceFromAttributes,
} from '@opentelemetry/resources';
import {
    BasicTracerProvider,
    BatchSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { configureTelemetry } from '../../shared/telemetry-core';

configureTelemetry({
    defaultServiceName: 'aiml-codeapi-api',
    otel: {
        ROOT_CONTEXT,
        OtelSpanKind,
        SpanStatusCode,
        otelContext,
        propagation,
        trace,
        W3CTraceContextPropagator,
        sanitizeAttributes,
        OTLPTraceExporter,
        defaultResource,
        detectResources,
        envDetector,
        resourceFromAttributes,
        BasicTracerProvider,
        BatchSpanProcessor,
    },
    resolveServiceName: () => {
        const argv = process.argv.join(' ');
        if (argv.includes('worker-server'))
            return 'aiml-codeapi-service-worker';
        if (argv.includes('egress-gateway'))
            return 'aiml-codeapi-egress-gateway';
        if (argv.includes('tool-call-server'))
            return 'aiml-codeapi-tool-call-server';
        if (argv.includes('file-server')) return 'aiml-codeapi-file-server';
        return 'aiml-codeapi-api';
    },
});

export * from '../../shared/telemetry-core';
