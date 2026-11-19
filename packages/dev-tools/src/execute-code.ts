/**
 * `execute_code` — the LLM-visible surface of the remote (Code API) code
 * execution tool: canonical name, schema, descriptions, and the
 * stateful-session description/schema builders. Ported from
 * `@librechat/agents` (`src/tools/CodeExecutor.ts`); the execution client
 * itself stays harness-native in the agents SDK.
 */

import { ToolNames } from './constants.js';
import { CODE_ARTIFACT_PATH_GUIDANCE } from './guidance.js';
import { INTENT_PROPERTY } from './intent.js';

export const SUPPORTED_LANGUAGES = [
    'py',
    'js',
    'ts',
    'c',
    'cpp',
    'java',
    'php',
    'rs',
    'go',
    'd',
    'f90',
    'r',
    'bash',
] as const;

export const CodeExecutionToolSchema = {
    type: 'object',
    properties: {
        intent: { ...INTENT_PROPERTY },
        lang: {
            type: 'string',
            enum: SUPPORTED_LANGUAGES,
            description:
                'The programming language or runtime to execute the code in.',
        },
        code: {
            type: 'string',
            description: `The complete, self-contained code to execute, without any truncation or minimization.
- The environment is stateless; variables and imports don't persist between executions.
- Prior /mnt/data files are available and can be modified in place.
- ${CODE_ARTIFACT_PATH_GUIDANCE}
- Input code **IS ALREADY** displayed to the user, so **DO NOT** repeat it in your response unless asked.
- Output code **IS NOT** displayed to the user, so **DO** write all desired output explicitly.
- IMPORTANT: You MUST explicitly print/output ALL results you want the user to see.
- py: This is not a Jupyter notebook environment. Use \`print()\` for all outputs.
- py: Matplotlib: Use \`plt.savefig()\` to save plots as files.
- js: use the \`console\` or \`process\` methods for all outputs.
- r: IMPORTANT: No X11 display available. ALL graphics MUST use Cairo library (library(Cairo)).
- Other languages: use appropriate output functions.`,
        },
        args: {
            type: 'array',
            items: { type: 'string' },
            description:
                'Additional arguments to execute the code with. This should only be used if the input code requires additional arguments to run.',
        },
    },
    required: ['lang', 'code'],
} as const;

export const CodeExecutionToolDescription = `
Runs code and returns stdout/stderr output from a stateless execution environment, similar to running scripts in a command-line interface. Each execution is isolated and independent.

Usage:
- No network access available.
- Generated files are automatically delivered; **DO NOT** provide download links.
- ${CODE_ARTIFACT_PATH_GUIDANCE}
- NEVER use this tool to execute malicious code.
`.trim();

/**
 * Statefulness here is FILESYSTEM-tier, not runtime-tier. Executions in a
 * session reuse one warm machine, so `/mnt/data` carries across calls — but
 * every execution is a brand-new interpreter process in a fresh sandbox, so
 * variables and imports never survive. The note must not imply otherwise: a
 * model told its in-memory state persists writes `df = ...` in one call and
 * `df.head()` in the next, then hits a NameError it was told to treat as rare.
 */
export const STATEFUL_ENV_NOTE =
    'Session state: executions in this conversation run on the same warm machine, so files persist between calls — but each execution is a NEW process. Variables, imports, and in-memory data NEVER carry over: every call must re-import and rebuild the state it needs. Only /mnt/data is durable (the machine itself may also be reset at any time), so write anything that must survive there and read it back next call.';

export const StatefulCodeExecutionToolDescription = `
Runs code and returns stdout/stderr output. Executions in this conversation share one warm machine with a persistent /mnt/data, but each execution runs as a separate process (not a notebook-style kernel).

${STATEFUL_ENV_NOTE}

Usage:
- No network access available.
- Generated files are automatically delivered; **DO NOT** provide download links.
- ${CODE_ARTIFACT_PATH_GUIDANCE}
- NEVER use this tool to execute malicious code.
`.trim();

export function buildCodeExecutionToolDescription(opts?: {
    statefulSessions?: boolean;
}): string {
    return opts?.statefulSessions === true
        ? StatefulCodeExecutionToolDescription
        : CodeExecutionToolDescription;
}

const STATELESS_CODE_PARAM_NOTE =
    "The environment is stateless; variables and imports don't persist between executions.";
const STATEFUL_CODE_PARAM_NOTE =
    'Executions in this conversation share one warm machine, so files written to /mnt/data persist between calls. Each execution is a new process: variables and imports do NOT carry over — re-import and reload from /mnt/data every call.';

export function buildCodeExecutionToolSchema(opts?: {
    statefulSessions?: boolean;
}): typeof CodeExecutionToolSchema {
    const note =
        opts?.statefulSessions === true
            ? STATEFUL_CODE_PARAM_NOTE
            : STATELESS_CODE_PARAM_NOTE;
    const codeDescription =
        CodeExecutionToolSchema.properties.code.description.replace(
            STATELESS_CODE_PARAM_NOTE,
            note
        );
    return {
        ...CodeExecutionToolSchema,
        properties: {
            ...CodeExecutionToolSchema.properties,
            code: {
                ...CodeExecutionToolSchema.properties.code,
                description: codeDescription,
            },
        },
    } as typeof CodeExecutionToolSchema;
}

export const CodeExecutionToolName = ToolNames.EXECUTE_CODE;

export const CodeExecutionToolDefinition = {
    name: CodeExecutionToolName,
    description: CodeExecutionToolDescription,
    schema: CodeExecutionToolSchema,
} as const;
