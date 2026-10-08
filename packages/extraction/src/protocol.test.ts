import assert from 'node:assert/strict';
import { test } from 'node:test';
import { policy, validateResult } from './protocol.js';
const digest = 'a'.repeat(64);
const value = (text = 'hello') => ({
    version: 1,
    operation: 'document.extract-text',
    format: 'pdf',
    inputSha256: digest,
    textBytes: Buffer.byteLength(text),
    segments: [{ kind: 'page', index: 1, text }],
});
const encode = (result: unknown) => Buffer.from(JSON.stringify(result));
test('preserves ordered page segments and validates digest and byte count', () => {
    const result = value();
    assert.deepEqual(validateResult(encode(result), 'pdf', digest), result);
    for (const changed of [
        { ...result, inputSha256: 'b'.repeat(64) },
        { ...result, textBytes: 4 },
        { ...result, extra: true },
        { ...result, format: 'docx' },
        { ...result, segments: [{ kind: 'page', index: 0, text: 'hello' }] },
        { ...result, segments: [{ kind: 'sheet', index: 1, text: 'hello' }] },
    ])
        assert.throws(() => validateResult(encode(changed), 'pdf', digest));
});
test('rejects malformed UTF-8, lone surrogates, emptiness and invalid JSON', () => {
    for (const bytes of [
        Buffer.from([0xff]),
        Buffer.from('{'),
        encode(value('\ud800')),
        encode(value('  ')),
        encode(null),
    ]) {
        assert.throws(() => validateResult(bytes, 'pdf', digest));
    }
});
test('accepts exact text limit and rejects one byte more or oversized wire result', () => {
    assert.equal(
        validateResult(
            encode(value('x'.repeat(policy.textBytes))),
            'pdf',
            digest
        ).textBytes,
        policy.textBytes
    );
    assert.throws(() =>
        validateResult(
            encode(value('x'.repeat(policy.textBytes + 1))),
            'pdf',
            digest
        )
    );
    assert.throws(() =>
        validateResult(Buffer.alloc(policy.resultBytes + 1), 'pdf', digest)
    );
});
test('rejects excess pages and does not accept PDF pages as DOCX structure', () => {
    const result = value();
    result.segments = Array.from(
        { length: policy.maxSegments + 1 },
        (_, index) => ({ kind: 'page', index: index + 1, text: 'hello' })
    );
    assert.throws(() => validateResult(encode(result), 'pdf', digest));
    assert.throws(() =>
        validateResult(encode({ ...value(), format: 'docx' }), 'docx', digest)
    );
});
