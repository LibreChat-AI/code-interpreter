/**
 * `bash_tool` — the LLM-visible surface of the remote (Code API) bash
 * execution tool: canonical name, schema, the stateless/stateful/
 * attached-workspace description variants, and the tool-output-references
 * guide. Ported from `@librechat/agents` (`src/tools/BashExecutor.ts`);
 * the execution client stays harness-native in the agents SDK.
 */

import { ToolNames } from './constants.js';
import {
    BASH_SHELL_GUIDANCE,
    CODE_ARTIFACT_PATH_GUIDANCE,
} from './guidance.js';
import { INTENT_PROPERTY } from './intent.js';

export const BashExecutionToolSchema = {
    type: 'object',
    properties: {
        intent: { ...INTENT_PROPERTY },
        command: {
            type: 'string',
            description: `The bash command or script to execute.
- The environment is stateless; variables and state don't persist between executions.
- Prior /mnt/data files are available and can be modified in place.
- ${CODE_ARTIFACT_PATH_GUIDANCE}
- ${BASH_SHELL_GUIDANCE}
- Input code **IS ALREADY** displayed to the user, so **DO NOT** repeat it in your response unless asked.
- Output code **IS NOT** displayed to the user, so **DO** write all desired output explicitly.
- IMPORTANT: You MUST explicitly print/output ALL results you want the user to see.
- Use \`echo\`, \`printf\`, or \`cat\` for all outputs.`,
        },
        args: {
            type: 'array',
            items: { type: 'string' },
            description:
                'Additional arguments to execute the command with. This should only be used if the input command requires additional arguments to run.',
        },
    },
    required: ['command'],
} as const;

export const BashExecutionToolDescription = `
Runs bash commands and returns stdout/stderr output from a stateless execution environment, similar to running scripts in a command-line interface. Each execution is isolated and independent.

Usage:
- No network access available.
- Generated files are automatically delivered; **DO NOT** provide download links.
- ${CODE_ARTIFACT_PATH_GUIDANCE}
- ${BASH_SHELL_GUIDANCE}
- NEVER use this tool to execute malicious commands.
`.trim();

/**
 * Bash statefulness is filesystem-tier and scoped to `/mnt/data`. The machine
 * is warm across calls, but each call runs in a fresh sandbox (new process
 * tree + private /tmp), so background processes are reaped when the call ends
 * and anything written outside /mnt/data is discarded. The note must not
 * promise otherwise: a model told background processes survive will start a
 * server in one call and assume it is listening in the next.
 */
export const STATEFUL_BASH_NOTE =
    'Session state: commands in this conversation run on the same warm machine, so files written to /mnt/data persist between calls. Each call runs in a fresh, isolated sandbox: shell variables, the working directory, /tmp, and background processes do NOT survive after the call returns — a process started in one call is terminated when that call ends. Only /mnt/data is durable (the machine itself may also be reset at any time).';

export const StatefulBashExecutionToolDescription = `
Runs bash commands and returns stdout/stderr output. Commands in this conversation share one warm machine with a persistent /mnt/data, but each command runs in its own isolated sandbox (not a persistent shell session).

${STATEFUL_BASH_NOTE}

Usage:
- No network access available.
- Generated files are automatically delivered; **DO NOT** provide download links.
- ${CODE_ARTIFACT_PATH_GUIDANCE}
- ${BASH_SHELL_GUIDANCE}
- NEVER use this tool to execute malicious commands.
`.trim();

export const AttachedWorkspaceBashExecutionToolDescription = `
Runs bash commands in the selected persistent project through an isolated sandbox process.

Usage:
- Project file changes persist between calls; shell variables, background processes, and execution-private temporary files do not.
- Injected files and generated artifacts use \${LIBRECHAT_CODE_DATA_DIR:-/mnt/data}; write durable files to the project root.
- Generated artifacts are automatically delivered; **DO NOT** provide download links.
- ${BASH_SHELL_GUIDANCE}
- NEVER use this tool to execute malicious commands.
`.trim();

/**
 * Supplemental prompt documenting the tool-output reference feature.
 *
 * Hosts should append this (separated by a blank line) to the base
 * {@link BashExecutionToolDescription} only when
 * `RunConfig.toolOutputReferences.enabled` is `true`. When the feature
 * is disabled, including this text would tell the LLM to emit
 * `{{tool0turn0}}` placeholders that pass through unsubstituted and
 * leak into the shell.
 */
export const BashToolOutputReferencesGuide = `
Referencing previous tool outputs:
- Every successful tool result is tagged with a reference key of the form \`tool<idx>turn<turn>\` (e.g., \`tool0turn0\`). The key appears either as a \`[ref: tool0turn0]\` prefix line or, when the output is a JSON object, as a \`_ref\` field on the object.
- To pipe a previous tool output into this tool, embed the placeholder \`{{tool<idx>turn<turn>}}\` literally anywhere in the \`command\` string (or any string arg). It will be substituted with the stored output verbatim before the command runs.
- The substituted value is the original output string (no \`[ref: …]\` prefix, no \`_ref\` key), so it is safe to pipe directly into \`jq\`, \`grep\`, \`awk\`, etc.
- Example (simple ASCII output): \`echo '{{tool0turn0}}' | jq '.foo'\` takes the full output of the first tool from the first turn and pipes it into jq.
- For payloads that may contain quotes, parentheses, backticks, or arbitrary bytes (random/binary data, JSON with embedded quotes, multi-line strings), prefer a quoted-delimiter heredoc over \`echo '…'\`. The heredoc body is not interpreted by the shell, so substituted payloads pass through unchanged.
- Heredoc example: \`wc -c << 'EOF'\\n{{tool0turn0}}\\nEOF\` (the quotes around \`'EOF'\` disable interpolation inside the body).
- Unknown reference keys are left in place and surfaced as \`[unresolved refs: …]\` after the output.
`.trim();

/**
 * Composes the bash tool description, optionally appending the
 * tool-output references guide. Hosts that enable
 * `RunConfig.toolOutputReferences` should pass `enableToolOutputReferences: true`
 * when registering the tool so the LLM learns the `{{…}}` syntax it
 * will actually be able to use.
 */
export function buildBashExecutionToolDescription(options?: {
    enableToolOutputReferences?: boolean;
    statefulSessions?: boolean;
    attachedWorkspace?: boolean;
}): string {
    let base = BashExecutionToolDescription;
    if (options?.attachedWorkspace === true) {
        base = AttachedWorkspaceBashExecutionToolDescription;
    } else if (options?.statefulSessions === true) {
        base = StatefulBashExecutionToolDescription;
    }
    if (options?.enableToolOutputReferences === true) {
        return `${base}\n\n${BashToolOutputReferencesGuide}`;
    }
    return base;
}

const STATELESS_BASH_PARAM_NOTE =
    "The environment is stateless; variables and state don't persist between executions.";
const STATEFUL_BASH_PARAM_NOTE =
    'Files written to /mnt/data persist between calls on the same warm machine. Each call runs in a fresh sandbox: shell variables, cwd, /tmp, and background processes do NOT survive the call. Only /mnt/data is durable.';
const ATTACHED_BASH_PARAM_NOTE =
    'Commands start in the selected persistent project. Project file changes persist, but shell variables, background processes, and execution-private temporary files do not.';
const ATTACHED_BASH_ARTIFACT_PATH_GUIDANCE =
    'Injected files and generated artifacts use `${LIBRECHAT_CODE_DATA_DIR:-/mnt/data}` for this execution only. Write anything needed later into the selected project.';

export function buildBashExecutionToolSchema(opts?: {
    statefulSessions?: boolean;
    attachedWorkspace?: boolean;
}): typeof BashExecutionToolSchema {
    let note = STATELESS_BASH_PARAM_NOTE;
    if (opts?.attachedWorkspace === true) {
        note = ATTACHED_BASH_PARAM_NOTE;
    } else if (opts?.statefulSessions === true) {
        note = STATEFUL_BASH_PARAM_NOTE;
    }
    let commandDescription =
        BashExecutionToolSchema.properties.command.description.replace(
            STATELESS_BASH_PARAM_NOTE,
            note
        );
    if (opts?.attachedWorkspace === true) {
        commandDescription = commandDescription
            .replace(
                '- Prior /mnt/data files are available and can be modified in place.\n',
                ''
            )
            .replace(
                CODE_ARTIFACT_PATH_GUIDANCE,
                ATTACHED_BASH_ARTIFACT_PATH_GUIDANCE
            );
    }
    return {
        ...BashExecutionToolSchema,
        properties: {
            ...BashExecutionToolSchema.properties,
            command: {
                ...BashExecutionToolSchema.properties.command,
                description: commandDescription,
            },
        },
    } as typeof BashExecutionToolSchema;
}

export const BashExecutionToolName = ToolNames.BASH_TOOL;

/**
 * Default bash tool definition using the base description.
 *
 * When `RunConfig.toolOutputReferences.enabled` is `true`, build a
 * reference-aware description with
 * {@link buildBashExecutionToolDescription}
 * (`{ enableToolOutputReferences: true }`) and construct a custom
 * definition using it — using this constant as-is leaves the LLM
 * unaware of the `{{tool<i>turn<n>}}` syntax.
 */
export const BashExecutionToolDefinition = {
    name: BashExecutionToolName,
    description: BashExecutionToolDescription,
    schema: BashExecutionToolSchema,
} as const;
