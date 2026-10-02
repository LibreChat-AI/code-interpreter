/**
 * Canonical names of the coding tools the LLM sees, plus the tool-name sets
 * the harness keys behavior off. Ported from `Constants` in
 * `@librechat/agents` (`src/common/enum.ts`) with the same member names so
 * an import swap is mechanical; only the coding-tool members live here.
 *
 * The string values are wire-level tool names — consumer UIs (most
 * importantly LibreChat's `getToolIconType`) match against them, so a rename
 * here is a breaking change for every consumer.
 */

/** Canonical coding tool names as the LLM and consumer UIs see them. */
export enum ToolNames {
    EXECUTE_CODE = 'execute_code',
    PROGRAMMATIC_TOOL_CALLING = 'run_tools_with_code',
    READ_FILE = 'read_file',
    BASH_TOOL = 'bash_tool',
    BASH_PROGRAMMATIC_TOOL_CALLING = 'run_tools_with_bash',
    WRITE_FILE = 'write_file',
    EDIT_FILE = 'edit_file',
    GREP_SEARCH = 'grep_search',
    GLOB_SEARCH = 'glob_search',
    LIST_DIRECTORY = 'list_directory',
    COMPILE_CHECK = 'compile_check',
}

/** Response format for tools that return content plus a structured artifact. */
export const CONTENT_AND_ARTIFACT = 'content_and_artifact';

/** Tool names that use the code execution environment (shared session, file tracking). */
export const CODE_EXECUTION_TOOLS: ReadonlySet<string> = new Set([
    ToolNames.EXECUTE_CODE,
    ToolNames.BASH_TOOL,
    ToolNames.PROGRAMMATIC_TOOL_CALLING,
    ToolNames.BASH_PROGRAMMATIC_TOOL_CALLING,
]);

/**
 * Canonical names of the local-engine-specific coding tools — the
 * file/edit/search/typecheck surface that doesn't exist in the remote
 * (sandbox-API) engine. Single source of truth; the per-tool definitions and
 * the harness workspace-policy defaults all key off these.
 *
 * `read_file` is on this list (the remote ReadFile tool is skill/execution
 * output oriented; the local engine's `read_file` is a parallel
 * implementation that shares the canonical name so consumer UIs render both
 * with the same icon).
 */
export const LOCAL_CODING_TOOL_NAMES: readonly string[] = [
    ToolNames.READ_FILE,
    ToolNames.WRITE_FILE,
    ToolNames.EDIT_FILE,
    ToolNames.GREP_SEARCH,
    ToolNames.GLOB_SEARCH,
    ToolNames.LIST_DIRECTORY,
    ToolNames.COMPILE_CHECK,
];

/**
 * Every tool name the local coding bundle exposes — the local-specific tools
 * above plus the bash/code/PTC pair that the local engine wraps around the
 * remote factories. Any addition/removal in the bundle must be accompanied
 * by a deliberate canonical-name update here.
 */
export const LOCAL_CODING_BUNDLE_NAMES: readonly string[] = [
    ...LOCAL_CODING_TOOL_NAMES,
    ToolNames.BASH_TOOL,
    ToolNames.EXECUTE_CODE,
    ToolNames.PROGRAMMATIC_TOOL_CALLING,
    ToolNames.BASH_PROGRAMMATIC_TOOL_CALLING,
];
