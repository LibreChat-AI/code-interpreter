import { describe, expect, test } from 'bun:test';
import {
    RUNTIME_SESSION_HINT_MAX_LENGTH,
    RuntimeSessionHintError,
    deriveRuntimeSessionId,
    resolveRuntimeSessionIdForExecRequest,
    resolveRuntimeSessionIdForRequest,
    validateRuntimeSessionHint,
} from './id';

const BASE = { storageNamespace: 'tenant-a', canonicalUserId: 'user-1' };

describe('deriveRuntimeSessionId', () => {
    test('is deterministic and shaped rt_<40 hex>', () => {
        const first = deriveRuntimeSessionId({ ...BASE, hint: 'conv-1' });
        const second = deriveRuntimeSessionId({ ...BASE, hint: 'conv-1' });
        expect(first).toBe(second);
        expect(first).toMatch(/^rt_[0-9a-f]{40}$/);
    });

    test('preserves established ids for ordinary identity fields', () => {
        expect(deriveRuntimeSessionId({ ...BASE, hint: 'conv-1' })).toBe(
            'rt_27ecde4cf502ef6bc0610e7bd8e025bf889ffec1',
        );
    });

    test('separates tenants, users, and hints', () => {
        const base = deriveRuntimeSessionId({ ...BASE, hint: 'conv-1' });
        expect(
            deriveRuntimeSessionId({
                storageNamespace: 'tenant-b',
                canonicalUserId: 'user-1',
                hint: 'conv-1',
            }),
        ).not.toBe(base);
        expect(
            deriveRuntimeSessionId({
                storageNamespace: 'tenant-a',
                canonicalUserId: 'user-2',
                hint: 'conv-1',
            }),
        ).not.toBe(base);
        expect(deriveRuntimeSessionId({ ...BASE, hint: 'conv-2' })).not.toBe(
            base,
        );
    });

    test('absent hint maps to a stable per-user default session', () => {
        expect(deriveRuntimeSessionId(BASE)).toBe(
            deriveRuntimeSessionId({ ...BASE, hint: undefined }),
        );
        expect(deriveRuntimeSessionId(BASE)).not.toBe(
            deriveRuntimeSessionId({ ...BASE, hint: 'conv-1' }),
        );
    });

    test('field boundaries cannot be forged across namespace/user/hint', () => {
        const a = deriveRuntimeSessionId({
            storageNamespace: 'ten',
            canonicalUserId: 'ant-user',
            hint: 'h',
        });
        const b = deriveRuntimeSessionId({
            storageNamespace: 'ten-ant',
            canonicalUserId: 'user',
            hint: 'h',
        });
        expect(a).not.toBe(b);
    });

    test('NUL in authenticated identity fields cannot forge field boundaries', () => {
        const a = deriveRuntimeSessionId({
            storageNamespace: 'a',
            canonicalUserId: 'b\u0000c',
            hint: 'd',
        });
        const b = deriveRuntimeSessionId({
            storageNamespace: 'a\u0000b',
            canonicalUserId: 'c',
            hint: 'd',
        });
        expect(a).not.toBe(b);
    });
});

describe('validateRuntimeSessionHint', () => {
    test('passes through valid hints and treats absent/empty as undefined', () => {
        expect(validateRuntimeSessionHint('conv_123.a:b-c')).toBe(
            'conv_123.a:b-c',
        );
        expect(validateRuntimeSessionHint(undefined)).toBeUndefined();
        expect(validateRuntimeSessionHint(null)).toBeUndefined();
        expect(validateRuntimeSessionHint('')).toBeUndefined();
    });

    test('rejects non-strings, oversize, and forbidden characters', () => {
        expect(() => validateRuntimeSessionHint(42)).toThrow(
            RuntimeSessionHintError,
        );
        expect(() => validateRuntimeSessionHint({})).toThrow(
            RuntimeSessionHintError,
        );
        expect(() =>
            validateRuntimeSessionHint(
                'x'.repeat(RUNTIME_SESSION_HINT_MAX_LENGTH + 1),
            ),
        ).toThrow('at most');
        expect(() => validateRuntimeSessionHint('has space')).toThrow(
            'may only contain',
        );
        expect(() => validateRuntimeSessionHint('emoji🙂')).toThrow(
            'may only contain',
        );
        expect(
            validateRuntimeSessionHint(
                'x'.repeat(RUNTIME_SESSION_HINT_MAX_LENGTH),
            ),
        ).toHaveLength(RUNTIME_SESSION_HINT_MAX_LENGTH);
    });
});

describe('resolveRuntimeSessionIdForRequest', () => {
    test('stateless mode never derives an id, even with a hint', () => {
        expect(
            resolveRuntimeSessionIdForRequest({
                mode: 'stateless',
                ...BASE,
                hint: 'conv-1',
            }),
        ).toBeUndefined();
    });

    test('affinity and strict modes derive the same id for the same inputs', () => {
        const affinity = resolveRuntimeSessionIdForRequest({
            mode: 'affinity',
            ...BASE,
            hint: 'conv-1',
        });
        const strict = resolveRuntimeSessionIdForRequest({
            mode: 'strict',
            ...BASE,
            hint: 'conv-1',
        });
        expect(affinity).toBeDefined();
        expect(affinity).toBe(strict as string);
    });

    /* A hintless request must never land on a session: deriving from the
     * default hint would silently share one persistent per-user workspace
     * across every hintless conversation. */
    test('affinity mode without a hint degrades to stateless', () => {
        expect(
            resolveRuntimeSessionIdForRequest({ mode: 'affinity', ...BASE }),
        ).toBeUndefined();
        expect(
            resolveRuntimeSessionIdForRequest({
                mode: 'affinity',
                ...BASE,
                hint: '',
            }),
        ).toBeUndefined();
    });

    test('strict mode without a hint is rejected', () => {
        expect(() =>
            resolveRuntimeSessionIdForRequest({ mode: 'strict', ...BASE }),
        ).toThrow(RuntimeSessionHintError);
    });
});

describe('resolveRuntimeSessionIdForExecRequest', () => {
    test('stateless requests continue to ignore malformed hints', () => {
        expect(
            resolveRuntimeSessionIdForExecRequest({
                mode: 'stateless',
                ...BASE,
                runtimeSessionHint: { ignored: true },
                isSynthetic: false,
            }),
        ).toBeUndefined();
    });

    test('strict-mode synthetic requests remain stateless without a hint', () => {
        expect(
            resolveRuntimeSessionIdForExecRequest({
                mode: 'strict',
                ...BASE,
                runtimeSessionHint: undefined,
                isSynthetic: true,
            }),
        ).toBeUndefined();
    });

    test('synthetic requests bypass validation for an ignored malformed hint', () => {
        expect(
            resolveRuntimeSessionIdForExecRequest({
                mode: 'strict',
                ...BASE,
                runtimeSessionHint: { forged: true },
                isSynthetic: true,
            }),
        ).toBeUndefined();
    });

    test('strict-mode ordinary requests still validate and require a hint', () => {
        expect(() =>
            resolveRuntimeSessionIdForExecRequest({
                mode: 'strict',
                ...BASE,
                runtimeSessionHint: undefined,
                isSynthetic: false,
            }),
        ).toThrow('runtime_session_hint is required in strict mode');
        expect(() =>
            resolveRuntimeSessionIdForExecRequest({
                mode: 'strict',
                ...BASE,
                runtimeSessionHint: { forged: true },
                isSynthetic: false,
            }),
        ).toThrow('runtime_session_hint must be a string');
    });
});
