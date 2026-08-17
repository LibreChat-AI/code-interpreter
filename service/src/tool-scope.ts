type ToolWithName = {
    name?: unknown;
    function?: {
        name?: unknown;
    };
};

type PendingToolCall = {
    call_id?: string;
    tool_name: string;
};

export function registeredToolNames(
    tools: readonly ToolWithName[] | undefined,
): Set<string> {
    const names = new Set<string>();
    for (const tool of tools ?? []) {
        if (tool == null || typeof tool !== 'object') continue;

        if (typeof tool.name === 'string' && tool.name !== '') {
            names.add(tool.name);
        }

        const functionName = tool.function?.name;
        if (typeof functionName === 'string' && functionName !== '') {
            names.add(functionName);
        }
    }
    return names;
}

export function isRegisteredToolName(
    toolName: string,
    tools: readonly ToolWithName[] | undefined,
): boolean {
    if (toolName === '') return false;
    return registeredToolNames(tools).has(toolName);
}

export function findUnregisteredToolCall(
    calls: readonly PendingToolCall[],
    tools: readonly ToolWithName[] | undefined,
): PendingToolCall | null {
    const names = registeredToolNames(tools);
    for (const call of calls) {
        if (!names.has(call.tool_name)) return call;
    }
    return null;
}
