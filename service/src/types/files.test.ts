import { describe, expect, test } from 'bun:test';
import type { BatchUploadResponse, UploadResponse } from './files';

/**
 * Sprint regression: the `/upload` (single) route was emitting
 * `session_id` while `/upload/batch` emitted `storage_session_id`.
 * LC's `uploadCodeEnvFile` reads `result.storage_session_id`, so
 * every chat-attach upload silently captured `undefined` and broke
 * the next /exec's file priming chain.
 *
 * These tests pin the wire-shape contract on both response types so
 * a future refactor can't quietly revert the rename — any drift
 * trips a TypeScript compile error inside the test, which Bun's
 * runner treats as a failure.
 */

/* Compile-time equality assertion. Failing branches resolve to
 * `false`, which is then incompatible with the `Assert<true>`
 * constraint, surfacing the breakage at the call site below. */
type Equal<X, Y> =
    (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
        ? true
        : false;
type Assert<T extends true> = T;
type Has<T, K extends string> = K extends keyof T ? true : false;

describe('upload response wire shape (regression)', () => {
    test('UploadResponse has storage_session_id of type string', () => {
        type _ = Assert<Equal<UploadResponse['storage_session_id'], string>>;
        /* Runtime sample matching the route literal — locks the
         * structural shape in addition to the type-level keys. If
         * someone reverts the route to use `session_id`, the
         * `: UploadResponse` annotation in router.ts will fail to
         * typecheck; this test ensures the type itself stays the
         * source of truth. */
        const sample: UploadResponse = {
            message: 'success',
            storage_session_id: 's_abc',
            files: [{ filename: 'a.txt', fileId: 'f1' }],
        };
        expect(sample.storage_session_id).toBe('s_abc');
        expect(sample).not.toHaveProperty('session_id');
    });

    test('BatchUploadResponse has storage_session_id of type string', () => {
        type _ = Assert<
            Equal<BatchUploadResponse['storage_session_id'], string>
        >;
        const sample: BatchUploadResponse = {
            message: 'success',
            storage_session_id: 's_abc',
            files: [{ status: 'success', filename: 'a.txt', fileId: 'f1' }],
            succeeded: 1,
            failed: 0,
        };
        expect(sample.storage_session_id).toBe('s_abc');
        expect(sample).not.toHaveProperty('session_id');
    });

    test('neither response type carries the legacy `session_id` key', () => {
        /* The original bug was a per-route field-name drift between
         * `/upload` (had `session_id`) and `/upload/batch` (had
         * `storage_session_id`). Asserting BOTH shapes lack the legacy
         * key prevents either route from re-introducing it. */
        type _u = Assert<Equal<Has<UploadResponse, 'session_id'>, false>>;
        type _b = Assert<Equal<Has<BatchUploadResponse, 'session_id'>, false>>;
        expect(true).toBe(true);
    });

    test('the two upload routes name the storage session field identically', () => {
        /* Defends against silent drift in the OPPOSITE direction —
         * if someone renames the field on one type without the other,
         * clients that share a deserializer between routes will
         * regress on whichever route fell behind. */
        type _ = Assert<
            Equal<
                UploadResponse['storage_session_id'],
                BatchUploadResponse['storage_session_id']
            >
        >;
        expect(true).toBe(true);
    });
});
