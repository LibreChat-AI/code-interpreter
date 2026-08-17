import {
    createHmac,
    createPublicKey,
    timingSafeEqual,
    verify as cryptoVerify,
} from 'crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join, parse } from 'path';
import type { JsonWebKey, KeyObject } from 'crypto';
import type { Request } from 'express';
import type { AuthProvider } from './provider';
import type { CodeApiPrincipal } from './principal';

type JwtAlg = 'EdDSA' | 'RS256' | 'HS256';
type LibreChatPrincipalSource = 'librechat_jwt' | 'openid_reuse';

interface JwtHeader {
    alg?: string;
    typ?: string;
    kid?: string;
}

interface LibreChatJwtClaims {
    iss?: string;
    aud?: string | string[];
    sub?: string;
    iat?: number;
    nbf?: number;
    exp?: number;
    jti?: string;
    tenant_id?: string;
    role?: string;
    principal_source?: string;
    org_id?: string;
    service_id?: string;
    external_user_id?: string;
    /** @deprecated Legacy alias for `external_user_id`. The production token
     *  issuer still mints it; drop this once the issuer emits the new claim. */
    chc_user_id?: string; // leak-check:allow
    auth_context_hash?: string;
    plan_id?: string;
}

interface PublicKeyEntry {
    alg?: JwtAlg;
    key: KeyObject | Buffer;
}

interface VerificationConfig {
    issuer: string;
    audience: string;
    allowedAlgs: Set<JwtAlg>;
    clockSkewSeconds: number;
    maxTokenLifetimeSeconds: number;
    keys: Map<string, PublicKeyEntry>;
    rawConfig: string;
    reloadAt: number;
}

export class CodeApiJwtAuthError extends Error {
    readonly reason: string;
    constructor(reason: string, message: string) {
        super(message);
        this.name = 'CodeApiJwtAuthError';
        this.reason = reason;
    }
}

let configCache: VerificationConfig | null = null;
const DEFAULT_KEY_CACHE_TTL_SECONDS = 30;
const MAX_KEY_CACHE_TTL_SECONDS = 300;
const DEFAULT_MAX_TOKEN_LIFETIME_SECONDS = 300;
const MAX_TOKEN_LIFETIME_SECONDS = 300;
const DEFAULT_SINGLE_TENANT_ID = 'legacy';
const TRUSTED_PRINCIPAL_SOURCES = new Set<LibreChatPrincipalSource>([
    'librechat_jwt',
    'openid_reuse',
]);

function base64UrlDecode(value: string): Buffer {
    try {
        return Buffer.from(value, 'base64url');
    } catch {
        throw new CodeApiJwtAuthError(
            'malformed',
            'JWT segment is not valid base64url',
        );
    }
}

function parseJsonSegment<T>(segment: string, label: string): T {
    try {
        return JSON.parse(base64UrlDecode(segment).toString('utf8')) as T;
    } catch (err) {
        if (err instanceof CodeApiJwtAuthError) {
            throw err;
        }
        throw new CodeApiJwtAuthError(
            'malformed',
            `${label} is not valid JSON`,
        );
    }
}

function getBearerToken(req: Request): string | null {
    const header = req.header('Authorization') ?? '';
    const match = /^Bearer\s+(.+)$/i.exec(header);
    return match?.[1]?.trim() || null;
}

function parseAllowedAlgs(): Set<JwtAlg> {
    const raw = process.env.CODEAPI_JWT_ALLOWED_ALGS ?? 'EdDSA,RS256';
    const allowed = new Set<JwtAlg>();
    for (const value of raw.split(',')) {
        const alg = value.trim();
        if (alg === 'EdDSA' || alg === 'RS256' || alg === 'HS256') {
            allowed.add(alg);
        }
    }
    if (allowed.size === 0) {
        throw new CodeApiJwtAuthError(
            'config',
            'CODEAPI_JWT_ALLOWED_ALGS must include EdDSA, RS256, or HS256',
        );
    }
    return allowed;
}

function parseClockSkew(): number {
    const parsed = Number(process.env.CODEAPI_JWT_CLOCK_SKEW_SECONDS);
    if (!Number.isFinite(parsed) || parsed < 0) {
        return 30;
    }
    return Math.min(Math.floor(parsed), 30);
}

function parseCappedSeconds(
    value: string | undefined,
    fallback: number,
    max: number,
): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return fallback;
    }
    return Math.min(Math.floor(parsed), max);
}

function publicKeyFromValue(value: string): KeyObject {
    const trimmed = value.replace(/\\n/g, '\n').trim();
    try {
        if (trimmed.startsWith('{')) {
            return createPublicKey({
                key: JSON.parse(trimmed) as JsonWebKey,
                format: 'jwk',
            });
        }
        return createPublicKey(trimmed);
    } catch {
        throw new CodeApiJwtAuthError(
            'config',
            'CodeAPI JWT public key is invalid',
        );
    }
}

function loadJwks(keys: Map<string, PublicKeyEntry>, raw: string): void {
    let parsed: { keys?: Array<JsonWebKey & { kid?: string; alg?: string }> };
    try {
        parsed = JSON.parse(raw) as {
            keys?: Array<JsonWebKey & { kid?: string; alg?: string }>;
        };
    } catch {
        throw new CodeApiJwtAuthError(
            'config',
            'CODEAPI_JWT_JWKS_JSON is not valid JSON',
        );
    }
    if (!Array.isArray(parsed.keys)) {
        throw new CodeApiJwtAuthError(
            'config',
            'CODEAPI_JWT_JWKS_JSON must contain a keys array',
        );
    }
    for (const jwk of parsed.keys) {
        if (!jwk.kid) {
            continue;
        }
        try {
            keys.set(jwk.kid, {
                alg:
                    jwk.alg === 'EdDSA' || jwk.alg === 'RS256'
                        ? jwk.alg
                        : undefined,
                key: createPublicKey({ key: jwk, format: 'jwk' }),
            });
        } catch {
            throw new CodeApiJwtAuthError(
                'config',
                `CodeAPI JWT public key ${jwk.kid} is invalid`,
            );
        }
    }
}

function loadPublicKeyDir(
    keys: Map<string, PublicKeyEntry>,
    dir: string,
): void {
    try {
        if (!existsSync(dir) || !statSync(dir).isDirectory()) {
            throw new CodeApiJwtAuthError(
                'config',
                'CODEAPI_JWT_PUBLIC_KEYS_DIR is not a directory',
            );
        }
        for (const file of readdirSync(dir)) {
            const fullPath = join(dir, file);
            if (!statSync(fullPath).isFile()) {
                continue;
            }
            const kid = parse(file).name;
            if (!kid) {
                continue;
            }
            keys.set(kid, {
                key: publicKeyFromValue(readFileSync(fullPath, 'utf8')),
            });
        }
    } catch (error) {
        if (error instanceof CodeApiJwtAuthError) {
            throw error;
        }
        throw new CodeApiJwtAuthError(
            'config',
            'CODEAPI_JWT_PUBLIC_KEYS_DIR could not be read',
        );
    }
}

function loadKeys(): Map<string, PublicKeyEntry> {
    const keys = new Map<string, PublicKeyEntry>();
    const jwksJson = process.env.CODEAPI_JWT_JWKS_JSON;
    if (jwksJson != null && jwksJson.trim() !== '') {
        loadJwks(keys, jwksJson);
    }

    const publicKeysDir = process.env.CODEAPI_JWT_PUBLIC_KEYS_DIR;
    if (publicKeysDir != null && publicKeysDir.trim() !== '') {
        loadPublicKeyDir(keys, publicKeysDir);
    }

    const publicKey = process.env.CODEAPI_JWT_PUBLIC_KEY;
    if (publicKey != null && publicKey.trim() !== '') {
        const kid =
            process.env.CODEAPI_JWT_KID ?? process.env.CODEAPI_JWT_KEY_ID;
        if (!kid) {
            throw new CodeApiJwtAuthError(
                'config',
                'CODEAPI_JWT_KID is required with CODEAPI_JWT_PUBLIC_KEY',
            );
        }
        keys.set(kid, { key: publicKeyFromValue(publicKey) });
    }

    const hsSecret = process.env.CODEAPI_JWT_HS256_SECRET;
    if (hsSecret != null && hsSecret !== '') {
        const kid =
            process.env.CODEAPI_JWT_HS256_KID ??
            process.env.CODEAPI_JWT_KID ??
            'hs256-dev';
        keys.set(kid, { alg: 'HS256', key: Buffer.from(hsSecret) });
    }

    if (keys.size === 0) {
        throw new CodeApiJwtAuthError(
            'config',
            'No CodeAPI JWT verification keys configured',
        );
    }
    return keys;
}

function rawConfigFingerprint(): string {
    return JSON.stringify({
        issuer: process.env.CODEAPI_JWT_ISSUER,
        audience: process.env.CODEAPI_JWT_AUDIENCE,
        allowedAlgs: process.env.CODEAPI_JWT_ALLOWED_ALGS,
        skew: process.env.CODEAPI_JWT_CLOCK_SKEW_SECONDS,
        maxTokenLifetime: process.env.CODEAPI_JWT_MAX_TTL_SECONDS,
        keyCacheTtl: process.env.CODEAPI_JWT_KEY_CACHE_TTL_SECONDS,
        jwks: process.env.CODEAPI_JWT_JWKS_JSON,
        publicKeysDir: process.env.CODEAPI_JWT_PUBLIC_KEYS_DIR?.trim(),
        publicKey: process.env.CODEAPI_JWT_PUBLIC_KEY,
        kid: process.env.CODEAPI_JWT_KID,
        keyId: process.env.CODEAPI_JWT_KEY_ID,
        hsKid: process.env.CODEAPI_JWT_HS256_KID,
        hsSecret: process.env.CODEAPI_JWT_HS256_SECRET,
    });
}

function getConfig(): VerificationConfig {
    const rawConfig = rawConfigFingerprint();
    const now = Date.now();
    if (configCache?.rawConfig === rawConfig && configCache.reloadAt > now) {
        return configCache;
    }
    const keyCacheTtlSeconds = parseCappedSeconds(
        process.env.CODEAPI_JWT_KEY_CACHE_TTL_SECONDS,
        DEFAULT_KEY_CACHE_TTL_SECONDS,
        MAX_KEY_CACHE_TTL_SECONDS,
    );
    configCache = {
        rawConfig,
        reloadAt: now + keyCacheTtlSeconds * 1000,
        issuer: process.env.CODEAPI_JWT_ISSUER ?? 'librechat',
        audience: process.env.CODEAPI_JWT_AUDIENCE ?? 'codeapi',
        allowedAlgs: parseAllowedAlgs(),
        clockSkewSeconds: parseClockSkew(),
        maxTokenLifetimeSeconds: parseCappedSeconds(
            process.env.CODEAPI_JWT_MAX_TTL_SECONDS,
            DEFAULT_MAX_TOKEN_LIFETIME_SECONDS,
            MAX_TOKEN_LIFETIME_SECONDS,
        ),
        keys: loadKeys(),
    };
    return configCache;
}

function verifySignature(
    alg: JwtAlg,
    key: PublicKeyEntry,
    signingInput: string,
    signature: Buffer,
): boolean {
    if (alg === 'HS256') {
        if (!Buffer.isBuffer(key.key)) {
            return false;
        }
        const expected = createHmac('sha256', key.key)
            .update(signingInput)
            .digest();
        return (
            expected.length === signature.length &&
            timingSafeEqual(expected, signature)
        );
    }
    if (Buffer.isBuffer(key.key)) {
        return false;
    }
    try {
        return cryptoVerify(
            alg === 'RS256' ? 'RSA-SHA256' : null,
            Buffer.from(signingInput),
            key.key,
            signature,
        );
    } catch {
        return false;
    }
}

function assertString(value: unknown, name: string): string {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new CodeApiJwtAuthError(
            'malformed_claims',
            `${name} is required`,
        );
    }
    return value;
}

function assertAudience(value: unknown, expected: string): void {
    if (typeof value === 'string' && value.trim() !== '') {
        if (value !== expected) {
            throw new CodeApiJwtAuthError(
                'wrong_audience',
                'JWT audience is not accepted',
            );
        }
        return;
    }

    if (Array.isArray(value) && value.length > 0) {
        if (!value.every(audience => typeof audience === 'string')) {
            throw new CodeApiJwtAuthError(
                'malformed_claims',
                'aud must contain only strings',
            );
        }
        if (value.includes(expected)) {
            return;
        }
        throw new CodeApiJwtAuthError(
            'wrong_audience',
            'JWT audience is not accepted',
        );
    }

    throw new CodeApiJwtAuthError('malformed_claims', 'aud is required');
}

function assertNumericDate(value: unknown, name: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new CodeApiJwtAuthError(
            'malformed_claims',
            `${name} must be a number`,
        );
    }
    return value;
}

function optionalString(value: unknown, name: string): string | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (typeof value !== 'string' || value.trim() === '') {
        throw new CodeApiJwtAuthError(
            'malformed_claims',
            `${name} must be a string`,
        );
    }
    return value;
}

function strictTenantIsolation(): boolean {
    return process.env.CODEAPI_TENANT_ISOLATION_STRICT === 'true';
}

function resolveSingleTenantId(): string {
    const configured = process.env.CODEAPI_JWT_SINGLE_TENANT_ID;
    if (configured != null && configured.trim() !== '') {
        return configured.trim();
    }
    return DEFAULT_SINGLE_TENANT_ID;
}

function resolveTenantIdClaim(value: unknown): string {
    const tenantId = optionalString(value, 'tenant_id');
    if (tenantId) {
        return tenantId;
    }
    if (strictTenantIsolation()) {
        throw new CodeApiJwtAuthError(
            'malformed_claims',
            'tenant_id is required',
        );
    }
    return resolveSingleTenantId();
}

function isTrustedPrincipalSource(
    value: string,
): value is LibreChatPrincipalSource {
    return TRUSTED_PRINCIPAL_SOURCES.has(value as LibreChatPrincipalSource);
}

function assertPrincipalSource(value: unknown): LibreChatPrincipalSource {
    const principalSource = assertString(value, 'principal_source');
    if (isTrustedPrincipalSource(principalSource)) {
        return principalSource;
    }
    throw new CodeApiJwtAuthError(
        'malformed_claims',
        'principal_source is not accepted',
    );
}

function validateClaims(
    claims: LibreChatJwtClaims,
    config: VerificationConfig,
): CodeApiPrincipal {
    const now = Math.floor(Date.now() / 1000);
    const issuer = assertString(claims.iss, 'iss');
    const userId = assertString(claims.sub, 'sub');
    const tenantId = resolveTenantIdClaim(claims.tenant_id);
    const jti = assertString(claims.jti, 'jti');
    const iat = assertNumericDate(claims.iat, 'iat');
    const nbf = assertNumericDate(claims.nbf, 'nbf');
    const exp = assertNumericDate(claims.exp, 'exp');
    const planId = optionalString(claims.plan_id, 'plan_id');
    const principalSource = assertPrincipalSource(claims.principal_source);
    const authContextHash = assertString(
        claims.auth_context_hash,
        'auth_context_hash',
    );

    if (jti.length > 256) {
        throw new CodeApiJwtAuthError('malformed_claims', 'jti is too long');
    }
    if (issuer !== config.issuer) {
        throw new CodeApiJwtAuthError(
            'wrong_issuer',
            'JWT issuer is not trusted',
        );
    }
    assertAudience(claims.aud, config.audience);
    if (exp <= now - config.clockSkewSeconds) {
        throw new CodeApiJwtAuthError('expired', 'JWT is expired');
    }
    if (nbf > now + config.clockSkewSeconds) {
        throw new CodeApiJwtAuthError('not_yet_valid', 'JWT is not yet valid');
    }
    if (iat > now + config.clockSkewSeconds) {
        throw new CodeApiJwtAuthError('future_iat', 'JWT iat is in the future');
    }
    if (exp <= iat) {
        throw new CodeApiJwtAuthError(
            'malformed_claims',
            'JWT exp must be after iat',
        );
    }
    if (exp - iat > config.maxTokenLifetimeSeconds) {
        throw new CodeApiJwtAuthError(
            'ttl_too_long',
            'JWT lifetime exceeds CodeAPI maximum',
        );
    }

    return {
        userId,
        tenantId,
        role: typeof claims.role === 'string' ? claims.role : undefined,
        orgId: typeof claims.org_id === 'string' ? claims.org_id : undefined,
        serviceId:
            typeof claims.service_id === 'string'
                ? claims.service_id
                : undefined,
        externalUserId:
            typeof claims.external_user_id === 'string'
                ? claims.external_user_id
                : // Legacy fallback until the token issuer emits external_user_id.
                  typeof claims.chc_user_id === 'string'
                  ? claims.chc_user_id
                  : undefined, // leak-check:allow
        principalSource,
        authContextHash,
        planId,
    };
}

export function validateLibreChatJwtVerifierConfig(): void {
    getConfig();
}

export function verifyLibreChatJwt(token: string): CodeApiPrincipal {
    const config = getConfig();
    const parts = token.split('.');
    if (parts.length !== 3) {
        throw new CodeApiJwtAuthError(
            'malformed',
            'JWT must have three segments',
        );
    }
    const [encodedHeader, encodedPayload, encodedSignature] = parts;
    const header = parseJsonSegment<JwtHeader>(encodedHeader, 'JWT header');
    const claims = parseJsonSegment<LibreChatJwtClaims>(
        encodedPayload,
        'JWT payload',
    );
    const alg = header.alg;
    if (alg !== 'EdDSA' && alg !== 'RS256' && alg !== 'HS256') {
        throw new CodeApiJwtAuthError('wrong_alg', 'JWT alg is not supported');
    }
    if (!config.allowedAlgs.has(alg)) {
        throw new CodeApiJwtAuthError('wrong_alg', 'JWT alg is not allowed');
    }
    if (header.typ !== undefined && header.typ !== 'JWT') {
        throw new CodeApiJwtAuthError('malformed', 'JWT typ must be JWT');
    }
    const kid = assertString(header.kid, 'kid');
    const key = config.keys.get(kid);
    if (!key) {
        throw new CodeApiJwtAuthError(
            'unknown_kid',
            'JWT kid is not configured',
        );
    }
    if (key.alg && key.alg !== alg) {
        throw new CodeApiJwtAuthError(
            'wrong_alg',
            'JWT alg does not match key',
        );
    }
    const signingInput = `${encodedHeader}.${encodedPayload}`;
    const signature = base64UrlDecode(encodedSignature);
    if (!verifySignature(alg, key, signingInput, signature)) {
        throw new CodeApiJwtAuthError(
            'bad_signature',
            'JWT signature is invalid',
        );
    }
    return validateClaims(claims, config);
}

export class LibreChatJwtAuthProvider implements AuthProvider {
    async verify(req: Request): Promise<CodeApiPrincipal | null> {
        const token = getBearerToken(req);
        if (!token) {
            return null;
        }
        return verifyLibreChatJwt(token);
    }
}
