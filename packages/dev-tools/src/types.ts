/**
 * Minimal, dependency-free types for the coding tool surface.
 *
 * `ToolDefinition` mirrors `LCTool` from `@librechat/agents` so definitions
 * exported here register with the harness unmodified. `JsonSchemaType` is
 * that SDK's schema type widened with the JSON-Schema keywords these tool
 * schemas actually use (`minLength`, `minimum`, `maximum`, `default`,
 * `uniqueItems`) so every schema in this package type-checks as written.
 */

/** JSON-Schema fragment used for tool parameters and their properties. */
export type JsonSchemaType = {
    type:
        | 'string'
        | 'number'
        | 'integer'
        | 'float'
        | 'boolean'
        | 'array'
        | 'object';
    enum?: string[];
    items?: JsonSchemaType;
    properties?: Record<string, JsonSchemaType>;
    required?: string[];
    description?: string;
    additionalProperties?: boolean | JsonSchemaType;
    minLength?: number;
    minimum?: number;
    maximum?: number;
    default?: number | string;
    uniqueItems?: boolean;
};

/** Specifies which contexts can invoke a tool (inspired by Anthropic's allowed_callers). */
export type AllowedCaller = 'direct' | 'code_execution';

/** Response format for tool output. */
export type ToolResponseFormat = 'content' | 'content_and_artifact';

/** Tool definition as registered with the harness. Mirrors `LCTool`. */
export type ToolDefinition = {
    name: string;
    description?: string;
    parameters?: JsonSchemaType;
    /** When true, tool is not loaded into context initially (for tool search) */
    defer_loading?: boolean;
    /**
     * Which contexts can invoke this tool.
     * Default: ['direct'] (only callable directly by LLM)
     */
    allowed_callers?: AllowedCaller[];
    responseFormat?: ToolResponseFormat;
    /** Server name for MCP tools */
    serverName?: string;
    toolType?: 'builtin' | 'mcp' | 'action';
};

/**
 * In-place edit of a call's model-authored `intent` label: the first
 * occurrence of `from` in the intent is replaced with `to` (case-sensitive).
 */
export type OutcomePatch = {
    from: string;
    to: string;
};
