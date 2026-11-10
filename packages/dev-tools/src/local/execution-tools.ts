/**
 * Local-engine variants of the code and bash execution tool descriptions.
 * The local engine reuses the remote schemas (`../execute-code.js`,
 * `../bash-tool.js`) and swaps only the descriptions, because the schema
 * shape is identical while the semantics (local machine, configured
 * working directory, host filesystem) differ. Ported from
 * `@librechat/agents` (`src/tools/local/LocalExecutionTools.ts`); the
 * execution engine stays harness-native in the agents SDK.
 */

export const LocalCodeExecutionToolDescription = `
Runs code on the local machine in the configured working directory. Unlike the remote Code API sandbox, this tool can see the local repository, installed runtimes, environment variables, and filesystem available to the host process.

Usage:
- The remote sandbox API remains the default; this description applies only when local execution mode is enabled.
- Local commands can use the Anthropic sandbox runtime when local.sandbox.enabled=true and @anthropic-ai/sandbox-runtime is installed.
- Commands execute in the local working directory and may modify local files.
- Input code is already displayed to the user, so do not repeat it unless asked.
- Output is not displayed unless you print it explicitly.
`.trim();

export const LocalBashExecutionToolDescription = `
Runs bash commands on the local machine in the configured working directory. Unlike the remote Code API sandbox, this tool can see the local repository, installed tools, environment variables, and filesystem available to the host process.

Usage:
- The remote sandbox API remains the default; this description applies only when local execution mode is enabled.
- Local commands can use the Anthropic sandbox runtime when local.sandbox.enabled=true and @anthropic-ai/sandbox-runtime is installed.
- Commands execute in the local working directory and may modify local files.
- Output is not displayed unless you print it explicitly.
- Prefer project-native commands and inspect files before changing them.
`.trim();
