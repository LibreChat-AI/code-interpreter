import assert from 'node:assert/strict';
import test from 'node:test';

import {
    CompileCheckToolDefinition,
    CompileCheckToolDescription,
    CompileCheckToolSchema,
} from './local/compile-check.js';
import {
    LocalCodeExecutionToolDescription,
    LocalBashExecutionToolDescription,
} from './local/execution-tools.js';
import {
    LocalEditFileToolDefinition,
    LocalEditFileToolDescription,
    LocalEditFileToolSchema,
    LocalGlobSearchToolDefinition,
    LocalGlobSearchToolSchema,
    LocalGrepSearchToolDefinition,
    LocalGrepSearchToolSchema,
    LocalListDirectoryToolDefinition,
    LocalListDirectoryToolSchema,
    LocalReadFileToolDefinition,
    LocalReadFileToolDescription,
    LocalReadFileToolSchema,
    LocalWriteFileToolDefinition,
    LocalWriteFileToolDescription,
    LocalWriteFileToolSchema,
} from './local/file-tools.js';
import { ToolNames } from './constants.js';
import { INTENT_ARG } from './intent.js';

const intentIsFirst = (schema: { properties?: Record<string, unknown> }) =>
    Object.keys(schema.properties ?? {})[0] === INTENT_ARG;

const assertRegistryShape = (
    definition: {
        name: string;
        allowed_callers?: string[];
        responseFormat?: string;
        toolType?: string;
    },
    name: string
) => {
    assert.equal(definition.name, name);
    assert.deepEqual(definition.allowed_callers, ['direct', 'code_execution']);
    assert.equal(definition.responseFormat, 'content_and_artifact');
    assert.equal(definition.toolType, 'builtin');
};

test('local read_file schema and definition', () => {
    assert.deepEqual(LocalReadFileToolSchema.required, ['path']);
    assert.equal(intentIsFirst(LocalReadFileToolSchema), true);
    assertRegistryShape(LocalReadFileToolDefinition, ToolNames.READ_FILE);
    assert.equal(
        LocalReadFileToolDefinition.parameters,
        LocalReadFileToolSchema
    );
    assert.match(LocalReadFileToolDescription, /line numbers/);
});

test('local write_file schema and definition', () => {
    assert.deepEqual(LocalWriteFileToolSchema.required, ['path', 'content']);
    assert.equal(intentIsFirst(LocalWriteFileToolSchema), true);
    assertRegistryShape(LocalWriteFileToolDefinition, ToolNames.WRITE_FILE);
    assert.match(LocalWriteFileToolDescription, /unified diff/);
});

test('local edit_file schema supports single and batched edits', () => {
    assert.deepEqual(LocalEditFileToolSchema.required, ['path']);
    assert.equal(intentIsFirst(LocalEditFileToolSchema), true);
    assert.equal(
        LocalEditFileToolSchema.properties?.edits?.items?.required?.includes(
            'old_text'
        ),
        true
    );
    assertRegistryShape(LocalEditFileToolDefinition, ToolNames.EDIT_FILE);
    assert.match(LocalEditFileToolDescription, /whitespace-normalized/);
});

test('local grep and glob search schemas and definitions', () => {
    assert.deepEqual(LocalGrepSearchToolSchema.required, ['pattern']);
    assert.deepEqual(LocalGlobSearchToolSchema.required, ['pattern']);
    assert.equal(intentIsFirst(LocalGrepSearchToolSchema), true);
    assert.equal(intentIsFirst(LocalGlobSearchToolSchema), true);
    assertRegistryShape(LocalGrepSearchToolDefinition, ToolNames.GREP_SEARCH);
    assertRegistryShape(LocalGlobSearchToolDefinition, ToolNames.GLOB_SEARCH);
});

test('local list_directory schema and definition', () => {
    assert.equal(LocalListDirectoryToolSchema.required, undefined);
    assert.equal(intentIsFirst(LocalListDirectoryToolSchema), true);
    assertRegistryShape(
        LocalListDirectoryToolDefinition,
        ToolNames.LIST_DIRECTORY
    );
});

test('compile_check schema is optional-args only', () => {
    assert.equal(CompileCheckToolSchema.required, undefined);
    assert.equal(intentIsFirst(CompileCheckToolSchema), true);
    assertRegistryShape(CompileCheckToolDefinition, ToolNames.COMPILE_CHECK);
    assert.match(CompileCheckToolDescription, /tsconfig\.json/);
});

test('local execution descriptions describe the local machine semantics', () => {
    assert.match(LocalCodeExecutionToolDescription, /on the local machine/);
    assert.match(LocalBashExecutionToolDescription, /on the local machine/);
    assert.match(
        LocalCodeExecutionToolDescription,
        /local execution mode is enabled/
    );
    assert.match(
        LocalBashExecutionToolDescription,
        /Prefer project-native commands/
    );
});
