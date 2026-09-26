/**
 * `run_tools_with_bash` — the LLM-visible surface of the remote (Code API)
 * bash programmatic tool calling tool: canonical name, schema (with the
 * runtime-configurable timeout property), description, and the
 * attached-workspace description/schema builders the harness factory applies
 * when the tool runs against a selected persistent workspace. Ported
 * verbatim from `@librechat/agents`
 * (`src/tools/BashProgrammaticToolCalling.ts`); execution stays
 * harness-native in the agents SDK.
 */

import { ToolNames } from './constants.js';
import {
    BASH_SHELL_GUIDANCE,
    CODE_ARTIFACT_PATH_GUIDANCE,
} from './guidance.js';
import { INTENT_PROPERTY } from './intent.js';
import {
    createCodeApiRunTimeoutSchema,
    resolveCodeApiRunTimeoutMs,
} from './timeout.js';
import type { ProgrammaticToolCallingJsonSchema } from './timeout.js';

/** Default programmatic run timeout, resolved from the environment at load. */
const DEFAULT_RUN_TIMEOUT_MS = resolveCodeApiRunTimeoutMs();

const ATTACHED_BASH_DATA_DIRECTORY = '"${LIBRECHAT_CODE_DATA_DIR:-/mnt/data}"';
const ATTACHED_BASH_ARTIFACT_PATH_GUIDANCE =
    `Use ${ATTACHED_BASH_DATA_DIRECTORY} for injected files and generated artifacts. ` +
    'The directory is execution-scoped; the selected workspace is the persistent project root.';

// Description Components
// ============================================================================

const STATELESS_WARNING = `CRITICAL - STATELESS EXECUTION:
Each call is a fresh bash shell. Variables and state do NOT persist between calls.
You MUST complete your entire workflow in ONE code block.
DO NOT split work across multiple calls expecting to reuse variables.`;

const ATTACHED_WORKSPACE_WARNING = `ATTACHED WORKSPACE EXECUTION:
- Commands start in the selected persistent workspace; project file changes persist between calls.
- Each sandbox run is a fresh process, so shell variables, background processes, and temporary execution data do not persist.
- Injected files and generated artifacts use \${LIBRECHAT_CODE_DATA_DIR:-/mnt/data}; do not copy them into the project unless the task requires it.`;

const CORE_RULES = `Rules:
- One call: state does not persist
- Tools are pre-defined as bash functions—DO NOT redefine them
- Each tool function accepts a JSON string argument
- Save tool output with raw=$(tool '{}'); printf '%s\n' "$raw" > /mnt/data/file.json; direct tool > file may be empty
- Tool stdout is normalized to one compact JSON value when possible; parse saved stdout once, then use fromjson? // . only for JSON-string fields
- Only echo/printf output returns to the model
- ${CODE_ARTIFACT_PATH_GUIDANCE}
- ${BASH_SHELL_GUIDANCE}
- timeout caps one sandbox run/replay iteration, not the total multi-round-trip workflow`;

const ADDITIONAL_RULES =
    '- Tool names normalized: hyphens→underscores, reserved words get `_tool` suffix';

const EXAMPLES = `Example (Complete workflow in one call):
  # Query data and process
  data=$(query_database '{"sql": "SELECT * FROM users"}')
  echo "$data" | jq '.[] | .name'

Example (Parallel calls):
  { sf=$(web_search '{"query": "SF weather"}'); printf '%s\n' "$sf" > /mnt/data/sf.json; } &
  { ny=$(web_search '{"query": "NY weather"}'); printf '%s\n' "$ny" > /mnt/data/ny.json; } &
  wait
  echo "SF: $(jq -r . /mnt/data/sf.json)"
  echo "NY: $(jq -r . /mnt/data/ny.json)"`;

const ATTACHED_CORE_RULES = `Rules:
- One call: process state does not persist; project files do
- Tools are pre-defined as bash functions—DO NOT redefine them
- Each tool function accepts a JSON string argument
- Resolve tool calls into variables before changing project files; do not redirect a tool call directly into the project
- Set data_dir=${ATTACHED_BASH_DATA_DIRECTORY}; save generated artifacts there, and write durable project files relative to the working directory
- Tool stdout is normalized to one compact JSON value when possible; parse saved stdout once, then use fromjson? // . only for JSON-string fields
- Only echo/printf output returns to the model
- ${ATTACHED_BASH_ARTIFACT_PATH_GUIDANCE}
- ${BASH_SHELL_GUIDANCE}
- timeout caps one sandbox run/replay iteration, not the total multi-round-trip workflow`;

const ATTACHED_EXAMPLES = `Example (Complete workflow in one call):
  data=$(query_database '{"sql": "SELECT * FROM users"}')
  echo "$data" | jq '.[] | .name'

Example (Parallel calls):
  data_dir=${ATTACHED_BASH_DATA_DIRECTORY}
  { sf=$(web_search '{"query": "SF weather"}'); printf '%s\n' "$sf" > "$data_dir/sf.json"; } &
  { ny=$(web_search '{"query": "NY weather"}'); printf '%s\n' "$ny" > "$data_dir/ny.json"; } &
  wait
  echo "SF: $(jq -r . "$data_dir/sf.json")"
  echo "NY: $(jq -r . "$data_dir/ny.json")"`;

const CODE_PARAM_DESCRIPTION = `Bash code that calls tools programmatically. Tools are available as bash functions.

${STATELESS_WARNING}

Each tool function accepts a JSON string as its argument.
Example: tool_name '{"key": "value"}'

${EXAMPLES}

${CORE_RULES}`;

const TOOL_MANIFEST_DESCRIPTION =
    'Exact registered tool names used by the code. Required when direct-only tools are configured; ' +
    'validated before execution starts. Pass [] when the code calls no tools at all.';

// ============================================================================
// Schema
// ============================================================================

export function createBashProgrammaticToolCallingSchema(
    maxRunTimeoutMs = DEFAULT_RUN_TIMEOUT_MS
): ProgrammaticToolCallingJsonSchema {
    return {
        type: 'object',
        properties: {
            intent: { ...INTENT_PROPERTY },
            code: {
                type: 'string',
                minLength: 1,
                description: CODE_PARAM_DESCRIPTION,
            },
            tool_manifest: {
                type: 'array',
                items: { type: 'string' },
                uniqueItems: true,
                description: TOOL_MANIFEST_DESCRIPTION,
            },
            timeout: createCodeApiRunTimeoutSchema(maxRunTimeoutMs),
        },
        required: ['code'],
    } as const;
}

export const BashProgrammaticToolCallingSchema =
    createBashProgrammaticToolCallingSchema();

export const BashProgrammaticToolCallingName =
    ToolNames.BASH_PROGRAMMATIC_TOOL_CALLING;

export const BashProgrammaticToolCallingDescription = `
Run tools via bash code. Tools are available as bash functions that accept JSON string arguments.

${STATELESS_WARNING}

${CORE_RULES}
${ADDITIONAL_RULES}

When to use: shell pipelines, parallel execution (& and wait), file processing, text manipulation.

${EXAMPLES}
`.trim();

export const BashProgrammaticToolCallingDefinition = {
    name: BashProgrammaticToolCallingName,
    description: BashProgrammaticToolCallingDescription,
    schema: BashProgrammaticToolCallingSchema,
} as const;

/**
 * Composes the bash programmatic tool calling description for the selected
 * execution mode: the attached-workspace variant swaps the stateless
 * warning, core rules, and examples for the persistent-project wording the
 * harness factory applies when the tool runs with a selected workspace.
 */
export function buildBashProgrammaticToolCallingDescription(options?: {
    attachedWorkspace?: boolean;
}): string {
    if (options?.attachedWorkspace !== true) {
        return BashProgrammaticToolCallingDescription;
    }
    return BashProgrammaticToolCallingDescription.replace(
        STATELESS_WARNING,
        ATTACHED_WORKSPACE_WARNING
    )
        .replace(CORE_RULES, ATTACHED_CORE_RULES)
        .replace(EXAMPLES, ATTACHED_EXAMPLES);
}

/**
 * Builds the bash programmatic tool calling schema, applying the
 * attached-workspace code-param description when requested. Mirrors the
 * replacement chain the harness factory applies to the freshly created
 * schema before binding the tool.
 */
export function buildBashProgrammaticToolCallingSchema(options?: {
    attachedWorkspace?: boolean;
    maxRunTimeoutMs?: number;
}): ProgrammaticToolCallingJsonSchema {
    const schema = createBashProgrammaticToolCallingSchema(
        options?.maxRunTimeoutMs
    );
    if (options?.attachedWorkspace === true) {
        schema.properties.code.description = CODE_PARAM_DESCRIPTION.replace(
            STATELESS_WARNING,
            ATTACHED_WORKSPACE_WARNING
        )
            .replace(CORE_RULES, ATTACHED_CORE_RULES)
            .replace(EXAMPLES, ATTACHED_EXAMPLES);
    }
    return schema;
}
