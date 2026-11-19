# `@librechat/dev-tools`

The LLM-visible surface of the harness-native coding tools: the canonical
tool names, JSON schemas, and descriptions the model sees — `execute_code`,
`bash_tool`, `run_tools_with_code`, `run_tools_with_bash`, `read_file`, and
the local-engine file/edit/search tools (`read_file`, `write_file`,
`edit_file`, `grep_search`, `glob_search`, `list_directory`,
`compile_check`).

This package is the single versioned source of truth for that surface. The
schemas describe the execution environments this service provides, so they
live next to the Code API rather than inside the agent harness:
`@librechat/agents` and LibreChat (BYOM provisioning) both depend on the
definitions without the harness owning them.

## What is here

| Module | Contents |
| --- | --- |
| `constants` | Canonical `ToolNames`, `CONTENT_AND_ARTIFACT`, and the `CODE_EXECUTION_TOOLS` / `LOCAL_CODING_TOOL_NAMES` / `LOCAL_CODING_BUNDLE_NAMES` sets |
| `types` | `JsonSchemaType`, `ToolDefinition` (mirrors the agents SDK's `LCTool`), `AllowedCaller`, `OutcomePatch` |
| `intent` | The intent-label contract embedded in every schema: `INTENT_PROPERTY`, `withIntent`/`withoutIntent`, arg readers/strippers, and outcome resolution |
| `guidance` | Shared `/mnt/data` and bash guidance embedded across schemas and descriptions |
| `timeout` | The programmatic-run `timeout` schema with environment-resolved defaults and clamping |
| `execute-code`, `bash-tool`, `read-file` | Remote (Code API) engine tool surfaces, including the stateful and attached-workspace description/schema builders |
| `run-tools-with-code`, `run-tools-with-bash` | Remote programmatic tool calling surfaces, including attached-workspace builders |
| `local` | Local-engine surfaces: file/edit/search tools, `compile_check`, the local execution descriptions, and the local programmatic tool calling schemas |

Zero runtime dependencies: everything is plain data and pure functions, so
harness, host, and worker consumers pay nothing to read the schemas.

## What is deliberately not here

Execution. The Code API client, `ToolNode` event dispatch, the local
execution engine, tool-result replay, and output shaping (artifact-delivery
warnings, code-session file summaries) remain harness-native in
`@librechat/agents`. This package answers one question: what does the LLM
see? The sibling `@librechat/code` package answers the other side of
provisioning — the worker that turns an operator-owned VM into a stateful,
fenced execution environment.

## Provenance

Ported from `@librechat/agents` (`src/tools/`) with export-name parity so
the harness swap is mechanical. Intentional differences:

- `Constants` tool-name members became `ToolNames` (the agents enum mixes
  orchestration constants; only the coding-tool members moved).
- Schemas that were module-private in the harness (`CompileCheckSchema`, the
  local programmatic tool calling schema builders) are exported here — the
  package's purpose is sharing them.
- Local-engine descriptions that lived inline inside tool factories are
  first-class `Local*ToolDescription` constants.
- `JsonSchemaType` is widened with the JSON-Schema keywords these schemas
  use (`minLength`, `minimum`, `maximum`, `default`, `uniqueItems`) so every
  schema type-checks as written.

Every ported string was verified byte-for-byte against the harness source at
port time; descriptions are prompt surface, so drift is behavior change.

## Usage

```ts
import {
  CodeExecutionToolDefinition,
  LocalCodingBundleNames,
  buildBashExecutionToolDescription,
} from '@librechat/dev-tools';
```

Subpath exports mirror the module list above (`@librechat/dev-tools/local`,
`@librechat/dev-tools/intent`, and so on). Tests pin the canonical names,
required properties, intent-first property ordering, and the
stateful/attached description builders.

## Development

```bash
npm install
npm test
```
