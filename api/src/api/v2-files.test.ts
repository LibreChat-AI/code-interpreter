import { describe, expect, test } from 'bun:test';
import { config } from '../config';
import type { TFile } from '../job';
import { validateExecuteArguments, validateExecuteFiles } from './v2';

function messageOf(fn: () => void): string {
    try {
        fn();
    } catch (error) {
        return (error as { message?: string }).message ?? String(error);
    }
    return '';
}

describe('execute file validation', () => {
    test('rejects duplicate and ancestor-conflicting destinations before priming', () => {
        expect(
            messageOf(() =>
                validateExecuteFiles([
                    { name: 'data.csv', content: 'a' },
                    { name: 'data.csv', content: 'b' },
                ]),
            ),
        ).toContain('duplicate destination');

        expect(
            messageOf(() =>
                validateExecuteFiles([
                    { name: 'results', content: 'file' },
                    { name: 'results/out.csv', content: 'nested' },
                ]),
            ),
        ).toContain('conflicting destinations');
    });

    test('rejects malformed stable cache identities', () => {
        expect(
            messageOf(() =>
                validateExecuteFiles([
                    {
                        id: 'masked',
                        storage_session_id: 'masked-session',
                        name: 'data.csv',
                        input_cache_key: '../not-a-key',
                    },
                ]),
            ),
        ).toContain('64-character lowercase hex digest');
    });

    test('rejects ambiguous and type-confused inline/reference shapes', () => {
        expect(
            messageOf(() => validateExecuteFiles([null as unknown as TFile])),
        ).toContain('must be an object');
        expect(
            messageOf(() =>
                validateExecuteFiles([
                    {
                        name: 'data.csv',
                        content: 'inline',
                        id: 'masked',
                        storage_session_id: 'masked-session',
                    },
                ]),
            ),
        ).toContain('exactly one');
        expect(
            messageOf(() =>
                validateExecuteFiles([
                    {
                        name: 'data.csv',
                        content: 'inline',
                        id: 123,
                        storage_session_id: {} as string,
                        input_cache_key: 'a'.repeat(64),
                    } as unknown as TFile,
                ]),
            ),
        ).toContain('id must be a non-empty string');
        expect(
            messageOf(() =>
                validateExecuteFiles([
                    {
                        name: 'data.csv',
                        id: 'masked',
                    },
                ]),
            ),
        ).toContain('storage_session_id');
        expect(
            messageOf(() =>
                validateExecuteFiles([
                    {
                        name: 'data.csv',
                        content: 'inline',
                        input_cache_key: 'a'.repeat(64),
                    },
                ]),
            ),
        ).toContain('inline content cannot include');
    });

    test('validates args and stdin before any workspace priming', () => {
        expect(messageOf(() => validateExecuteArguments(123, ''))).toContain(
            'args',
        );
        expect(
            messageOf(() => validateExecuteArguments(['ok', 123], '')),
        ).toContain('args');
        expect(messageOf(() => validateExecuteArguments([], 123))).toContain(
            'stdin',
        );
        expect(() =>
            validateExecuteArguments(['--flag'], 'input'),
        ).not.toThrow();
    });

    test('caps total destinations even when they all reference one object', () => {
        const files = Array.from(
            { length: config.max_input_files + 1 },
            (_, i) => ({
                id: 'masked',
                storage_session_id: 'masked-session',
                name: `copy-${i}.csv`,
            }),
        );
        expect(messageOf(() => validateExecuteFiles(files))).toContain(
            'cannot contain more than',
        );
    });

    test('accepts one object at several independent destinations', () => {
        const key = 'a'.repeat(64);
        const files: TFile[] = [
            {
                id: 'masked',
                storage_session_id: 'masked-session',
                name: 'a.csv',
                input_cache_key: key,
            },
            {
                id: 'masked',
                storage_session_id: 'masked-session',
                name: 'copy/a.csv',
                input_cache_key: key,
            },
        ];
        expect(() => validateExecuteFiles(files)).not.toThrow();
    });
});
