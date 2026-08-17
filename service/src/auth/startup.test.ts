import { describe, expect, test } from 'bun:test';
import { AuthProviderConfigError } from './provider';
import { validateStartupAuthConfig } from './startup';

describe('validateStartupAuthConfig', () => {
    test('validates JWT verifier config without legacy auth config in JWT-only mode', async () => {
        let jwtConfigValidated = false;

        await validateStartupAuthConfig({
            mode: 'librechat-jwt',
            isLocalMode: false,
            validateJwtVerifierConfig: () => {
                jwtConfigValidated = true;
            },
        });

        expect(jwtConfigValidated).toBe(true);
    });

    test('fails closed when auth provider none is not explicitly allowed', async () => {
        await expect(
            validateStartupAuthConfig({
                mode: 'none',
                isLocalMode: false,
                allowNone: false,
            }),
        ).rejects.toBeInstanceOf(AuthProviderConfigError);
    });
});
