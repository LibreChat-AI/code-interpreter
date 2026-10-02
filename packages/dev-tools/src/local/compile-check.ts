/**
 * `compile_check` — the LLM-visible surface of the local-engine typecheck
 * tool: canonical name, schema, description, and registry definition.
 * Ported from `@librechat/agents` (`src/tools/local/CompileCheckTool.ts`),
 * where the schema was module-private and only the definition factory was
 * exported; the toolchain auto-detection and command execution stay
 * harness-native in the agents SDK.
 */

import { ToolNames, CONTENT_AND_ARTIFACT } from '../constants.js';
import { withIntent } from '../intent.js';
import type { JsonSchemaType, ToolDefinition } from '../types.js';

/** Back-compat alias; canonical name lives on `ToolNames.COMPILE_CHECK`. */
export const CompileCheckToolName = ToolNames.COMPILE_CHECK;

export const CompileCheckToolSchema: JsonSchemaType = withIntent({
    type: 'object',
    properties: {
        command: {
            type: 'string',
            description:
                'Optional explicit command to run instead of the auto-detected one. Runs verbatim from the local engine cwd; honours the standard sandbox/AST gate.',
        },
        timeout_ms: {
            type: 'integer',
            description:
                'Optional timeout in milliseconds. Defaults to 120000 (2 min).',
        },
    },
});

export const CompileCheckToolDescription =
    "Run the project's standard typecheck or lint pass and return its output. Auto-detects from project markers (tsconfig.json/package.json -> tsc; Cargo.toml -> cargo check; go.mod -> go vet; pyproject.toml -> mypy or py_compile). Pass `command` to override.";

export const CompileCheckToolDefinition: ToolDefinition = {
    name: CompileCheckToolName,
    description: CompileCheckToolDescription,
    parameters: CompileCheckToolSchema,
    allowed_callers: ['direct', 'code_execution'],
    responseFormat: CONTENT_AND_ARTIFACT,
    toolType: 'builtin',
};
