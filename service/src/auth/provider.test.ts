import { afterEach, describe, expect, test } from 'bun:test';
import { AuthProviderConfigError, getAuthProviderMode } from './provider';

const originalProvider = process.env.CODEAPI_AUTH_PROVIDER;

afterEach(() => {
    if (originalProvider === undefined) {
        delete process.env.CODEAPI_AUTH_PROVIDER;
    } else {
        process.env.CODEAPI_AUTH_PROVIDER = originalProvider;
    }
});

describe('CodeAPI auth provider mode', () => {
    test('defaults to LibreChat JWT mode when unset', () => {
        delete process.env.CODEAPI_AUTH_PROVIDER;

        expect(getAuthProviderMode()).toBe('librechat-jwt');
    });

    test('accepts configured provider modes', () => {
        process.env.CODEAPI_AUTH_PROVIDER = 'librechat-jwt';
        expect(getAuthProviderMode()).toBe('librechat-jwt');

        process.env.CODEAPI_AUTH_PROVIDER = 'none';
        expect(getAuthProviderMode()).toBe('none');
    });

    test('rejects unknown provider modes instead of falling back', () => {
        process.env.CODEAPI_AUTH_PROVIDER = 'typo';

        expect(() => getAuthProviderMode()).toThrow(AuthProviderConfigError);
    });
});
