import { describe, expect, test } from 'bun:test';
import {
    summarizeRequestedFiles,
    summarizeSandboxResponse,
    summarizeText,
} from './execution-log';

describe('execution log summaries', () => {
    test('summarizes text without retaining content', () => {
        expect(summarizeText('secret stdout')).toEqual({
            length: 13,
            present: true,
        });
        expect(summarizeText('')).toEqual({ length: 0, present: false });
    });

    test('summarizes sandbox output without logging stdout/stderr/output bodies', () => {
        const summary = summarizeSandboxResponse({
            session_id: 'sess_123',
            language: 'bash',
            version: '5.2.0',
            files: [
                { id: 'file_1', name: 'a.txt', inherited: true },
                {
                    id: 'file_2',
                    name: 'b.txt',
                    modified_from: {
                        id: 'file_1',
                        storage_session_id: 'sess_old',
                    },
                },
            ],
            run: {
                code: 0,
                stdout: 'top secret stdout',
                stderr: 'sensitive stderr',
                output: 'combined output',
                message: null,
                wall_time: 42,
            },
        });

        expect(JSON.stringify(summary)).not.toContain('top secret stdout');
        expect(JSON.stringify(summary)).not.toContain('sensitive stderr');
        expect(JSON.stringify(summary)).not.toContain('combined output');
        expect(summary).toMatchObject({
            session_id: 'sess_123',
            files: { count: 2, inheritedCount: 1, modifiedCount: 1 },
            run: {
                stdout: { length: 17, present: true },
                stderr: { length: 16, present: true },
                output: { length: 15, present: true },
            },
        });
    });

    test('summarizes requested file scope counts without retaining file names or ids', () => {
        const summary = summarizeRequestedFiles([
            { id: 'file_1', name: 'secret.csv', kind: 'user' },
            { id: 'file_2', name: 'skill.ts', kind: 'skill' },
            { id: 'file_3', name: 'agent.md', kind: 'agent' },
        ]);

        expect(JSON.stringify(summary)).not.toContain('secret.csv');
        expect(JSON.stringify(summary)).not.toContain('file_1');
        expect(summary).toEqual({
            count: 3,
            skillCount: 1,
            agentCount: 1,
            userCount: 1,
        });
    });
});
