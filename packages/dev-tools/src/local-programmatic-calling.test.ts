import assert from 'node:assert/strict';
import test from 'node:test';

import {
    createLocalBashProgrammaticToolCallingSchema,
    createLocalProgrammaticToolCallingSchema,
    LocalBashProgrammaticToolCallingDefinition,
    LocalBashProgrammaticToolCallingDescription,
    LocalProgrammaticToolCallingDefinition,
    LocalProgrammaticToolCallingDescription,
} from './local/programmatic-tool-calling.js';
import { INTENT_ARG } from './intent.js';
import { ProgrammaticToolCallingDescription } from './run-tools-with-code.js';
import { BashProgrammaticToolCallingDescription } from './run-tools-with-bash.js';

test('local run_tools_with_code schema defaults to bash with a 60s timeout', () => {
    const schema = createLocalProgrammaticToolCallingSchema();
    assert.equal(Object.keys(schema.properties)[0], INTENT_ARG);
    assert.deepEqual(schema.required, ['code']);
    assert.deepEqual(schema.properties.lang.enum, [
        'py',
        'python',
        'bash',
        'sh',
    ]);
    assert.equal(schema.properties.lang.default, 'bash');
    assert.match(schema.properties.lang.description, /Defaults to bash/);
    assert.equal(schema.properties.timeout.default, 60_000);
    assert.equal(schema.properties.timeout.minimum, 1_000);
    assert.equal(schema.properties.timeout.maximum, 300_000);
    assert.match(schema.properties.timeout.description, /Default: 60 seconds/);
});

test('local run_tools_with_code schema honours a configured timeout', () => {
    const schema = createLocalProgrammaticToolCallingSchema({
        timeoutMs: 90_000,
    });
    assert.equal(schema.properties.timeout.default, 90_000);
    assert.match(schema.properties.timeout.description, /Default: 90 seconds/);
});

test('local run_tools_with_bash schema swaps the timeout and keeps the code param', () => {
    const schema = createLocalBashProgrammaticToolCallingSchema({
        timeoutMs: 120_000,
    });
    assert.equal('lang' in schema.properties, false);
    assert.equal(schema.properties.timeout.default, 120_000);
    assert.deepEqual(schema.required, ['code']);
});

test('local PTC descriptions extend the remote descriptions with the local suffix', () => {
    assert.ok(
        LocalProgrammaticToolCallingDescription.startsWith(
            ProgrammaticToolCallingDescription
        )
    );
    assert.match(
        LocalProgrammaticToolCallingDescription,
        /in-process localhost bridge/
    );
    assert.ok(
        LocalBashProgrammaticToolCallingDescription.startsWith(
            BashProgrammaticToolCallingDescription
        )
    );
    assert.match(
        LocalBashProgrammaticToolCallingDescription,
        /this bash orchestration code/
    );
});

test('default local PTC definitions bind names, descriptions, and default schemas', () => {
    assert.equal(
        LocalProgrammaticToolCallingDefinition.name,
        'run_tools_with_code'
    );
    assert.equal(
        LocalProgrammaticToolCallingDefinition.description,
        LocalProgrammaticToolCallingDescription
    );
    assert.deepEqual(LocalProgrammaticToolCallingDefinition.schema.required, [
        'code',
    ]);
    assert.equal(
        LocalBashProgrammaticToolCallingDefinition.name,
        'run_tools_with_bash'
    );
    assert.equal(
        LocalBashProgrammaticToolCallingDefinition.description,
        LocalBashProgrammaticToolCallingDescription
    );
    assert.deepEqual(
        LocalBashProgrammaticToolCallingDefinition.schema.required,
        ['code']
    );
});
