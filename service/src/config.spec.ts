import { describe, expect, it } from 'bun:test';
import {
    jobCompletionWaitTimeoutMs,
    jobDeadlineAtMs,
    languageConfig,
    lambdaMicrovmNumericConfigError,
    resolveEgressGrantTtlSeconds,
    resolveLanguage,
    resolveLambdaMicrovmNumericConfig,
} from './config';
import { Languages } from './enum';
import { createPayload } from './payload';
import type { AuthenticatedRequest } from './types';

describe('node language configuration', () => {
    it('resolves Node.js aliases', () => {
        for (const alias of ['node', 'nodejs', 'node-js', 'node-javascript']) {
            expect(resolveLanguage(alias)).toBe(Languages.node);
        }
    });

    it('maps Node.js requests to the node sandbox runtime', () => {
        expect(languageConfig[Languages.node]).toEqual({
            language: 'node',
            version: '24.15.0',
            fileName: 'index.js',
        });
    });

    it('creates a valid Node.js execution payload', () => {
        const req = {
            body: {
                lang: 'node',
                code: 'console.log("hello from node")',
                args: ['--trace-warnings'],
                files: [],
            },
        } as unknown as AuthenticatedRequest;

        const payload = createPayload({
            req,
            isPyPlot: false,
            session_id: 'session-node',
        });

        expect(payload).toMatchObject({
            language: 'node',
            version: '24.15.0',
            session_id: 'session-node',
            args: ['--trace-warnings'],
            files: [
                {
                    name: 'index.js',
                    content: 'console.log("hello from node")',
                },
            ],
        });
    });
});

describe('runtime version configuration', () => {
    it('maps Python requests to Python 3.14.4', () => {
        expect(languageConfig[Languages.py]).toMatchObject({
            language: 'python',
            version: '3.14.4',
            fileName: 'main.py',
        });
    });

    it('maps Bun JavaScript and TypeScript requests to Bun 1.3.14', () => {
        expect(languageConfig[Languages.js]).toMatchObject({
            language: 'bun-js',
            version: '1.3.14',
            fileName: 'index.js',
        });
        expect(languageConfig[Languages.ts]).toMatchObject({
            language: 'bun-ts',
            version: '1.3.14',
            fileName: 'main.ts',
        });
    });
});

describe('egress grant TTL configuration', () => {
    it('defaults to job timeout plus grace without a fixed 30 minute cap', () => {
        expect(resolveEgressGrantTtlSeconds(undefined, 45 * 60 * 1000)).toBe(
            55 * 60,
        );
    });

    it('honors explicit positive TTL overrides', () => {
        expect(resolveEgressGrantTtlSeconds('7200', 300000)).toBe(7200);
        expect(resolveEgressGrantTtlSeconds('1.2', 300000)).toBe(2);
    });

    it('falls back to the job-based default for invalid overrides', () => {
        expect(resolveEgressGrantTtlSeconds('0', 300000)).toBe(900);
        expect(resolveEgressGrantTtlSeconds('-1', 300000)).toBe(900);
        expect(resolveEgressGrantTtlSeconds('not-a-number', 300000)).toBe(900);
    });
});

describe('job deadline accounting', () => {
    it('counts time spent waiting in BullMQ against JOB_TIMEOUT', () => {
        expect(jobDeadlineAtMs(1_000, 300_000, 50_000)).toBe(301_000);
    });

    it('falls back to worker start only when enqueue time is unavailable', () => {
        expect(jobDeadlineAtMs(undefined, 300_000, 50_000)).toBe(350_000);
        expect(jobDeadlineAtMs(Number.NaN, 300_000, 50_000)).toBe(350_000);
    });

    it('gives the worker bounded cleanup time after the execution deadline', () => {
        expect(jobCompletionWaitTimeoutMs(300_000, 60_000, 5_000)).toBe(
            370_000,
        );
    });
});

describe('Lambda MicroVM numeric configuration', () => {
    it('uses defaults only for absent or blank values and preserves suspend=0', () => {
        expect(resolveLambdaMicrovmNumericConfig({})).toMatchObject({
            LAMBDA_MICROVM_PORT: 8080,
            LAMBDA_MICROVM_MAX_DURATION_SECONDS: 28_800,
            LAMBDA_MICROVM_IDLE_SECONDS: 1_800,
            LAMBDA_MICROVM_SUSPEND_SECONDS: 1_800,
            LAMBDA_MICROVM_AUTH_TOKEN_TTL_SECONDS: 300,
            LAMBDA_MICROVM_LAUNCH_TIMEOUT_MS: 60_000,
            LAMBDA_MICROVM_HEALTH_TIMEOUT_MS: 5_000,
            LAMBDA_MICROVM_LAUNCH_TPS: 4,
            LAMBDA_MICROVM_TOKEN_TPS: 8,
        });
        expect(
            resolveLambdaMicrovmNumericConfig({
                LAMBDA_MICROVM_SUSPEND_SECONDS: '0',
                LAMBDA_MICROVM_PORT: ' ',
            }).LAMBDA_MICROVM_SUSPEND_SECONDS,
        ).toBe(0);
    });

    it('accepts the supported boundary values', () => {
        const numeric = resolveLambdaMicrovmNumericConfig({
            LAMBDA_MICROVM_PORT: '1',
            LAMBDA_MICROVM_MAX_DURATION_SECONDS: '28800',
            LAMBDA_MICROVM_IDLE_SECONDS: '60',
            LAMBDA_MICROVM_SUSPEND_SECONDS: '0',
            LAMBDA_MICROVM_AUTH_TOKEN_TTL_SECONDS: '1',
            LAMBDA_MICROVM_LAUNCH_TIMEOUT_MS: '1',
            LAMBDA_MICROVM_HEALTH_TIMEOUT_MS: '1',
            LAMBDA_MICROVM_LAUNCH_TPS: '1',
            LAMBDA_MICROVM_TOKEN_TPS: '1',
        });
        expect(lambdaMicrovmNumericConfigError(numeric)).toBeUndefined();
    });

    it('rejects non-integers and values outside the supported ranges', () => {
        const cases: Array<[string, string, string]> = [
            ['LAMBDA_MICROVM_PORT', '0', 'between 1 and 65535'],
            ['LAMBDA_MICROVM_PORT', '65536', 'between 1 and 65535'],
            [
                'LAMBDA_MICROVM_MAX_DURATION_SECONDS',
                '28801',
                'between 1 and 28800',
            ],
            ['LAMBDA_MICROVM_IDLE_SECONDS', '59', 'between 60 and 28800'],
            ['LAMBDA_MICROVM_SUSPEND_SECONDS', '-1', 'between 0 and 28800'],
            [
                'LAMBDA_MICROVM_AUTH_TOKEN_TTL_SECONDS',
                '901',
                'between 1 and 900',
            ],
            ['LAMBDA_MICROVM_LAUNCH_TIMEOUT_MS', '0', 'at least 1'],
            ['LAMBDA_MICROVM_HEALTH_TIMEOUT_MS', 'NaN', 'at least 1'],
            ['LAMBDA_MICROVM_LAUNCH_TPS', '1.5', 'at least 1'],
            ['LAMBDA_MICROVM_TOKEN_TPS', '-1', 'at least 1'],
        ];

        for (const [name, value, expected] of cases) {
            const numeric = resolveLambdaMicrovmNumericConfig({
                [name]: value,
            });
            expect(lambdaMicrovmNumericConfigError(numeric)).toContain(name);
            expect(lambdaMicrovmNumericConfigError(numeric)).toContain(
                expected,
            );
        }
    });
});
