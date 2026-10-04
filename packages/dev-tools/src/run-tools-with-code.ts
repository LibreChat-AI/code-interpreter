/**
 * `run_tools_with_code` — the LLM-visible surface of the remote (Code API)
 * Python programmatic tool calling tool: canonical name, schema (with the
 * runtime-configurable timeout property), and description. Ported verbatim
 * from `@librechat/agents` (`src/tools/ProgrammaticToolCalling.ts`); the
 * execution client and tool-result replay stay harness-native in the agents
 * SDK.
 */

import { ToolNames } from './constants.js';
import { CODE_ARTIFACT_PATH_GUIDANCE } from './guidance.js';
import { INTENT_PROPERTY } from './intent.js';
import {
    createCodeApiRunTimeoutSchema,
    resolveCodeApiRunTimeoutMs,
} from './timeout.js';
import type { ProgrammaticToolCallingJsonSchema } from './timeout.js';

/** Default programmatic run timeout, resolved from the environment at load. */
const DEFAULT_RUN_TIMEOUT_MS = resolveCodeApiRunTimeoutMs();

// Description Components (Single Source of Truth)
// ============================================================================

const STATELESS_WARNING = `CRITICAL - STATELESS EXECUTION:
Each call is a fresh Python interpreter. Variables, imports, and data do NOT persist between calls.
You MUST complete your entire workflow in ONE code block: query → process → output.
DO NOT split work across multiple calls expecting to reuse variables.`;

const CORE_RULES = `Rules:
- One call: state does not persist
- Auto-wrapped async; use await, no main()/asyncio.run()
- Tools are pre-defined—DO NOT write function definitions
- Call tools with keyword args only (await tool(arg=value), never pass a dict)
- Tool results are decoded Python values (dict/list/str)
- Only print() output returns to the model
- ${CODE_ARTIFACT_PATH_GUIDANCE}
- timeout caps one sandbox run/replay iteration, not the total multi-round-trip workflow`;

const ADDITIONAL_RULES =
    '- Tool names normalized: hyphens→underscores, keywords get `_tool` suffix';

const EXAMPLES = `Example (Complete workflow in one call):
  # Query data
  data = await query_database(sql="SELECT * FROM users")
  # Process it
  df = pd.DataFrame(data)
  summary = df.groupby('region').sum()
  # Output results
  await write_to_sheet(spreadsheet_id=sid, data=summary.to_dict())
  print(f"Wrote {len(summary)} rows")

Example (Parallel calls):
  sf, ny = await asyncio.gather(get_weather(city="SF"), get_weather(city="NY"))
  print(f"SF: {sf}, NY: {ny}")`;

// ============================================================================
// Schema
// ============================================================================

const CODE_PARAM_DESCRIPTION = `Python code that calls tools programmatically. Tools are available as async functions.

${STATELESS_WARNING}

Your code is auto-wrapped in async context. Just write logic with await—no boilerplate needed.

${EXAMPLES}

${CORE_RULES}`;

const TOOL_MANIFEST_DESCRIPTION =
    'Exact registered tool names used by the code. Required when direct-only tools are configured; ' +
    'validated before execution starts. Pass [] when the code calls no tools at all.';

export function createProgrammaticToolCallingSchema(
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

export const ProgrammaticToolCallingSchema =
    createProgrammaticToolCallingSchema();

export const ProgrammaticToolCallingName = ToolNames.PROGRAMMATIC_TOOL_CALLING;

export const ProgrammaticToolCallingDescription = `
Run tools via Python code. Auto-wrapped in async context—just use \`await\` directly.

${STATELESS_WARNING}

${CORE_RULES}
${ADDITIONAL_RULES}

When to use: loops, conditionals, parallel (\`asyncio.gather\`), multi-step pipelines.

${EXAMPLES}
`.trim();

export const ProgrammaticToolCallingDefinition = {
    name: ProgrammaticToolCallingName,
    description: ProgrammaticToolCallingDescription,
    schema: ProgrammaticToolCallingSchema,
} as const;
