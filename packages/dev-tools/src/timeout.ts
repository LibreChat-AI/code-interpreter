import type { JsonSchemaType } from './types.js';
/** Environment variable overriding the default programmatic run timeout. */
const CODE_API_RUN_TIMEOUT_MS_ENV_VAR = 'CODE_API_RUN_TIMEOUT_MS';

export const DEFAULT_CODE_API_RUN_TIMEOUT_MS = 15_000;
export const MIN_CODE_API_RUN_TIMEOUT_MS = 1_000;
export const MAX_CODE_API_RUN_TIMEOUT_SCHEMA_MS = 300_000;

type TimeoutSchema = {
    type: 'integer';
    minimum: number;
    maximum: number;
    default: number;
    description: string;
};

export type ProgrammaticToolCallingJsonSchema = {
    type: 'object';
    properties: {
        intent: JsonSchemaType;
        code: {
            type: 'string';
            minLength: number;
            description: string;
        };
        tool_manifest: {
            type: 'array';
            items: { type: 'string' };
            uniqueItems: true;
            description: string;
        };
        timeout: TimeoutSchema;
    };
    required: readonly ['code'];
};

function normalizeTimeoutMs(value: number | undefined): number | undefined {
    if (value == null || !Number.isFinite(value)) {
        return undefined;
    }

    return Math.max(MIN_CODE_API_RUN_TIMEOUT_MS, Math.floor(value));
}

function parseTimeoutMs(value: string | undefined): number | undefined {
    if (value == null || value.trim() === '') {
        return undefined;
    }

    return normalizeTimeoutMs(Number(value));
}

function formatTimeout(timeoutMs: number): string {
    return timeoutMs % 1000 === 0
        ? `${timeoutMs / 1000} seconds`
        : `${timeoutMs} milliseconds`;
}

export function resolveCodeApiRunTimeoutMs(override?: number): number {
    return (
        normalizeTimeoutMs(override) ??
        parseTimeoutMs(process.env[CODE_API_RUN_TIMEOUT_MS_ENV_VAR]) ??
        DEFAULT_CODE_API_RUN_TIMEOUT_MS
    );
}

export function clampCodeApiRunTimeoutMs(
    timeoutMs: number | undefined,
    maxRunTimeoutMs = resolveCodeApiRunTimeoutMs()
): number {
    const normalizedMaxRunTimeoutMs =
        normalizeTimeoutMs(maxRunTimeoutMs) ?? DEFAULT_CODE_API_RUN_TIMEOUT_MS;
    const normalizedTimeoutMs = normalizeTimeoutMs(timeoutMs);

    if (normalizedTimeoutMs == null) {
        return normalizedMaxRunTimeoutMs;
    }

    return Math.min(normalizedTimeoutMs, normalizedMaxRunTimeoutMs);
}

export function createCodeApiRunTimeoutSchema(
    maxRunTimeoutMs = resolveCodeApiRunTimeoutMs()
): TimeoutSchema {
    const normalizedMaxRunTimeoutMs =
        normalizeTimeoutMs(maxRunTimeoutMs) ?? DEFAULT_CODE_API_RUN_TIMEOUT_MS;
    const normalizedSchemaMaxRunTimeoutMs = Math.max(
        normalizedMaxRunTimeoutMs,
        MAX_CODE_API_RUN_TIMEOUT_SCHEMA_MS
    );
    const formattedTimeout = formatTimeout(normalizedMaxRunTimeoutMs);
    const formattedSchemaMaxTimeout = formatTimeout(
        normalizedSchemaMaxRunTimeoutMs
    );

    return {
        type: 'integer',
        minimum: MIN_CODE_API_RUN_TIMEOUT_MS,
        maximum: normalizedSchemaMaxRunTimeoutMs,
        default: normalizedMaxRunTimeoutMs,
        description:
            'Maximum wall-clock time in milliseconds for one sandbox run or replay iteration. ' +
            'This is not the total multi-round-trip task budget. ' +
            `Default: ${formattedTimeout}. ` +
            'Accepted values above the configured cap are clamped before execution. ' +
            `Schema max: ${formattedSchemaMaxTimeout}. Configured cap: ${formattedTimeout}.`,
    };
}
