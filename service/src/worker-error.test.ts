import { describe, expect, test } from 'bun:test';
import { SessionFilesError } from './runtime-session/files';
import { workerDeadlineFailure } from './worker-error';

describe('workerDeadlineFailure', () => {
    test('preserves a typed input-delivery abort when the shared deadline also fired', () => {
        const failure = workerDeadlineFailure(
            new SessionFilesError(
                'SESSION_INPUT_ABORTED',
                'Session input delivery aborted',
            ),
            true,
            300_000,
        );

        expect(failure?.message).toBe(
            'SESSION_INPUT_ABORTED: Session input delivery aborted',
        );
    });

    test('keeps unrelated deadline failures on the generic timeout path', () => {
        const failure = workerDeadlineFailure(
            new Error('unrelated failure'),
            true,
            300_000,
        );

        expect(failure?.message).toBe('Job timed out after 300000ms');
    });

    test('leaves non-deadline failures for the remaining worker classifiers', () => {
        expect(
            workerDeadlineFailure(
                new Error('unrelated failure'),
                false,
                300_000,
            ),
        ).toBeUndefined();
    });
});
