import assert from 'node:assert/strict';
import test from 'node:test';

import type { JsonSchemaType } from './types.js';
import {
    applyOutcome,
    INTENT_ARG,
    INTENT_DESCRIPTION,
    INTENT_LABEL_MARKER,
    INTENT_PROPERTY,
    isIntentLabelProperty,
    outcomeFieldsFromResult,
    readIntent,
    readOutcomeFields,
    resolveToolOutcome,
    stripIntent,
    withIntent,
    withoutIntent,
} from './intent.js';

const BASE_SCHEMA: JsonSchemaType = {
    type: 'object',
    properties: {
        path: { type: 'string', description: 'File path.' },
    },
    required: ['path'],
};

test('the intent property is frozen and its description keeps the marker prefix', () => {
    assert.equal(Object.isFrozen(INTENT_PROPERTY), true);
    assert.equal(INTENT_DESCRIPTION.startsWith(INTENT_LABEL_MARKER), true);
    assert.equal(isIntentLabelProperty(INTENT_PROPERTY), true);
    assert.equal(
        isIntentLabelProperty({ type: 'string', description: 'other' }),
        false
    );
    assert.equal(isIntentLabelProperty(null), false);
});

test('withIntent prepends the label property first and never requires it', () => {
    const schema = withIntent(BASE_SCHEMA);
    assert.deepEqual(Object.keys(schema.properties ?? {}), [
        INTENT_ARG,
        'path',
    ]);
    assert.equal(schema.properties?.intent?.description, INTENT_DESCRIPTION);
    assert.deepEqual(schema.required, ['path']);
    assert.equal(
        BASE_SCHEMA.properties && INTENT_ARG in BASE_SCHEMA.properties,
        false
    );
});

test('withIntent is a no-op when the schema already declares intent', () => {
    const withOwn: JsonSchemaType = {
        ...BASE_SCHEMA,
        properties: {
            intent: {
                type: 'string',
                description: 'Business intent, not the label.',
            },
            path: { type: 'string', description: 'File path.' },
        },
    };
    assert.equal(withIntent(withOwn), withOwn);
});

test('withoutIntent removes the label property and its required entry', () => {
    const withLabel = withIntent(BASE_SCHEMA);
    const stripped = withoutIntent(withLabel);
    assert.equal(INTENT_ARG in (stripped?.properties ?? {}), false);
    assert.deepEqual(stripped?.required, ['path']);
});

test('withoutIntent prunes required when intent was its only member', () => {
    const onlyIntent = withIntent({ type: 'object', properties: {} });
    const stripped = withoutIntent(onlyIntent);
    assert.equal(stripped?.required, undefined);
});

test('withoutIntent never strips a business parameter named intent', () => {
    const businessIntent: JsonSchemaType = {
        type: 'object',
        properties: {
            intent: {
                type: 'string',
                description: 'Which of several goals to pursue',
            },
        },
        required: ['intent'],
    };
    assert.equal(withoutIntent(businessIntent), businessIntent);
});

test('readIntent reads object args and stringified JSON args', () => {
    assert.equal(
        readIntent({ intent: 'Renaming the callback router' }),
        'Renaming the callback router'
    );
    assert.equal(
        readIntent('{"intent":"Renaming the callback router"}'),
        'Renaming the callback router'
    );
    assert.equal(readIntent({ intent: '   ' }), undefined);
    assert.equal(readIntent({}), undefined);
    assert.equal(readIntent('not json'), undefined);
});

test('stripIntent removes the label key and leaves everything else', () => {
    assert.deepEqual(stripIntent({ intent: 'label', path: 'a.ts' }), {
        path: 'a.ts',
    });
    assert.deepEqual(stripIntent('{"intent":"label","path":"a.ts"}'), {
        path: 'a.ts',
    });
    const unchanged = { path: 'a.ts' };
    assert.equal(stripIntent(unchanged), unchanged);
    assert.equal(stripIntent('plain string'), 'plain string');
});

test('applyOutcome resolves in precedence order: outcome, patch, unchanged intent', () => {
    assert.equal(
        applyOutcome('Searching the router', {
            outcome: 'Searched the router',
        }),
        'Searched the router'
    );
    assert.equal(
        applyOutcome('Searching the router', {
            outcome_patch: { from: 'Searching', to: 'Searched' },
        }),
        'Searched the router'
    );
    assert.equal(
        applyOutcome('Searching the router', {}),
        'Searching the router'
    );
    assert.equal(applyOutcome(undefined, {}), undefined);
    assert.equal(applyOutcome(undefined, { outcome: 'Done' }), 'Done');
    assert.equal(
        applyOutcome('Searching the router', {
            outcome_patch: { from: 'Editing', to: 'Edited' },
        }),
        'Searching the router'
    );
});

test('resolveToolOutcome emits only tool-authored labels for failed calls', () => {
    const args = { intent: 'Searching the callback router' };
    assert.equal(
        resolveToolOutcome(
            args,
            { outcome: 'Searched the callback router' },
            { isError: true }
        ),
        'Searched the callback router'
    );
    assert.equal(
        resolveToolOutcome(
            args,
            { outcome_patch: { from: 'Searching', to: 'Searched' } },
            { isError: true }
        ),
        'Searched the callback router'
    );
    assert.equal(
        resolveToolOutcome(
            args,
            { outcome_patch: { from: 'Editing', to: 'Edited' } },
            { isError: true }
        ),
        undefined
    );
});

test('resolveToolOutcome collapses and bounds the emitted label', () => {
    assert.equal(
        resolveToolOutcome(
            { intent: 'Searching\n  the   router' },
            { outcome_patch: { from: 'Searching', to: 'Searched' } }
        ),
        'Searched the router'
    );
    const long = 'a'.repeat(400);
    const bounded = resolveToolOutcome({ intent: 'x' }, { outcome: long });
    assert.equal(bounded?.length, 256);
    assert.equal(bounded?.endsWith('…'), true);
    assert.equal(resolveToolOutcome({}, { outcome: '   ' }), undefined);
});

test('resolveToolOutcome returns undefined without tool-authored fields', () => {
    assert.equal(resolveToolOutcome({ intent: 'x' }, undefined), undefined);
    assert.equal(resolveToolOutcome({ intent: 'x' }, {}), undefined);
});

test('outcome fields read through the artifact channel', () => {
    const artifact = { outcome: 'Searched the router' };
    assert.deepEqual(readOutcomeFields(artifact), {
        outcome: 'Searched the router',
        outcome_patch: undefined,
    });
    assert.deepEqual(
        readOutcomeFields({ outcome_patch: { from: 'a', to: 'b', extra: 1 } }),
        { outcome: undefined, outcome_patch: { from: 'a', to: 'b' } }
    );
    assert.equal(readOutcomeFields('not an object'), undefined);
    assert.equal(readOutcomeFields({ unrelated: true }), undefined);
    assert.deepEqual(outcomeFieldsFromResult({ outcome: 'typed wins' }), {
        outcome: 'typed wins',
    });
    assert.deepEqual(outcomeFieldsFromResult({ artifact }), {
        outcome: 'Searched the router',
        outcome_patch: undefined,
    });
    assert.equal(outcomeFieldsFromResult({}), undefined);
});
