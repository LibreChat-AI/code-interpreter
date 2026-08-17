import { runTelemetryPrivacyGuardTests } from '../../shared/telemetry-test-suite';
import {
    captureTraceCarrier,
    injectTraceHeaders,
    normalizeTracePath,
    traceHttpRequest,
    withTraceContext,
} from './telemetry';

runTelemetryPrivacyGuardTests({
    captureTraceCarrier,
    injectTraceHeaders,
    normalizeTracePath,
    traceHttpRequest,
    withTraceContext,
});
