import assert from 'node:assert/strict';
import test from 'node:test';

import {
    clampCodeApiRunTimeoutMs,
    createCodeApiRunTimeoutSchema,
    DEFAULT_CODE_API_RUN_TIMEOUT_MS,
    MAX_CODE_API_RUN_TIMEOUT_SCHEMA_MS,
    MIN_CODE_API_RUN_TIMEOUT_MS,
    resolveCodeApiRunTimeoutMs,
} from './timeout.js';

const ENV_VAR = 'CODE_API_RUN_TIMEOUT_MS';

test('default run timeout is 15 seconds', () => {
    assert.equal(DEFAULT_CODE_API_RUN_TIMEOUT_MS, 15_000);
    assert.equal(MIN_CODE_API_RUN_TIMEOUT_MS, 1_000);
    assert.equal(MAX_CODE_API_RUN_TIMEOUT_SCHEMA_MS, 300_000);
});

test('resolveCodeApiRunTimeoutMs reads the environment override', () => {
    const previous = process.env[ENV_VAR];
    try {
        delete process.env[ENV_VAR];
        assert.equal(
            resolveCodeApiRunTimeoutMs(),
            DEFAULT_CODE_API_RUN_TIMEOUT_MS
        );
        process.env[ENV_VAR] = '20000';
        assert.equal(resolveCodeApiRunTimeoutMs(), 20_000);
        process.env[ENV_VAR] = 'not-a-number';
        assert.equal(
            resolveCodeApiRunTimeoutMs(),
            DEFAULT_CODE_API_RUN_TIMEOUT_MS
        );
        process.env[ENV_VAR] = '10';
        assert.equal(resolveCodeApiRunTimeoutMs(), MIN_CODE_API_RUN_TIMEOUT_MS);
    } finally {
        if (previous === undefined) {
            delete process.env[ENV_VAR];
        } else {
            process.env[ENV_VAR] = previous;
        }
    }
});

test('run timeout schema carries bounds and a human-readable default', () => {
    const schema = createCodeApiRunTimeoutSchema(60_000);
    assert.equal(schema.type, 'integer');
    assert.equal(schema.minimum, MIN_CODE_API_RUN_TIMEOUT_MS);
    assert.equal(schema.default, 60_000);
    assert.equal(schema.maximum, MAX_CODE_API_RUN_TIMEOUT_SCHEMA_MS);
    assert.match(schema.description, /Default: 60 seconds/);
    assert.match(schema.description, /Schema max: 300 seconds/);
});

test('run timeout schema maximum grows past the cap only when configured above it', () => {
    const schema = createCodeApiRunTimeoutSchema(400_000);
    assert.equal(schema.default, 400_000);
    assert.equal(schema.maximum, 400_000);
    assert.match(schema.description, /Default: 400 seconds/);
});

test('clampCodeApiRunTimeoutMs caps requested timeouts at the configured max', () => {
    assert.equal(clampCodeApiRunTimeoutMs(999_999, 30_000), 30_000);
    assert.equal(clampCodeApiRunTimeoutMs(5_000, 30_000), 5_000);
    assert.equal(clampCodeApiRunTimeoutMs(undefined, 30_000), 30_000);
    assert.equal(
        clampCodeApiRunTimeoutMs(500, 30_000),
        MIN_CODE_API_RUN_TIMEOUT_MS
    );
    assert.equal(
        clampCodeApiRunTimeoutMs(undefined, 0),
        MIN_CODE_API_RUN_TIMEOUT_MS
    );
});
