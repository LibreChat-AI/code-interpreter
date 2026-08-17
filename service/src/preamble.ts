import fs from 'fs';
import path from 'path';
import type * as t from './types';
import { planLimits } from './config';
import {
    generateBashReplayPreamble,
    generateBashReplayPostamble,
} from './preamble-bash';
import {
    PTC_HISTORY_FILENAME,
    PTC_HISTORY_SANDBOX_PATH,
    PTC_SENTINEL_START_PREFIX,
    PTC_SENTINEL_END_PREFIX,
    buildScopedSentinel,
    isReservedPtcFilename,
} from './ptc-constants';
import {
    hashToolInput,
    pendingInputHashesFromRawPayload,
} from './tool-input-signature';

// Load async matplotlib template for programmatic tool calling
const templateCodeAsync = fs.readFileSync(
    path.join(__dirname, 'matplotlib-async.py'),
    'utf8',
);

// =============================================================================
// Programmatic Tool Calling Types & Preamble Generation
// =============================================================================

export interface JsonSchemaProperty {
    type?: string;
    description?: string;
    items?: JsonSchemaProperty;
    properties?: Record<string, JsonSchemaProperty>;
    required?: string[];
    enum?: unknown[];
}

export interface JsonSchema {
    type?: string;
    properties?: Record<string, JsonSchemaProperty>;
    required?: string[];
}

export interface LCTool {
    name: string;
    description?: string;
    parameters?: JsonSchema;
}

export interface PreambleConfig {
    callbackUrl: string;
    callbackToken: string;
    executionId: string;
    tools: LCTool[];
}

export interface ReplayPreambleConfig {
    executionId: string;
    tools: LCTool[];
}

export {
    PTC_HISTORY_FILENAME,
    PTC_HISTORY_SANDBOX_PATH,
    PTC_SENTINEL_START_PREFIX,
    PTC_SENTINEL_END_PREFIX,
    buildScopedSentinel,
    isReservedPtcFilename,
};

/** Legacy (unscoped) markers - still exported for the unit test fixture that
 * exercises pre-scoping behaviour. Production code must not use these. */
export const PTC_SENTINEL_START = PTC_SENTINEL_START_PREFIX;
export const PTC_SENTINEL_END = PTC_SENTINEL_END_PREFIX;

/**
 * Normalize a tool name to be a valid Python identifier
 * - Replace hyphens with underscores
 * - Remove other invalid characters
 * - Ensure it starts with letter or underscore
 * - Avoid Python keywords
 */
function normalizePythonFunctionName(name: string): string {
    // Replace hyphens and spaces with underscores
    let normalized = name.replace(/[-\s]/g, '_');

    // Remove any characters that aren't letters, numbers, or underscores
    normalized = normalized.replace(/[^a-zA-Z0-9_]/g, '');

    // Ensure it starts with a letter or underscore (not a number)
    if (/^[0-9]/.test(normalized)) {
        normalized = '_' + normalized;
    }

    // Python keywords to avoid
    const pythonKeywords = new Set([
        'False',
        'None',
        'True',
        'and',
        'as',
        'assert',
        'async',
        'await',
        'break',
        'class',
        'continue',
        'def',
        'del',
        'elif',
        'else',
        'except',
        'finally',
        'for',
        'from',
        'global',
        'if',
        'import',
        'in',
        'is',
        'lambda',
        'nonlocal',
        'not',
        'or',
        'pass',
        'raise',
        'return',
        'try',
        'while',
        'with',
        'yield',
    ]);

    if (pythonKeywords.has(normalized)) {
        normalized = normalized + '_tool';
    }

    return normalized;
}

/**
 * Convert JSON Schema type to Python type hint
 */
function jsonSchemaToPythonType(schema: JsonSchemaProperty): string {
    if (schema.type == null || schema.type === '') return 'Any';

    switch (schema.type) {
        case 'string':
            return 'str';
        case 'integer':
            return 'int';
        case 'number':
        case 'float':
            return 'float';
        case 'boolean':
            return 'bool';
        case 'array': {
            const itemType = schema.items
                ? jsonSchemaToPythonType(schema.items)
                : 'Any';
            return `List[${itemType}]`;
        }
        case 'object':
            return 'Dict[str, Any]';
        case 'null':
            return 'None';
        default:
            return 'Any';
    }
}

/**
 * Sort property names so required parameters come before optional ones.
 * Uses a Set for O(1) lookups instead of repeated array includes() calls.
 */
function getSortedPropertyNames(
    propertyNames: string[],
    required: string[],
): string[] {
    const requiredSet = new Set(required);
    return [
        ...propertyNames.filter(name => requiredSet.has(name)),
        ...propertyNames.filter(name => !requiredSet.has(name)),
    ];
}

/**
 * Convert JSON Schema properties to Python function parameters.
 * Required parameters are placed first, followed by optional parameters with defaults.
 * This ensures valid Python syntax (required params cannot follow params with defaults).
 */
function schemaToParams(schema?: JsonSchema): string {
    if (!schema?.properties) return '';

    const required = schema.required ?? [];
    const requiredSet = new Set(required);
    const sortedNames = getSortedPropertyNames(
        Object.keys(schema.properties),
        required,
    );

    const params: string[] = [];

    for (const name of sortedNames) {
        const propSchema = schema.properties[name];
        const pyType = jsonSchemaToPythonType(propSchema);

        if (requiredSet.has(name)) {
            params.push(`${name}: ${pyType}`);
        } else {
            params.push(`${name}: Optional[${pyType}] = None`);
        }
    }

    return params.join(', ');
}

/**
 * Generate the input dictionary construction for a tool
 */
function generateInputDict(schema?: JsonSchema): string {
    if (!schema?.properties) return '';

    return Object.keys(schema.properties)
        .map(name => `"${name}": ${name}`)
        .join(', ');
}

/**
 * Infer Python return type from tool description
 */
function inferReturnType(description?: string): string {
    if (description == null || description === '') return 'Any';

    const desc = description.toLowerCase();

    if (
        desc.includes('returns list') ||
        desc.includes('returns array') ||
        desc.includes('list of')
    ) {
        return 'List[Dict[str, Any]]';
    }
    if (desc.includes('returns dict') || desc.includes('returns object')) {
        return 'Dict[str, Any]';
    }
    if (desc.includes('returns string') || desc.includes('returns str')) {
        return 'str';
    }
    if (desc.includes('returns int') || desc.includes('returns integer')) {
        return 'int';
    }
    if (desc.includes('returns float') || desc.includes('returns number')) {
        return 'float';
    }
    if (desc.includes('returns bool')) {
        return 'bool';
    }

    return 'Any';
}

/**
 * Generate docstring for a tool.
 * Parameters are listed with required ones first, matching the function signature order.
 */
function generateDocstring(tool: LCTool): string {
    let doc = tool.description ?? 'No description available.';

    if (tool.parameters?.properties) {
        doc += '\n\n    Parameters:';
        const required = tool.parameters.required ?? [];
        const requiredSet = new Set(required);
        const sortedNames = getSortedPropertyNames(
            Object.keys(tool.parameters.properties),
            required,
        );

        for (const name of sortedNames) {
            const propSchema = tool.parameters.properties[name];
            const isReq = requiredSet.has(name);
            const desc = propSchema.description ?? 'No description';
            doc += `\n        ${name} (${isReq ? 'required' : 'optional'}): ${desc}`;
        }
    }

    return doc;
}

/**
 * Generate a Python function stub for a single tool
 * Generates async stubs that require await
 * Normalizes tool names to be valid Python identifiers
 */
function generateToolStub(tool: LCTool): string {
    const params = schemaToParams(tool.parameters);
    const returnType = inferReturnType(tool.description);
    const docstring = generateDocstring(tool);
    const inputDict = generateInputDict(tool.parameters);

    // Normalize the function name for Python
    const pythonFunctionName = normalizePythonFunctionName(tool.name);

    // If name was changed, add a comment
    const nameComment =
        pythonFunctionName !== tool.name
            ? `    # Original tool name: ${tool.name}\n`
            : '';

    return `
async def ${pythonFunctionName}(${params}) -> ${returnType}:
    """${docstring}"""
${nameComment}    _input = {${inputDict}}
    _input = {k: v for k, v in _input.items() if v is not None}
    return await _execute_tool_internal_async("${tool.name}", _input)
`.trim();
}

/**
 * Generate the complete Python preamble for programmatic tool calling
 * Generates dual-mode stubs that work with or without await
 */
export function generatePreamble(config: PreambleConfig): string {
    const { callbackUrl, callbackToken, executionId, tools } = config;

    // Header with HTTP callback infrastructure (dual-mode version)
    let preamble = `
# ============================================================================
# PROGRAMMATIC TOOL CALLING INFRASTRUCTURE
# Auto-generated - do not modify
# ============================================================================

import json
import sys
import os
import asyncio
import socket as _socket
import http.client as _http_client
from typing import Any, Dict, List, Optional, Union
from urllib import request, error as urllib_error

_CALLBACK_URL = "${callbackUrl}"
_CALLBACK_TOKEN = "${callbackToken}"
_EXECUTION_ID = "${executionId}"
_TOOL_CALL_COUNTER = 0
_TOOL_CALL_LOCK = asyncio.Lock()

# The proxy bind-mounts this fixed path into every sandbox; the env var
# version was dropped to keep the path off os.environ introspection.
_TOOL_CALL_SOCKET = "/tmp/tcs.sock"

class _UnixHTTPConnection(_http_client.HTTPConnection):
    """HTTPConnection that tunnels through a Unix domain socket"""
    def __init__(self, socket_path):
        super().__init__("localhost")
        self._socket_path = socket_path
    def connect(self):
        self.sock = _socket.socket(_socket.AF_UNIX, _socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self._socket_path)

def _unix_request(method, path, body=None, headers=None, timeout=300):
    conn = _UnixHTTPConnection(_TOOL_CALL_SOCKET)
    conn.timeout = timeout
    conn.connect()
    conn.request(method, path, body=body, headers=headers or {})
    resp = conn.getresponse()
    data = resp.read()
    conn.close()
    return resp.status, data

def _tcp_request(method, url, body=None, headers=None, timeout=300):
    req = request.Request(url, data=body, headers=headers or {}, method=method)
    with request.urlopen(req, timeout=timeout) as resp:
        return resp.status, resp.read()

def _probe_tool_call_socket():
    # One-shot probe: is the path a live AF_UNIX listener? A real
    # connect() succeeds against the proxy; a regular file or stale
    # node returns ENOTSOCK / ECONNREFUSED. Done at preamble import
    # time, *before* user code runs, so a malicious user cannot spoof
    # /tmp/tcs.sock to flip the gate (a previous os.path.exists check
    # was user-spoofable in legacy/no-proxy mode). Each NsJail
    # invocation gets a fresh /tmp tmpfs so the probe result cannot
    # bleed across jobs.
    try:
        s = _socket.socket(_socket.AF_UNIX, _socket.SOCK_STREAM)
        s.settimeout(0.5)
        s.connect(_TOOL_CALL_SOCKET)
        s.close()
        return True
    except OSError:
        return False

_USE_TOOL_CALL_SOCKET = _probe_tool_call_socket()

def _do_request(method, path, body=None, headers=None, timeout=300):
    # Cached at import time (see _probe_tool_call_socket). User code
    # cannot influence this decision because it has not yet executed.
    if _USE_TOOL_CALL_SOCKET:
        return _unix_request(method, path, body, headers, timeout)
    url = _CALLBACK_URL + path
    return _tcp_request(method, url, body, headers, timeout)

class ToolExecutionError(Exception):
    """Raised when a tool call fails"""
    pass

class _DualModeResult:
    """Wrapper that works both synchronously and asynchronously"""
    def __init__(self, coro):
        self._coro = coro
        self._result = None
        self._executed = False
    
    def __await__(self):
        """Called when used with await"""
        return self._coro.__await__()
    
    def __call__(self):
        """Called when used synchronously - auto-runs asyncio.run()"""
        if self._executed:
            return self._result
        self._executed = True
        self._result = asyncio.run(self._coro)
        return self._result

async def _execute_tool_internal_async(tool_name: str, tool_input: Dict[str, Any]) -> Any:
    """Make blocking HTTP call to Tool Call Server (async version)"""
    global _TOOL_CALL_COUNTER
    
    async with _TOOL_CALL_LOCK:
        _TOOL_CALL_COUNTER += 1
        call_id = f"call_{_TOOL_CALL_COUNTER:03d}"
    
    headers = {
        "Content-Type": "application/json",
        "X-Execution-ID": _EXECUTION_ID,
        "X-Callback-Token": _CALLBACK_TOKEN,
        "X-Tool-Call-ID": call_id
    }
    
    payload = json.dumps({
        "tool_name": tool_name,
        "input": tool_input
    }).encode("utf-8")
    
    loop = asyncio.get_event_loop()
    
    def _sync_request():
        try:
            status, raw = _do_request("POST", "/tool-call", body=payload, headers=headers, timeout=300)
            result = json.loads(raw.decode("utf-8"))
            
            if not result.get("success"):
                raise ToolExecutionError(
                    f"Tool call failed: {result.get('error', 'Unknown error')}"
                )
            
            if result.get("is_error"):
                raise ToolExecutionError(
                    result.get("error_message", "Tool execution failed")
                )
            
            return result.get("result")
        
        except ToolExecutionError:
            raise
        except Exception as e:
            raise ToolExecutionError(f"Request error: {str(e)}")
    
    return await loop.run_in_executor(None, _sync_request)

# ============================================================================
# TOOL DEFINITIONS
# ============================================================================

`;

    // Generate stub for each tool
    for (const tool of tools) {
        preamble += generateToolStub(tool) + '\n\n';
    }

    return preamble;
}

/**
 * Replay-mode preamble. The sandbox runs from scratch every continuation and
 * loads prior tool results from the history file at `PTC_HISTORY_PATH`
 * (defaulting to `/mnt/data/_ptc_history.json`), which maps deterministic
 * call_ids (`call_001`, `call_002`, ...) to prior tool results. On a cache
 * hit the tool stub returns immediately; on a cache miss, the new pending
 * call is printed inside sentinel markers on stdout and the process exits
 * cleanly (exit 0).
 *
 * History is delivered as a file (not an env var) so very large histories
 * are not bounded by the Linux ARG_MAX / MAX_ARG_STRLEN ceiling.
 *
 * No socket bind mount, no Tool Call Server callback, no long-poll.
 */
export function generateReplayPreamble(config: ReplayPreambleConfig): string {
    const { executionId, tools } = config;
    const { start: scopedStart, end: scopedEnd } =
        buildScopedSentinel(executionId);

    let preamble = `
# ============================================================================
# PROGRAMMATIC TOOL CALLING INFRASTRUCTURE (replay mode)
# Auto-generated - do not modify
# ============================================================================

import json
import sys
import os
import asyncio
from typing import Any, Dict, List, Optional, Union

_EXECUTION_ID = "${executionId}"
_PTC_SENTINEL_START = "${scopedStart}"
_PTC_SENTINEL_END = "${scopedEnd}"
_PTC_HISTORY_PATH = os.environ.get("PTC_HISTORY_PATH") or "${PTC_HISTORY_SANDBOX_PATH}"

def _ptc_load_history() -> Dict[str, Any]:
    try:
        with open(_PTC_HISTORY_PATH, "r", encoding="utf-8") as _hf:
            data = json.load(_hf)
        if isinstance(data, dict):
            return data
    except FileNotFoundError:
        return {}
    except Exception:
        return {}
    return {}

_PTC_HISTORY = _ptc_load_history()

_TOOL_CALL_COUNTER = 0
_PTC_PENDING: List[Dict[str, Any]] = []

class ToolExecutionError(Exception):
    """Raised when a cached tool result is marked as an error."""
    pass

def _ptc_emit_pending_and_exit() -> None:
    try:
        sys.stdout.flush()
        sys.stderr.flush()
    except Exception:
        pass
    try:
        payload = json.dumps({"pending": _PTC_PENDING})
    except Exception as e:
        payload = json.dumps({"pending": [], "error": f"serialize_failed: {e}"})
    # Sentinel is always emitted on its own line surrounded by newlines so the
    # service-side parser can recover it even if user code printed without a
    # trailing newline.
    sys.stdout.write("\\n" + _PTC_SENTINEL_START + "\\n")
    sys.stdout.write(payload + "\\n")
    sys.stdout.write(_PTC_SENTINEL_END + "\\n")
    try:
        sys.stdout.flush()
    except Exception:
        pass
    os._exit(0)

async def _execute_tool_internal_async(tool_name: str, tool_input: Dict[str, Any]) -> Any:
    """Replay-aware tool dispatch: consult history, else emit pending and exit."""
    global _TOOL_CALL_COUNTER
    _TOOL_CALL_COUNTER += 1
    call_id = f"call_{_TOOL_CALL_COUNTER:03d}"

    entry = _PTC_HISTORY.get(call_id)
    if entry is not None:
        if isinstance(entry, dict) and entry.get("is_error"):
            raise ToolExecutionError(entry.get("error_message") or "tool execution failed")
        if isinstance(entry, dict):
            return entry.get("result")
        return entry

    _PTC_PENDING.append({
        "call_id": call_id,
        "tool_name": tool_name,
        "input": tool_input,
    })
    _ptc_emit_pending_and_exit()

# ============================================================================
# TOOL DEFINITIONS
# ============================================================================

`;

    for (const tool of tools) {
        preamble += generateToolStub(tool) + '\n\n';
    }

    return preamble;
}

/**
 * Result of parsing the sandbox's stdout for the PTC sentinel block.
 * If `pending` is non-null the run ended on an uncached tool call; the
 * cleaned stdout (with the sentinel block stripped) is returned so user
 * prints can be surfaced as partial output.
 */
export interface ExtractPendingResult {
    stdout: string;
    pending: Array<{
        call_id: string;
        tool_name: string;
        input: Record<string, unknown>;
        input_hash?: string;
        call_site?: string;
    }> | null;
}

/**
 * Locate the last line whose trimmed content exactly equals `marker`.
 * Using full-line anchoring prevents user-provided tool payloads that happen
 * to contain the sentinel literal as substring from confusing the parser.
 *
 * Returns the line index and the absolute character offsets of the line's
 * start and the newline that terminates it (or end-of-string).
 */
function findSentinelLine(
    lines: string[],
    lineStartOffsets: number[],
    marker: string,
    searchFromLine: number,
): { line: number; startOffset: number; endOffset: number } | null {
    for (let i = lines.length - 1; i >= searchFromLine; i--) {
        if (lines[i].trim() === marker) {
            const startOffset = lineStartOffsets[i];
            const endOffset =
                i + 1 < lineStartOffsets.length
                    ? lineStartOffsets[i + 1] - 1
                    : startOffset + lines[i].length;
            return { line: i, startOffset, endOffset };
        }
    }
    return null;
}

export function extractPendingFromStdout(
    stdout: string,
    executionId?: string,
): ExtractPendingResult {
    if (stdout == null) return { stdout: '', pending: null };

    const { start: startMarker, end: endMarker } = executionId
        ? buildScopedSentinel(executionId)
        : { start: PTC_SENTINEL_START_PREFIX, end: PTC_SENTINEL_END_PREFIX };

    const lines = stdout.split('\n');
    const lineStartOffsets: number[] = [0];
    for (let i = 0; i < lines.length - 1; i++) {
        lineStartOffsets.push(lineStartOffsets[i] + lines[i].length + 1);
    }

    const startLine = findSentinelLine(lines, lineStartOffsets, startMarker, 0);
    if (!startLine) return { stdout, pending: null };

    const endLine = findSentinelLine(
        lines,
        lineStartOffsets,
        endMarker,
        startLine.line + 1,
    );
    if (!endLine) return { stdout, pending: null };

    const payloadLines = lines.slice(startLine.line + 1, endLine.line);
    const rawPayload = payloadLines.join('\n').trim();
    let parsed: { pending?: unknown } | null = null;
    try {
        parsed = JSON.parse(rawPayload) as { pending?: unknown };
    } catch {
        return { stdout, pending: null };
    }

    const pendingField = parsed?.pending;
    if (!Array.isArray(pendingField)) return { stdout, pending: null };

    const rawInputHashes = pendingInputHashesFromRawPayload(rawPayload);
    type PendingWithIndex = {
        c: { call_id: string; tool_name: string; input: unknown };
        index: number;
    };
    const isPendingWithIndex = (entry: {
        c: unknown;
        index: number;
    }): entry is PendingWithIndex => {
        const { c } = entry;
        return (
            c != null &&
            typeof c === 'object' &&
            typeof (c as { call_id?: unknown }).call_id === 'string' &&
            typeof (c as { tool_name?: unknown }).tool_name === 'string'
        );
    };
    const pending = pendingField
        .map((c, index) => ({ c, index }))
        .filter(isPendingWithIndex)
        .map(({ c, index }) => {
            const callSite = (c as { call_site?: unknown }).call_site;
            const rawInputHash = rawInputHashes[index];
            const hasObjectInput =
                c.input != null && typeof c.input === 'object';
            const input = (hasObjectInput ? c.input : {}) as Record<
                string,
                unknown
            >;
            return {
                call_id: c.call_id,
                tool_name: c.tool_name,
                input,
                input_hash:
                    hasObjectInput && typeof rawInputHash === 'string'
                        ? rawInputHash
                        : hashToolInput(input),
                ...(typeof callSite === 'string'
                    ? { call_site: callSite }
                    : {}),
            };
        });

    /** Strip only the sentinel block and leave every other byte of user
     * stdout untouched. Both the Python and bash preambles defensively
     * emit a single `\n` *before* the start marker so the sentinel always
     * begins on its own line even if user code printed without a trailing
     * newline; undo exactly that one runtime-inserted newline so the
     * visible stdout reflects what the program actually wrote. Do NOT
     * normalize internal whitespace (e.g. collapsing blank-line runs or
     * trimming leading/trailing whitespace) — that would silently mutate
     * program output and break exact-format tests, YAML/Markdown
     * emission, and anything else that depends on byte-accurate stdout. */
    const rawHead = stdout.slice(0, startLine.startOffset);
    const head = rawHead.endsWith('\n') ? rawHead.slice(0, -1) : rawHead;
    const tailStart =
        endLine.endOffset < stdout.length
            ? endLine.endOffset + 1
            : stdout.length;
    const tail = stdout.slice(tailStart);
    const cleaned = head + tail;

    return { stdout: cleaned, pending };
}

/**
 * Wrap user code in async context for top-level await support
 * Simple indentation - imports work fine inside async functions
 */
function wrapUserCodeInAsync(userCode: string): string {
    const lines = userCode.split('\n');

    let wrapped =
        '# ============================================================================\n';
    wrapped += '# USER CODE BEGINS BELOW\n';
    wrapped +=
        '# ============================================================================\n\n';
    wrapped += 'async def __user_main__():\n';
    wrapped +=
        '    """Auto-generated wrapper for user code to support top-level await"""\n';

    // Indent all user code
    for (const line of lines) {
        if (line.trim() === '') {
            wrapped += '\n';
        } else {
            wrapped += '    ' + line + '\n';
        }
    }

    // Run the async main
    wrapped += '\n';
    wrapped += 'if __name__ == "__main__":\n';
    wrapped += '    import asyncio\n';
    wrapped += '    asyncio.run(__user_main__())\n';

    return wrapped;
}

export interface CreateProgrammaticPayloadOptions {
    req: t.AuthenticatedRequest;
    /** Top-level execution session id (one sandbox `/exec` invocation). */
    session_id: string;
    execution_id: string;
    /** Blocking-mode only. Ignored in replay mode. */
    callbackUrl?: string;
    /** Blocking-mode only. Ignored in replay mode. */
    callbackToken?: string;
    tools: LCTool[];
    timeout?: number;
    /** 'blocking' (default) or 'replay'. */
    mode?: 'blocking' | 'replay';
    /** Replay-mode only. Map of call_id -> {result,is_error?,error_message?}. */
    history?: Record<string, unknown>;
    /** Override user code (useful for continuation re-enqueues where code comes from state, not req.body). */
    codeOverride?: string;
    /** Override user files (useful for continuation re-enqueues). */
    filesOverride?: t.RequestFile[];
    /** Target language for the generated preamble/payload. Defaults to 'python'. */
    language?: 'python' | 'bash';
}

// Default timeouts for programmatic execution (longer due to blocking tool calls)
const PROGRAMMATIC_RUN_TIMEOUT = 300000; // 5 minutes wall time
// const MAX_GENERATED_CODE_SIZE = 500000; // 500KB - prevent excessive preambles

/**
 * Create a payload for programmatic tool calling execution
 * Combines the tool preamble with user code
 */
export function createProgrammaticPayload(
    options: CreateProgrammaticPayloadOptions,
): t.PayloadBody {
    const {
        req,
        session_id,
        execution_id,
        callbackUrl,
        callbackToken,
        tools,
        timeout,
        mode = 'blocking',
        history,
        codeOverride,
        filesOverride,
        language = 'python',
    } = options;
    const body = req.body as t.ProgrammaticRequestBody;
    const userCode = codeOverride ?? body.code;
    const files = filesOverride ?? body.files;

    if (!userCode || typeof userCode !== 'string') {
        throw new Error('createProgrammaticPayload: no user code available');
    }

    if (language === 'bash') {
        if (mode !== 'replay') {
            throw new Error('bash PTC is only supported in replay mode');
        }
        return buildBashPayload({
            req,
            execution_id,
            session_id,
            tools,
            userCode,
            files,
            history,
            timeout,
        });
    }

    let preamble: string;
    if (mode === 'replay') {
        preamble = generateReplayPreamble({ executionId: execution_id, tools });
    } else {
        if (!callbackUrl || !callbackToken) {
            throw new Error(
                'blocking PTC mode requires callbackUrl and callbackToken',
            );
        }
        preamble = generatePreamble({
            callbackUrl,
            callbackToken,
            executionId: execution_id,
            tools,
        });
    }

    const isPyPlot =
        userCode.includes('import matplotlib') ||
        userCode.includes('import seaborn');

    let finalCode: string;

    if (isPyPlot) {
        const indentedUserCode = userCode
            .trim()
            .split('\n')
            .map(line => `    ${line}`)
            .join('\n');
        const wrappedUserCode = templateCodeAsync.replace(
            /# BEGIN USER CODE\n[\s\S]*?# END USER CODE/,
            `# BEGIN USER CODE\n${indentedUserCode}\n    # END USER CODE`,
        );
        finalCode = preamble + '\n' + wrappedUserCode;
    } else {
        const wrappedUserCode = wrapUserCodeInAsync(userCode);
        finalCode = preamble + wrappedUserCode;
    }

    const run_memory_limit =
        planLimits[req.planId ?? '']?.run_memory_limit ??
        planLimits.default.run_memory_limit;
    const run_timeout = timeout ?? PROGRAMMATIC_RUN_TIMEOUT;

    const payload: t.PayloadBody = {
        run_memory_limit,
        run_timeout,
        language: 'python',
        version: '3.14.4',
        ...(mode === 'blocking' ? { tool_call_socket: true } : {}),
        files: [
            {
                name: 'main.py',
                content: finalCode,
            },
        ],
        session_id,
    };

    if (mode === 'replay') {
        payload.files.push({
            name: PTC_HISTORY_FILENAME,
            content: JSON.stringify(history ?? {}),
        });
    }

    if (files && files.length > 0) {
        for (const obj of files) {
            if (obj.name && isReservedPtcFilename(obj.name)) continue;
            payload.files.push({
                id: obj.id,
                storage_session_id: obj.storage_session_id,
                name: obj.name,
            });
        }
    }

    return payload;
}

/**
 * Assemble a bash programmatic payload. Bash PTC only exists in replay mode —
 * the per-tool shell functions talk to a file-backed counter/pending state
 * which is handled by the preamble's DEBUG/EXIT traps.
 */
function buildBashPayload(args: {
    req: t.AuthenticatedRequest;
    execution_id: string;
    session_id: string;
    tools: LCTool[];
    userCode: string;
    files?: t.RequestFile[];
    history?: Record<string, unknown>;
    timeout?: number;
}): t.PayloadBody {
    const {
        req,
        execution_id,
        session_id,
        tools,
        userCode,
        files,
        history,
        timeout,
    } = args;

    const preamble = generateBashReplayPreamble({
        executionId: execution_id,
        tools,
    });
    const postamble = generateBashReplayPostamble();
    const finalCode = preamble + userCode + '\n' + postamble;

    const run_memory_limit =
        planLimits[req.planId ?? '']?.run_memory_limit ??
        planLimits.default.run_memory_limit;
    const run_timeout = timeout ?? PROGRAMMATIC_RUN_TIMEOUT;

    const payload: t.PayloadBody = {
        run_memory_limit,
        run_timeout,
        language: 'bash',
        version: '5.2.0',
        files: [
            {
                name: 'main.sh',
                content: finalCode,
            },
            {
                name: PTC_HISTORY_FILENAME,
                content: JSON.stringify(history ?? {}),
            },
        ],
        session_id,
    };

    if (files && files.length > 0) {
        for (const obj of files) {
            if (obj.name && isReservedPtcFilename(obj.name)) continue;
            payload.files.push({
                id: obj.id,
                storage_session_id: obj.storage_session_id,
                name: obj.name,
            });
        }
    }

    return payload;
}
