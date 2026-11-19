import { describe, expect, test } from 'bun:test';
import { mergeContinuationFiles } from './continuation-files';
import type { RequestFile } from '../types';
const file: RequestFile = {
    id: 'aaaaaaaaaaaaaaaaaaaaa',
    storage_session_id: 'bbbbbbbbbbbbbbbbbbbbb',
    resource_id: 'syntheticuser01',
    kind: 'user',
    name: 'fixture.pdf',
};
describe('continuation file references', () => {
    test('merges references idempotently', () => {
        const results = [{ call_id: 'call_001', files: [file] }];
        const issued = new Set(['call_001']);
        expect(mergeContinuationFiles([], results, issued)).toEqual([file]);
        expect(mergeContinuationFiles([file], results, issued)).toEqual([file]);
    });
    test('rejects unissued calls and replacements', () => {
        expect(() =>
            mergeContinuationFiles(
                [],
                [{ call_id: 'call_002', files: [file] }],
                new Set(),
            ),
        ).toThrow();
        expect(() =>
            mergeContinuationFiles(
                [file],
                [
                    {
                        call_id: 'call_001',
                        files: [{ ...file, id: 'syntheticfile000000002' }],
                    },
                ],
                new Set(['call_001']),
            ),
        ).toThrow();
    });
    test('rejects traversal and aggregate overflow', () => {
        expect(() =>
            mergeContinuationFiles(
                [],
                [
                    {
                        call_id: 'call_001',
                        files: [{ ...file, name: '../fixture.pdf' }],
                    },
                ],
                new Set(['call_001']),
            ),
        ).toThrow();
        expect(() =>
            mergeContinuationFiles(
                [],
                [
                    {
                        call_id: 'call_001',
                        files: Array.from({ length: 101 }, (_, i) => ({
                            ...file,
                            name: `fixture-${i}.pdf`,
                        })),
                    },
                ],
                new Set(['call_001']),
            ),
        ).toThrow();
    });
});

test('preserves immutable file references in continuation result validation', async () => {
    const { validateToolResult, validateContinuationBatch } =
        await import('./replay-state');
    const result = {
        call_id: 'call_001',
        result: { filename: file.name },
        is_error: false,
        files: [file],
    };
    expect(validateToolResult(result)).toMatchObject({ files: [file] });
    expect(validateContinuationBatch([result])).toMatchObject({
        ok: true,
        results: [{ files: [file] }],
    });
    expect(validateToolResult({ ...result, is_error: true })).toHaveProperty(
        'error',
    );
});
