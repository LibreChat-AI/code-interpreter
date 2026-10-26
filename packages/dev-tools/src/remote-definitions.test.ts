import assert from 'node:assert/strict';
import test from 'node:test';

import {
    AttachedWorkspaceBashExecutionToolDescription,
    BashExecutionToolDefinition,
    BashExecutionToolDescription,
    BashExecutionToolSchema,
    buildBashExecutionToolDescription,
    buildBashExecutionToolSchema,
    BashToolOutputReferencesGuide,
    StatefulBashExecutionToolDescription,
} from './bash-tool.js';
import { ToolNames } from './constants.js';
import { INTENT_ARG } from './intent.js';
import {
    CodeExecutionToolDefinition,
    CodeExecutionToolDescription,
    CodeExecutionToolSchema,
    buildCodeExecutionToolDescription,
    buildCodeExecutionToolSchema,
    StatefulCodeExecutionToolDescription,
    SUPPORTED_LANGUAGES,
} from './execute-code.js';
import { ReadFileToolDefinition, ReadFileToolSchema } from './read-file.js';
import {
    buildBashProgrammaticToolCallingDescription,
    buildBashProgrammaticToolCallingSchema,
    BashProgrammaticToolCallingDefinition,
    BashProgrammaticToolCallingSchema,
} from './run-tools-with-bash.js';
import {
    ProgrammaticToolCallingDefinition,
    ProgrammaticToolCallingSchema,
} from './run-tools-with-code.js';

const intentIsFirst = (schema: { properties?: Record<string, unknown> }) =>
    Object.keys(schema.properties ?? {})[0] === INTENT_ARG;

test('execute_code definition matches its schema and description', () => {
    assert.equal(CodeExecutionToolDefinition.name, 'execute_code');
    assert.equal(
        CodeExecutionToolDefinition.description,
        CodeExecutionToolDescription
    );
    assert.equal(CodeExecutionToolDefinition.schema, CodeExecutionToolSchema);
    assert.deepEqual(CodeExecutionToolSchema.required, ['lang', 'code']);
    assert.equal(intentIsFirst(CodeExecutionToolSchema), true);
    assert.deepEqual(SUPPORTED_LANGUAGES, [
        'py',
        'js',
        'ts',
        'c',
        'cpp',
        'java',
        'php',
        'rs',
        'go',
        'd',
        'f90',
        'r',
        'bash',
    ]);
    assert.match(
        CodeExecutionToolSchema.properties.code.description,
        /\/mnt\/data/
    );
});

test('execute_code description and schema builders swap stateful wording', () => {
    assert.equal(
        buildCodeExecutionToolDescription(),
        CodeExecutionToolDescription
    );
    assert.equal(
        buildCodeExecutionToolDescription({ statefulSessions: true }),
        StatefulCodeExecutionToolDescription
    );
    const statefulSchema = buildCodeExecutionToolSchema({
        statefulSessions: true,
    });
    assert.match(
        statefulSchema.properties.code.description,
        /files written to \/mnt\/data persist between calls/
    );
    assert.match(
        CodeExecutionToolSchema.properties.code.description,
        /stateless/
    );
});

test('bash_tool definition matches its schema and description', () => {
    assert.equal(BashExecutionToolDefinition.name, ToolNames.BASH_TOOL);
    assert.equal(
        BashExecutionToolDefinition.description,
        BashExecutionToolDescription
    );
    assert.equal(BashExecutionToolDefinition.schema, BashExecutionToolSchema);
    assert.deepEqual(BashExecutionToolSchema.required, ['command']);
    assert.equal(intentIsFirst(BashExecutionToolSchema), true);
    assert.match(
        BashExecutionToolSchema.properties.command.description,
        /heredoc\/printf/
    );
});

test('bash_tool description builder composes stateful, attached, and reference variants', () => {
    assert.equal(
        buildBashExecutionToolDescription(),
        BashExecutionToolDescription
    );
    assert.equal(
        buildBashExecutionToolDescription({ statefulSessions: true }),
        StatefulBashExecutionToolDescription
    );
    assert.equal(
        buildBashExecutionToolDescription({ attachedWorkspace: true }),
        AttachedWorkspaceBashExecutionToolDescription
    );
    const withReferences = buildBashExecutionToolDescription({
        enableToolOutputReferences: true,
    });
    assert.equal(
        withReferences,
        `${BashExecutionToolDescription}\n\n${BashToolOutputReferencesGuide}`
    );
    const attachedSchema = buildBashExecutionToolSchema({
        attachedWorkspace: true,
    });
    assert.match(
        attachedSchema.properties.command.description,
        /selected persistent project/
    );
    assert.doesNotMatch(
        attachedSchema.properties.command.description,
        /stateless; variables and state/
    );
});

test('read_file definition carries the content_and_artifact response format', () => {
    assert.equal(ReadFileToolDefinition.name, ToolNames.READ_FILE);
    assert.equal(ReadFileToolDefinition.responseFormat, 'content_and_artifact');
    assert.equal(ReadFileToolDefinition.parameters, ReadFileToolSchema);
    assert.deepEqual(ReadFileToolSchema.required, ['path']);
    assert.equal(intentIsFirst(ReadFileToolSchema), true);
    assert.match(ReadFileToolDefinition.description, /skill files/i);
});

test('run_tools_with_code schema carries code, manifest, and timeout', () => {
    assert.equal(
        ProgrammaticToolCallingDefinition.name,
        ToolNames.PROGRAMMATIC_TOOL_CALLING
    );
    assert.deepEqual(ProgrammaticToolCallingSchema.required, ['code']);
    assert.equal(intentIsFirst(ProgrammaticToolCallingSchema), true);
    assert.equal(ProgrammaticToolCallingSchema.properties.code.minLength, 1);
    assert.equal(
        ProgrammaticToolCallingSchema.properties.tool_manifest.uniqueItems,
        true
    );
    assert.equal(
        ProgrammaticToolCallingSchema.properties.timeout.minimum,
        1_000
    );
    assert.match(
        ProgrammaticToolCallingDefinition.description,
        /STATELESS EXECUTION/
    );
});

test('run_tools_with_bash schema and its attached-workspace builders', () => {
    assert.equal(
        BashProgrammaticToolCallingDefinition.name,
        ToolNames.BASH_PROGRAMMATIC_TOOL_CALLING
    );
    assert.deepEqual(BashProgrammaticToolCallingSchema.required, ['code']);
    assert.equal(intentIsFirst(BashProgrammaticToolCallingSchema), true);
    assert.equal(
        BashProgrammaticToolCallingSchema.properties.tool_manifest.uniqueItems,
        true
    );
    assert.match(
        BashProgrammaticToolCallingDefinition.description,
        /bash functions/
    );

    const attachedDescription = buildBashProgrammaticToolCallingDescription({
        attachedWorkspace: true,
    });
    assert.match(attachedDescription, /ATTACHED WORKSPACE EXECUTION:/);
    assert.doesNotMatch(attachedDescription, /CRITICAL - STATELESS EXECUTION:/);

    const attachedSchema = buildBashProgrammaticToolCallingSchema({
        attachedWorkspace: true,
        maxRunTimeoutMs: 45_000,
    });
    assert.match(
        attachedSchema.properties.code.description,
        /selected persistent workspace/
    );
    assert.equal(attachedSchema.properties.timeout.default, 45_000);
    assert.notEqual(
        attachedSchema.properties.code.description,
        BashProgrammaticToolCallingSchema.properties.code.description
    );
});
