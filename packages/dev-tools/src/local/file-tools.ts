/**
 * `read_file`, `write_file`, `edit_file`, `grep_search`, `glob_search`,
 * `list_directory` — the LLM-visible surface of the local-engine file/edit/
 * search tools: canonical names (with the harness back-compat aliases),
 * schemas, descriptions, and registry definitions. Ported from
 * `@librechat/agents` (`src/tools/local/LocalCodingTools.ts`), where the
 * descriptions previously lived inline in the tool factories; execution
 * (the workspace filesystem engine, edit strategies, syntax checks) stays
 * harness-native in the agents SDK.
 *
 * The remote engine's parallel `read_file` (skill and code-execution output
 * oriented) lives in `../read-file.js`; both share the canonical name so
 * consumer UIs render them with the same icon.
 */

import { ToolNames, CONTENT_AND_ARTIFACT } from '../constants.js';
import { withIntent } from '../intent.js';
import type { JsonSchemaType, ToolDefinition } from '../types.js';

/**
 * Tool name aliases retained for back-compat with consumers that imported
 * the per-file `Local*ToolName` constants. The canonical names live on
 * `Constants.*` (see `src/common/enum.ts`); these aliases just point at
 * them so a typo upstream gets caught at the type level.
 */
export const LocalWriteFileToolName = ToolNames.WRITE_FILE;
export const LocalEditFileToolName = ToolNames.EDIT_FILE;
export const LocalGrepSearchToolName = ToolNames.GREP_SEARCH;
export const LocalGlobSearchToolName = ToolNames.GLOB_SEARCH;
export const LocalListDirectoryToolName = ToolNames.LIST_DIRECTORY;

export const LocalReadFileToolSchema: JsonSchemaType = withIntent({
    type: 'object',
    properties: {
        path: {
            type: 'string',
            description:
                'Path to a local file, relative to the configured cwd unless absolute paths are allowed.',
        },
        offset: {
            type: 'integer',
            description: 'Optional 1-indexed line offset for large files.',
        },
        limit: {
            type: 'integer',
            description: 'Optional maximum number of lines to return.',
        },
    },
    required: ['path'],
});

export const LocalWriteFileToolSchema: JsonSchemaType = withIntent({
    type: 'object',
    properties: {
        path: {
            type: 'string',
            description:
                'Path to write, relative to the configured cwd unless absolute paths are allowed.',
        },
        content: {
            type: 'string',
            description: 'Complete file contents to write.',
        },
    },
    required: ['path', 'content'],
});

export const LocalEditFileToolSchema: JsonSchemaType = withIntent({
    type: 'object',
    properties: {
        path: {
            type: 'string',
            description:
                'Path to edit, relative to the configured cwd unless absolute paths are allowed.',
        },
        old_text: {
            type: 'string',
            description: 'Exact text to replace. Must appear exactly once.',
        },
        new_text: {
            type: 'string',
            description: 'Replacement text.',
        },
        edits: {
            type: 'array',
            description:
                'Optional batch of exact replacements. Each old_text must appear exactly once in the original file.',
            items: {
                type: 'object',
                properties: {
                    old_text: { type: 'string' },
                    new_text: { type: 'string' },
                },
                required: ['old_text', 'new_text'],
            },
        },
    },
    required: ['path'],
});

export const LocalGrepSearchToolSchema: JsonSchemaType = withIntent({
    type: 'object',
    properties: {
        pattern: {
            type: 'string',
            description: 'Regex pattern to search for.',
        },
        path: {
            type: 'string',
            description: 'Directory or file to search. Defaults to cwd.',
        },
        glob: {
            type: 'string',
            description: 'Optional file glob passed to rg -g.',
        },
        max_results: {
            type: 'integer',
            description: 'Maximum matching lines to return.',
        },
    },
    required: ['pattern'],
});

export const LocalGlobSearchToolSchema: JsonSchemaType = withIntent({
    type: 'object',
    properties: {
        pattern: {
            type: 'string',
            description: 'File glob pattern, for example "src/**/*.ts".',
        },
        path: {
            type: 'string',
            description: 'Directory to search. Defaults to cwd.',
        },
        max_results: {
            type: 'integer',
            description: 'Maximum file paths to return.',
        },
    },
    required: ['pattern'],
});

export const LocalListDirectoryToolSchema: JsonSchemaType = withIntent({
    type: 'object',
    properties: {
        path: {
            type: 'string',
            description: 'Directory to list. Defaults to cwd.',
        },
    },
});

/**
 * Full tool descriptions as the LLM sees them on the bound tools. Ported
 * from the inline factory descriptions in `LocalCodingTools.ts`; previously
 * these strings were not exported and could not be shared with hosts.
 */
export const LocalReadFileToolDescription =
    'Read a local text file from the configured working directory with line numbers. When `attachReadAttachments` is enabled (e.g. images-only), reading an image returns an `image_url` content block so vision-capable models can see the file directly.';

export const LocalWriteFileToolDescription =
    'Create or overwrite a local text file in the configured working directory. Preserves the existing BOM and line endings when overwriting; defaults to LF without BOM for new files. Returns a unified diff of the changes when overwriting.';

export const LocalEditFileToolDescription =
    'Apply exact text replacements to a local file. The matcher tries exact, line-trimmed, whitespace-normalized, and indentation-flexible strategies in order so common LLM whitespace mistakes are recoverable. Each old_text must still match exactly one location. Returns a unified diff of the changes.';

export const LocalGrepSearchToolDescription =
    'Search local files for a regex pattern (ripgrep when available, Node fallback otherwise).';

export const LocalGlobSearchToolDescription =
    'Find local files matching a glob pattern (ripgrep when available, Node fallback otherwise).';

export const LocalListDirectoryToolDescription =
    'List files and directories in a local directory.';

/**
 * Registry definitions for the local file/edit/search tools, shaped like the
 * harness `toolDefinition()` helper output: `parameters` (not the LangChain
 * `schema` option), callable both directly and from programmatic code
 * execution, content-and-artifact response, builtin tool type.
 */
function localToolDefinition(
    name: string,
    description: string,
    parameters: JsonSchemaType
): ToolDefinition {
    return {
        name,
        description,
        parameters,
        allowed_callers: ['direct', 'code_execution'],
        responseFormat: CONTENT_AND_ARTIFACT,
        toolType: 'builtin',
    };
}

export const LocalReadFileToolDefinition: ToolDefinition = localToolDefinition(
    ToolNames.READ_FILE,
    LocalReadFileToolDescription,
    LocalReadFileToolSchema
);

export const LocalWriteFileToolDefinition: ToolDefinition = localToolDefinition(
    LocalWriteFileToolName,
    LocalWriteFileToolDescription,
    LocalWriteFileToolSchema
);

export const LocalEditFileToolDefinition: ToolDefinition = localToolDefinition(
    LocalEditFileToolName,
    LocalEditFileToolDescription,
    LocalEditFileToolSchema
);

export const LocalGrepSearchToolDefinition: ToolDefinition =
    localToolDefinition(
        LocalGrepSearchToolName,
        LocalGrepSearchToolDescription,
        LocalGrepSearchToolSchema
    );

export const LocalGlobSearchToolDefinition: ToolDefinition =
    localToolDefinition(
        LocalGlobSearchToolName,
        LocalGlobSearchToolDescription,
        LocalGlobSearchToolSchema
    );

export const LocalListDirectoryToolDefinition: ToolDefinition =
    localToolDefinition(
        LocalListDirectoryToolName,
        LocalListDirectoryToolDescription,
        LocalListDirectoryToolSchema
    );
