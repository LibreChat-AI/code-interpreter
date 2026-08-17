import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { generateKeyPairSync, sign as cryptoSign } from 'crypto';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { KeyObject } from 'crypto';
import { CodeApiJwtAuthError, verifyLibreChatJwt } from './librechat-jwt';

const ENV_KEYS = [
    'CODEAPI_JWT_ISSUER',
    'CODEAPI_JWT_AUDIENCE',
    'CODEAPI_JWT_ALLOWED_ALGS',
    'CODEAPI_JWT_CLOCK_SKEW_SECONDS',
    'CODEAPI_JWT_MAX_TTL_SECONDS',
    'CODEAPI_JWT_KEY_CACHE_TTL_SECONDS',
    'CODEAPI_JWT_JWKS_JSON',
    'CODEAPI_JWT_PUBLIC_KEYS_DIR',
    'CODEAPI_JWT_PUBLIC_KEY',
    'CODEAPI_JWT_KID',
    'CODEAPI_JWT_KEY_ID',
    'CODEAPI_JWT_HS256_KID',
    'CODEAPI_JWT_HS256_SECRET',
    'CODEAPI_JWT_SINGLE_TENANT_ID',
    'CODEAPI_TENANT_ISOLATION_STRICT',
] as const;

type JwtHeader = {
    alg: 'EdDSA' | 'RS256' | 'HS256';
    typ?: string;
    kid: string;
};

type JwtClaims = {
    iss: string;
    aud: string | string[];
    sub: string;
    iat: number;
    nbf: number;
    exp: number;
    jti: string;
    tenant_id?: string;
    role?: string;
    principal_source?: string;
    org_id?: string;
    service_id?: string;
    external_user_id?: string;
    /** Legacy alias for external_user_id still minted by the production issuer. */
    chc_user_id?: string;
    auth_context_hash?: string;
    plan_id?: string;
};

const originalEnv = new Map<string, string | undefined>();
let privateKey: KeyObject;

function base64Url(value: Buffer | string): string {
    return Buffer.from(value).toString('base64url');
}

function baseClaims(overrides: Partial<JwtClaims> = {}): JwtClaims {
    const now = Math.floor(Date.now() / 1000);
    return {
        iss: 'librechat',
        aud: 'codeapi',
        sub: 'user_123',
        iat: now,
        nbf: now,
        exp: now + 300,
        jti: 'jti_123',
        tenant_id: 'tenant_abc',
        role: 'USER',
        principal_source: 'openid_reuse',
        org_id: 'org_123',
        service_id: 'svc_123',
        external_user_id: 'chc_123',
        auth_context_hash: 'hash_123',
        plan_id: 'prod_plan_123',
        ...overrides,
    };
}

function signJwt(
    claims: JwtClaims,
    header: Partial<JwtHeader> = {},
    signingKey = privateKey,
): string {
    const fullHeader: JwtHeader = {
        alg: 'EdDSA',
        typ: 'JWT',
        kid: 'test-kid',
        ...header,
    };
    const signingInput = `${base64Url(JSON.stringify(fullHeader))}.${base64Url(
        JSON.stringify(claims),
    )}`;
    const signature = cryptoSign(
        fullHeader.alg === 'RS256' ? 'RSA-SHA256' : null,
        Buffer.from(signingInput),
        signingKey,
    );
    return `${signingInput}.${base64Url(signature)}`;
}

function expectJwtReason(token: string, reason: string): void {
    try {
        verifyLibreChatJwt(token);
        throw new Error('expected JWT verification to fail');
    } catch (error) {
        expect(error).toBeInstanceOf(CodeApiJwtAuthError);
        expect((error as CodeApiJwtAuthError).reason).toBe(reason);
    }
}

beforeEach(() => {
    if (originalEnv.size === 0) {
        for (const key of ENV_KEYS) {
            originalEnv.set(key, process.env[key]);
        }
    }

    const { publicKey, privateKey: generatedPrivateKey } =
        generateKeyPairSync('ed25519');
    privateKey = generatedPrivateKey;
    const jwk = publicKey.export({ format: 'jwk' });

    process.env.CODEAPI_JWT_ISSUER = 'librechat';
    process.env.CODEAPI_JWT_AUDIENCE = 'codeapi';
    process.env.CODEAPI_JWT_ALLOWED_ALGS = 'EdDSA,RS256';
    process.env.CODEAPI_JWT_CLOCK_SKEW_SECONDS = '30';
    process.env.CODEAPI_JWT_MAX_TTL_SECONDS = '300';
    process.env.CODEAPI_JWT_KEY_CACHE_TTL_SECONDS = '30';
    process.env.CODEAPI_JWT_JWKS_JSON = JSON.stringify({
        keys: [{ ...jwk, kid: 'test-kid', alg: 'EdDSA' }],
    });
    delete process.env.CODEAPI_JWT_PUBLIC_KEYS_DIR;
    delete process.env.CODEAPI_JWT_PUBLIC_KEY;
    delete process.env.CODEAPI_JWT_KID;
    delete process.env.CODEAPI_JWT_KEY_ID;
    delete process.env.CODEAPI_JWT_HS256_KID;
    delete process.env.CODEAPI_JWT_HS256_SECRET;
    delete process.env.CODEAPI_JWT_SINGLE_TENANT_ID;
    delete process.env.CODEAPI_TENANT_ISOLATION_STRICT;
});

afterEach(() => {
    for (const key of ENV_KEYS) {
        const value = originalEnv.get(key);
        if (value === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = value;
        }
    }
});

describe('LibreChat JWT auth provider', () => {
    test('verifies a LibreChat-minted CodeAPI token into a canonical principal', () => {
        const principal = verifyLibreChatJwt(signJwt(baseClaims()));

        expect(principal).toEqual({
            userId: 'user_123',
            tenantId: 'tenant_abc',
            role: 'USER',
            orgId: 'org_123',
            serviceId: 'svc_123',
            externalUserId: 'chc_123',
            principalSource: 'openid_reuse',
            authContextHash: 'hash_123',
            planId: 'prod_plan_123',
        });
    });

    test('accepts the legacy chc_user_id claim as externalUserId', () => {
        const principal = verifyLibreChatJwt(
            signJwt(
                baseClaims({
                    external_user_id: undefined,
                    chc_user_id: 'chc_legacy_456',
                }),
            ),
        );
        expect(principal.externalUserId).toBe('chc_legacy_456');
    });

    test('prefers external_user_id over the legacy claim when both are present', () => {
        const principal = verifyLibreChatJwt(
            signJwt(
                baseClaims({
                    external_user_id: 'ext_789',
                    chc_user_id: 'chc_legacy_456',
                }),
            ),
        );
        expect(principal.externalUserId).toBe('ext_789');
    });

    test('rejects expired tokens', () => {
        const now = Math.floor(Date.now() / 1000);
        expectJwtReason(signJwt(baseClaims({ exp: now - 31 })), 'expired');
    });

    test('rejects future nbf and future iat beyond the 30 second skew', () => {
        const now = Math.floor(Date.now() / 1000);
        expectJwtReason(
            signJwt(baseClaims({ nbf: now + 31 })),
            'not_yet_valid',
        );
        expectJwtReason(signJwt(baseClaims({ iat: now + 31 })), 'future_iat');
    });

    test('rejects tokens whose lifetime exceeds the CodeAPI maximum', () => {
        const now = Math.floor(Date.now() / 1000);
        expectJwtReason(
            signJwt(baseClaims({ iat: now, nbf: now, exp: now + 301 })),
            'ttl_too_long',
        );
    });

    test('rejects invalid allowed algorithm configuration instead of defaulting open', () => {
        process.env.CODEAPI_JWT_ALLOWED_ALGS = 'ES256, PS256';
        expectJwtReason(signJwt(baseClaims()), 'config');
    });

    test('rejects wrong audience and issuer', () => {
        expectJwtReason(
            signJwt(baseClaims({ aud: 'other-api' })),
            'wrong_audience',
        );
        expectJwtReason(
            signJwt(baseClaims({ aud: ['other-api'] })),
            'wrong_audience',
        );
        expectJwtReason(
            signJwt(baseClaims({ iss: 'other-issuer' })),
            'wrong_issuer',
        );
    });

    test('accepts standard JWT audience arrays when they contain CodeAPI', () => {
        const principal = verifyLibreChatJwt(
            signJwt(baseClaims({ aud: ['account', 'codeapi'] })),
        );

        expect(principal.userId).toBe('user_123');
        expect(principal.tenantId).toBe('tenant_abc');
    });

    test('defaults missing tenant_id to the single-tenant namespace outside strict mode', () => {
        const principal = verifyLibreChatJwt(
            signJwt(baseClaims({ tenant_id: undefined })),
        );

        expect(principal.tenantId).toBe('legacy');
    });

    test('uses configured single-tenant namespace when tenant_id is absent outside strict mode', () => {
        process.env.CODEAPI_JWT_SINGLE_TENANT_ID = 'local-single-tenant';

        const principal = verifyLibreChatJwt(
            signJwt(baseClaims({ tenant_id: undefined })),
        );

        expect(principal.tenantId).toBe('local-single-tenant');
    });

    test('requires tenant_id when strict tenant isolation is enabled', () => {
        process.env.CODEAPI_TENANT_ISOLATION_STRICT = 'true';

        expectJwtReason(
            signJwt(baseClaims({ tenant_id: undefined })),
            'malformed_claims',
        );
    });

    test('reloads public key directory entries after the configured cache TTL', () => {
        const first = generateKeyPairSync('ed25519');
        const second = generateKeyPairSync('ed25519');
        const dir = mkdtempSync(join(tmpdir(), 'codeapi-jwt-keys-'));
        const keyPath = join(dir, 'test-kid.pem');
        const originalNow = Date.now;
        let nowMs = 1_778_250_000_000;

        try {
            Date.now = (): number => nowMs;
            delete process.env.CODEAPI_JWT_JWKS_JSON;
            process.env.CODEAPI_JWT_KEY_CACHE_TTL_SECONDS = '1';
            process.env.CODEAPI_JWT_PUBLIC_KEYS_DIR = dir;

            writeFileSync(
                keyPath,
                first.publicKey.export({
                    format: 'pem',
                    type: 'spki',
                }) as string,
            );
            const oldToken = signJwt(baseClaims(), {}, first.privateKey);
            expect(verifyLibreChatJwt(oldToken).userId).toBe('user_123');

            writeFileSync(
                keyPath,
                second.publicKey.export({
                    format: 'pem',
                    type: 'spki',
                }) as string,
            );
            expect(verifyLibreChatJwt(oldToken).userId).toBe('user_123');
            expectJwtReason(
                signJwt(
                    baseClaims({ jti: 'jti_before_reload' }),
                    {},
                    second.privateKey,
                ),
                'bad_signature',
            );

            nowMs += 1001;
            expectJwtReason(oldToken, 'bad_signature');
            expect(
                verifyLibreChatJwt(
                    signJwt(
                        baseClaims({ jti: 'jti_rotated' }),
                        {},
                        second.privateKey,
                    ),
                ).userId,
            ).toBe('user_123');
        } finally {
            Date.now = originalNow;
            rmSync(dir, { force: true, recursive: true });
        }
    });

    test('reports unreadable public key directory entries as config errors', () => {
        const dir = mkdtempSync(join(tmpdir(), 'codeapi-jwt-keys-'));

        try {
            delete process.env.CODEAPI_JWT_JWKS_JSON;
            process.env.CODEAPI_JWT_PUBLIC_KEYS_DIR = dir;
            symlinkSync(join(dir, 'missing.pem'), join(dir, 'test-kid.pem'));

            expectJwtReason(signJwt(baseClaims()), 'config');
        } finally {
            rmSync(dir, { force: true, recursive: true });
        }
    });

    test('rejects unknown kid and disallowed alg', () => {
        expectJwtReason(
            signJwt(baseClaims(), { kid: 'rotated-away' }),
            'unknown_kid',
        );
        expectJwtReason(
            signJwt(baseClaims(), { alg: 'HS256', kid: 'test-kid' }),
            'wrong_alg',
        );
    });

    test('rejects tampered signatures and malformed required claims', () => {
        const token = signJwt(baseClaims());
        const [encodedHeader, encodedPayload, encodedSignature] = token.split(
            '.',
        ) as [string, string, string];
        const signature = Buffer.from(encodedSignature, 'base64url');
        signature[0] ^= 0xff;
        const tampered = `${encodedHeader}.${encodedPayload}.${base64Url(signature)}`;

        expectJwtReason(tampered, 'bad_signature');
        expectJwtReason(
            signJwt(baseClaims({ tenant_id: '' })),
            'malformed_claims',
        );
        expectJwtReason(
            signJwt(baseClaims({ auth_context_hash: undefined })),
            'malformed_claims',
        );
        expectJwtReason(
            signJwt(baseClaims({ principal_source: undefined })),
            'malformed_claims',
        );
        expectJwtReason(
            signJwt(baseClaims({ principal_source: 'api_key' })),
            'malformed_claims',
        );
        expectJwtReason(
            signJwt(baseClaims({ plan_id: 123 as unknown as string })),
            'malformed_claims',
        );
    });
});
