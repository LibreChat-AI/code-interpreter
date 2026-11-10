/**
 * Local-engine variants of the programmatic tool calling schemas and
 * descriptions: the local `run_tools_with_code` schema adds a `lang` runtime
 * selector (bash by default) and a local timeout, and the local
 * `run_tools_with_bash` schema swaps the timeout; the descriptions append the
 * local-engine suffix. Ported from `@librechat/agents`
 * (`src/tools/local/LocalProgrammaticToolCalling.ts`); the in-process
 * localhost tool bridge and execution stay harness-native in the agents SDK.
 */

import { ToolNames, CONTENT_AND_ARTIFACT } from '../constants.js';
import type { ToolDefinition } from '../types.js';
import {
    ProgrammaticToolCallingDescription,
    ProgrammaticToolCallingName,
    ProgrammaticToolCallingSchema,
} from '../run-tools-with-code.js';
import {
    BashProgrammaticToolCallingDescription,
    BashProgrammaticToolCallingSchema,
} from '../run-tools-with-bash.js';

/**
 * Local engine configuration fields these schema builders read. The harness
 * `LocalExecutionConfig` is a superset; only `timeoutMs` shapes the schema.
 */
export type LocalProgrammaticToolCallingConfig = {
    timeoutMs?: number;
};

const DEFAULT_TIMEOUT = 60000;
const LOCAL_MIN_TIMEOUT = 1000;
const LOCAL_MAX_TIMEOUT = 300000;

type LocalTimeoutSchema = {
    type: 'integer';
    minimum: number;
    maximum: number;
    default: number;
    description: string;
};

type LocalProgrammaticToolCallingJsonSchema = {
    type: 'object';
    properties: typeof ProgrammaticToolCallingSchema.properties & {
        timeout: LocalTimeoutSchema;
        lang: {
            type: 'string';
            enum: readonly ['py', 'python', 'bash', 'sh'];
            default: 'bash';
            description: string;
        };
    };
    required: readonly ['code'];
};

type LocalBashProgrammaticToolCallingJsonSchema = {
    type: 'object';
    properties: typeof BashProgrammaticToolCallingSchema.properties & {
        timeout: LocalTimeoutSchema;
    };
    required: readonly ['code'];
};

function normalizeLocalTimeout(timeoutMs: number | undefined): number {
    if (timeoutMs == null || !Number.isFinite(timeoutMs)) {
        return DEFAULT_TIMEOUT;
    }

    return Math.max(LOCAL_MIN_TIMEOUT, Math.floor(timeoutMs));
}

function formatLocalTimeout(timeoutMs: number): string {
    return timeoutMs % 1000 === 0
        ? `${timeoutMs / 1000} seconds`
        : `${timeoutMs} milliseconds`;
}

function createLocalTimeoutSchema(timeoutMs?: number): LocalTimeoutSchema {
    const defaultTimeout = normalizeLocalTimeout(timeoutMs);
    const maxTimeout = Math.max(LOCAL_MAX_TIMEOUT, defaultTimeout);
    const formattedDefault = formatLocalTimeout(defaultTimeout);
    const formattedMax = formatLocalTimeout(maxTimeout);

    return {
        type: 'integer',
        minimum: LOCAL_MIN_TIMEOUT,
        maximum: maxTimeout,
        default: defaultTimeout,
        description:
            'Maximum local execution time in milliseconds. ' +
            `Default: ${formattedDefault}. Max: ${formattedMax}.`,
    };
}

export function createLocalProgrammaticToolCallingSchema(
    localConfig: LocalProgrammaticToolCallingConfig = {}
): LocalProgrammaticToolCallingJsonSchema {
    return {
        ...ProgrammaticToolCallingSchema,
        properties: {
            ...ProgrammaticToolCallingSchema.properties,
            timeout: createLocalTimeoutSchema(localConfig.timeoutMs),
            lang: {
                type: 'string',
                enum: ['py', 'python', 'bash', 'sh'],
                default: 'bash',
                description:
                    'Local engine runtime for orchestration code. Defaults to bash; use py/python for Python orchestration.',
            },
        },
    } as const;
}

export function createLocalBashProgrammaticToolCallingSchema(
    localConfig: LocalProgrammaticToolCallingConfig = {}
): LocalBashProgrammaticToolCallingJsonSchema {
    return {
        ...BashProgrammaticToolCallingSchema,
        properties: {
            ...BashProgrammaticToolCallingSchema.properties,
            timeout: createLocalTimeoutSchema(localConfig.timeoutMs),
        },
    } as const;
}

export const LocalProgrammaticToolCallingDescription = `${ProgrammaticToolCallingDescription}\n\nLocal engine: runs bash by default, or Python when \`lang\` is \`py\` or \`python\`, on the host machine and calls tools through an in-process localhost bridge.`;

export const LocalBashProgrammaticToolCallingDescription = `${BashProgrammaticToolCallingDescription}\n\nLocal engine: runs this bash orchestration code on the host machine and calls tools through an in-process localhost bridge.`;

/** Default local-engine definitions: default timeout, bash runtime for the unified tool. */
export const LocalProgrammaticToolCallingDefinition = {
    name: ProgrammaticToolCallingName,
    description: LocalProgrammaticToolCallingDescription,
    schema: createLocalProgrammaticToolCallingSchema(),
} as const;

export const LocalBashProgrammaticToolCallingDefinition = {
    name: ToolNames.BASH_PROGRAMMATIC_TOOL_CALLING,
    description: LocalBashProgrammaticToolCallingDescription,
    schema: createLocalBashProgrammaticToolCallingSchema(),
} as const;
