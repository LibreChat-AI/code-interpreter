import { describe, expect, test } from 'bun:test';
import {
    parsePlanLimits,
    resolveRuntimeSessionMode,
    resolveSandboxBackend,
} from './config';

describe('sandbox execution configuration', () => {
    test('defaults only unset backend and session mode values', () => {
        expect(resolveSandboxBackend(undefined)).toBe('http');
        expect(resolveRuntimeSessionMode(undefined)).toBe('stateless');
    });

    test('accepts every supported backend and session mode', () => {
        expect(resolveSandboxBackend('http')).toBe('http');
        expect(resolveSandboxBackend('lambda-microvm')).toBe('lambda-microvm');
        expect(resolveRuntimeSessionMode('stateless')).toBe('stateless');
        expect(resolveRuntimeSessionMode('affinity')).toBe('affinity');
        expect(resolveRuntimeSessionMode('strict')).toBe('strict');
    });

    test('rejects unknown values instead of silently changing execution semantics', () => {
        expect(() => resolveSandboxBackend('lambda_microvm')).toThrow(
            'CODEAPI_SANDBOX_BACKEND must be one of: http, lambda-microvm',
        );
        expect(() => resolveSandboxBackend('')).toThrow(
            'CODEAPI_SANDBOX_BACKEND',
        );
        expect(() => resolveSandboxBackend(' ')).toThrow(
            'CODEAPI_SANDBOX_BACKEND',
        );
        expect(() => resolveRuntimeSessionMode('stateful')).toThrow(
            'CODEAPI_RUNTIME_SESSION_MODE must be one of: stateless, affinity, strict',
        );
        expect(() => resolveRuntimeSessionMode('')).toThrow(
            'CODEAPI_RUNTIME_SESSION_MODE',
        );
        expect(() => resolveRuntimeSessionMode(' ')).toThrow(
            'CODEAPI_RUNTIME_SESSION_MODE',
        );
    });
});

describe('parsePlanLimits', () => {
    test('returns an empty catalog when unset or blank', () => {
        expect(parsePlanLimits(undefined)).toEqual({});
        expect(parsePlanLimits('')).toEqual({});
        expect(parsePlanLimits('   ')).toEqual({});
    });

    test('parses a plan catalog keyed by plan id', () => {
        expect(
            parsePlanLimits(
                '{"plan_a":{"run_memory_limit":1048576,"max_file_size":2048}}',
            ),
        ).toEqual({
            plan_a: { run_memory_limit: 1048576, max_file_size: 2048 },
        });
    });

    test('rejects malformed catalogs', () => {
        expect(() => parsePlanLimits('{nope')).toThrow('not valid JSON');
        expect(() => parsePlanLimits('[1]')).toThrow('JSON object');
        expect(() => parsePlanLimits('"plan_a"')).toThrow('JSON object');
        expect(() => parsePlanLimits('null')).toThrow('JSON object');
    });
});
