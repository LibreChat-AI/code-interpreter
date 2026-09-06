import { describe, expect, test } from 'bun:test';
import { reconcileArtifactDelivery } from './delivery';

describe('reconcileArtifactDelivery', () => {
    test('leaves successful and inherited file references unchanged', () => {
        const files = [
            { id: 'generated', name: 'result.txt' },
            { id: 'inherited', name: 'input.txt', inherited: true as const },
        ];

        expect(
            reconcileArtifactDelivery(
                files,
                ['generated'],
                new Set(['generated']),
            ),
        ).toEqual({ files });
    });

    test('reports a complete delivery failure without returning phantom references', () => {
        const files = [
            { id: 'generated', name: 'result.txt' },
            { id: 'inherited', name: 'input.txt', inherited: true as const },
        ];

        expect(
            reconcileArtifactDelivery(files, ['generated'], new Set()),
        ).toEqual({
            files: [{ id: 'inherited', name: 'input.txt', inherited: true }],
            artifact_delivery: {
                code: 'artifact_delivery_failed',
                status: 'failed',
                attempted: 1,
                delivered: 0,
                failed: 1,
            },
        });
    });

    test('reports partial delivery and counts only expected generated ids', () => {
        const files = [
            { id: 'first', name: 'first.txt' },
            { id: 'second', name: 'second.txt' },
        ];

        expect(
            reconcileArtifactDelivery(
                files,
                ['first', 'second'],
                new Set(['first', 'unknown']),
            ),
        ).toEqual({
            files: [{ id: 'first', name: 'first.txt' }],
            artifact_delivery: {
                code: 'artifact_delivery_failed',
                status: 'partial',
                attempted: 2,
                delivered: 1,
                failed: 1,
            },
        });
    });

    test('does not report a failure when there were no generated files', () => {
        const files = [
            { id: 'inherited', name: 'input.txt', inherited: true as const },
        ];

        expect(reconcileArtifactDelivery(files, [], new Set())).toEqual({
            files,
        });
    });
});
