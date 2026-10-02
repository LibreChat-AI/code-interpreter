import assert from 'node:assert/strict';
import test from 'node:test';

import {
    CODE_EXECUTION_TOOLS,
    CONTENT_AND_ARTIFACT,
    LOCAL_CODING_BUNDLE_NAMES,
    LOCAL_CODING_TOOL_NAMES,
    ToolNames,
} from './constants.js';

test('canonical tool names keep their wire-level string values', () => {
    assert.equal(ToolNames.EXECUTE_CODE, 'execute_code');
    assert.equal(ToolNames.PROGRAMMATIC_TOOL_CALLING, 'run_tools_with_code');
    assert.equal(ToolNames.READ_FILE, 'read_file');
    assert.equal(ToolNames.BASH_TOOL, 'bash_tool');
    assert.equal(
        ToolNames.BASH_PROGRAMMATIC_TOOL_CALLING,
        'run_tools_with_bash'
    );
    assert.equal(ToolNames.WRITE_FILE, 'write_file');
    assert.equal(ToolNames.EDIT_FILE, 'edit_file');
    assert.equal(ToolNames.GREP_SEARCH, 'grep_search');
    assert.equal(ToolNames.GLOB_SEARCH, 'glob_search');
    assert.equal(ToolNames.LIST_DIRECTORY, 'list_directory');
    assert.equal(ToolNames.COMPILE_CHECK, 'compile_check');
});

test('response format constant keeps its wire-level value', () => {
    assert.equal(CONTENT_AND_ARTIFACT, 'content_and_artifact');
});

test('code execution tools are exactly the four sandbox-engine tools', () => {
    assert.deepEqual([...CODE_EXECUTION_TOOLS].sort(), [
        'bash_tool',
        'execute_code',
        'run_tools_with_bash',
        'run_tools_with_code',
    ]);
});

test('local coding tool names are the local-only surface', () => {
    assert.deepEqual(LOCAL_CODING_TOOL_NAMES, [
        ToolNames.READ_FILE,
        ToolNames.WRITE_FILE,
        ToolNames.EDIT_FILE,
        ToolNames.GREP_SEARCH,
        ToolNames.GLOB_SEARCH,
        ToolNames.LIST_DIRECTORY,
        ToolNames.COMPILE_CHECK,
    ]);
    assert.equal(LOCAL_CODING_TOOL_NAMES.length, 7);
});

test('local coding bundle names are the local tools plus the execution pair', () => {
    assert.deepEqual(LOCAL_CODING_BUNDLE_NAMES, [
        ...LOCAL_CODING_TOOL_NAMES,
        ToolNames.BASH_TOOL,
        ToolNames.EXECUTE_CODE,
        ToolNames.PROGRAMMATIC_TOOL_CALLING,
        ToolNames.BASH_PROGRAMMATIC_TOOL_CALLING,
    ]);
    assert.equal(LOCAL_CODING_BUNDLE_NAMES.length, 11);
});
