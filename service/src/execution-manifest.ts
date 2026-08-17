import crypto from 'crypto';

export const EXECUTION_MANIFEST_HEADER = 'X-CodeAPI-Execution-Manifest';
export const EXECUTION_MANIFEST_VERSION = 1;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export type ExecutionManifestErrorReason =
    | 'missing_header'
    | 'missing_secret'
    | 'malformed'
    | 'invalid_signature'
    | 'expired'
    | 'not_yet_valid'
    | 'scope_mismatch';

export class ExecutionManifestError extends Error {
    readonly reason: ExecutionManifestErrorReason;

    constructor(reason: ExecutionManifestErrorReason, message: string) {
        super(message);
        this.name = 'ExecutionManifestError';
        this.reason = reason;
    }
}

export interface ExecutionManifestSigner {
    /** Preferred signer for split-runner deployments. The sandbox-runner only
     * receives the matching public key, so runner compromise does not create a
     * new manifest-minting capability. Accepts PEM or base64-encoded PKCS#8 DER. */
    privateKey?: string;
    /** Legacy HMAC fallback for non-split deployments. Do not mount this into
     * sandbox-runner; it can both verify and mint manifests. */
    secret?: string;
}

export interface ExecutionManifestVerifier {
    /** Preferred verifier for sandbox-runner. Accepts PEM or base64-encoded SPKI DER. */
    publicKey?: string;
    /** Legacy HMAC fallback for non-split deployments. */
    secret?: string;
}

export interface ExecutionManifestVerifyOptions {
    nowSeconds?: number;
    clockToleranceSeconds?: number;
}

export interface ExecutionManifestInputFile {
    id: string;
    /** Per-file storage session id. Kept as `session_id` (rather than
     *  renamed alongside the wire body field) so the manifest version
     *  doesn't need bumping — in-flight tokens remain valid through a
     *  rolling deploy. The wire body field is `storage_session_id`; the
     *  service maps to `session_id` at manifest construction and the
     *  worker maps back at validation. */
    session_id: string;
    name: string;
}

export interface ExecutionManifestClaims {
    v: typeof EXECUTION_MANIFEST_VERSION;
    exec_id: string;
    tenant_id: string;
    user_id: string;
    session_key: string;
    input_files: ExecutionManifestInputFile[];
    read_sessions: string[];
    output_session_id: string;
    max_upload_bytes: number;
    max_output_files: number;
    max_requests: number;
    iat: number;
    exp: number;
    execute_body_sha256?: string;
    tool_call_socket?: boolean;
    external_user_id?: string;
    org_id?: string;
    service_id?: string;
    principal_source?: string;
    auth_context_hash?: string;
}

function base64UrlEncode(input: Buffer | string): string {
    return Buffer.from(input).toString('base64url');
}

function base64UrlDecode(input: string): Buffer {
    if (!BASE64URL_PATTERN.test(input) || input.length % 4 === 1) {
        throw new ExecutionManifestError(
            'malformed',
            'Execution manifest is not valid base64url',
        );
    }

    try {
        return Buffer.from(input, 'base64url');
    } catch {
        throw new ExecutionManifestError(
            'malformed',
            'Execution manifest is not valid base64url',
        );
    }
}

function canonicalJson(value: unknown): string {
    if (value === null) return 'null';
    if (typeof value === 'string') return JSON.stringify(value);
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
            throw new ExecutionManifestError(
                'malformed',
                'Execution manifest contains a non-finite number',
            );
        }
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return `[${value.map(canonicalJson).join(',')}]`;
    }
    if (typeof value === 'object' && value !== undefined) {
        const obj = value as Record<string, unknown>;
        const entries = Object.keys(obj)
            .filter(key => obj[key] !== undefined)
            .sort()
            .map(key => `${JSON.stringify(key)}:${canonicalJson(obj[key])}`);
        return `{${entries.join(',')}}`;
    }

    throw new ExecutionManifestError(
        'malformed',
        'Execution manifest contains an unsupported value',
    );
}

function bodyForManifestDigest(body: unknown): unknown {
    if (body == null || typeof body !== 'object' || Array.isArray(body))
        return body;
    const { execution_manifest: _executionManifest, ...rest } = body as Record<
        string,
        unknown
    >;
    return rest;
}

export function executionManifestBodySha256(body: unknown): string {
    const canonicalBody = canonicalJson(bodyForManifestDigest(body));
    return crypto
        .createHash('sha256')
        .update(canonicalBody, 'utf8')
        .digest('base64url');
}

function hmacSha256(data: string, secret: string): Buffer {
    return crypto.createHmac('sha256', secret).update(data, 'utf8').digest();
}

function normalizeKeyMaterial(key: string): string {
    return key.trim().replace(/\\n/g, '\n');
}

function privateKeyFromEnv(key: string): crypto.KeyObject | string {
    const normalized = normalizeKeyMaterial(key);
    if (normalized.includes('BEGIN ')) return normalized;
    return crypto.createPrivateKey({
        key: Buffer.from(normalized, 'base64'),
        format: 'der',
        type: 'pkcs8',
    });
}

function publicKeyFromEnv(key: string): crypto.KeyObject | string {
    const normalized = normalizeKeyMaterial(key);
    if (normalized.includes('BEGIN ')) return normalized;
    return crypto.createPublicKey({
        key: Buffer.from(normalized, 'base64'),
        format: 'der',
        type: 'spki',
    });
}

function ed25519Sign(data: string, privateKey: string): Buffer {
    return crypto.sign(
        null,
        Buffer.from(data, 'utf8'),
        privateKeyFromEnv(privateKey),
    );
}

function ed25519Verify(
    data: string,
    publicKey: string,
    signature: Buffer,
): boolean {
    return crypto.verify(
        null,
        Buffer.from(data, 'utf8'),
        publicKeyFromEnv(publicKey),
        signature,
    );
}

function validateClaimsShape(
    value: unknown,
): asserts value is ExecutionManifestClaims {
    const claims = value as Partial<ExecutionManifestClaims> | null;
    if (claims == null || typeof claims !== 'object') {
        throw new ExecutionManifestError(
            'malformed',
            'Execution manifest claims must be an object',
        );
    }

    const stringFields: Array<keyof ExecutionManifestClaims> = [
        'exec_id',
        'tenant_id',
        'user_id',
        'session_key',
        'output_session_id',
    ];
    for (const field of stringFields) {
        if (typeof claims[field] !== 'string' || claims[field] === '') {
            throw new ExecutionManifestError(
                'malformed',
                `Execution manifest ${field} is invalid`,
            );
        }
    }

    const numberFields: Array<keyof ExecutionManifestClaims> = [
        'max_upload_bytes',
        'max_output_files',
        'max_requests',
        'iat',
        'exp',
    ];
    for (const field of numberFields) {
        if (
            typeof claims[field] !== 'number' ||
            !Number.isFinite(claims[field])
        ) {
            throw new ExecutionManifestError(
                'malformed',
                `Execution manifest ${field} is invalid`,
            );
        }
    }

    if (claims.v !== EXECUTION_MANIFEST_VERSION) {
        throw new ExecutionManifestError(
            'malformed',
            'Execution manifest version is unsupported',
        );
    }
    if (!Array.isArray(claims.input_files)) {
        throw new ExecutionManifestError(
            'malformed',
            'Execution manifest input_files must be an array',
        );
    }
    if (
        !Array.isArray(claims.read_sessions) ||
        claims.read_sessions.some(
            session => typeof session !== 'string' || session === '',
        )
    ) {
        throw new ExecutionManifestError(
            'malformed',
            'Execution manifest read_sessions is invalid',
        );
    }
    if (
        claims.execute_body_sha256 !== undefined &&
        (typeof claims.execute_body_sha256 !== 'string' ||
            claims.execute_body_sha256 === '')
    ) {
        throw new ExecutionManifestError(
            'malformed',
            'Execution manifest execute_body_sha256 is invalid',
        );
    }
    if (
        claims.tool_call_socket !== undefined &&
        typeof claims.tool_call_socket !== 'boolean'
    ) {
        throw new ExecutionManifestError(
            'malformed',
            'Execution manifest tool_call_socket is invalid',
        );
    }
    for (const file of claims.input_files) {
        if (
            file == null ||
            typeof file !== 'object' ||
            typeof file.id !== 'string' ||
            typeof file.session_id !== 'string' ||
            typeof file.name !== 'string' ||
            file.id === '' ||
            file.session_id === '' ||
            file.name === ''
        ) {
            throw new ExecutionManifestError(
                'malformed',
                'Execution manifest input_files contains an invalid file',
            );
        }
    }
}

function payloadForClaims(claims: ExecutionManifestClaims): string {
    validateClaimsShape(claims);
    return canonicalJson(claims);
}

function encodeSignedManifest(payload: string, signature: Buffer): string {
    return `${base64UrlEncode(payload)}.${base64UrlEncode(signature)}`;
}

function decodeSignedManifest(token: string): {
    claims: ExecutionManifestClaims;
    payload: string;
    signature: Buffer;
} {
    const [payloadPart, signaturePart, extraPart] = token.split('.');
    if (!payloadPart || !signaturePart || extraPart !== undefined) {
        throw new ExecutionManifestError(
            'malformed',
            'Execution manifest token is malformed',
        );
    }

    const payload = base64UrlDecode(payloadPart).toString('utf8');
    let parsed: unknown;
    try {
        parsed = JSON.parse(payload);
    } catch {
        throw new ExecutionManifestError(
            'malformed',
            'Execution manifest payload is not valid JSON',
        );
    }

    validateClaimsShape(parsed);
    const canonicalPayload = canonicalJson(parsed);
    if (payload !== canonicalPayload) {
        throw new ExecutionManifestError(
            'malformed',
            'Execution manifest payload is not canonical',
        );
    }

    return {
        claims: parsed,
        payload: canonicalPayload,
        signature: base64UrlDecode(signaturePart),
    };
}

function assertManifestTimeWindow(
    claims: ExecutionManifestClaims,
    options: ExecutionManifestVerifyOptions,
): void {
    const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
    const tolerance = options.clockToleranceSeconds ?? 30;
    if (claims.exp <= now - tolerance) {
        throw new ExecutionManifestError(
            'expired',
            'Execution manifest is expired',
        );
    }
    if (claims.iat > now + tolerance) {
        throw new ExecutionManifestError(
            'not_yet_valid',
            'Execution manifest is not valid yet',
        );
    }
}

export function signExecutionManifest(
    claims: ExecutionManifestClaims,
    secret: string,
): string {
    if (!secret) {
        throw new ExecutionManifestError(
            'missing_secret',
            'Execution manifest secret is not configured',
        );
    }

    const payload = payloadForClaims(claims);
    return encodeSignedManifest(payload, hmacSha256(payload, secret));
}

export function signExecutionManifestWithPrivateKey(
    claims: ExecutionManifestClaims,
    privateKey: string,
): string {
    if (!privateKey) {
        throw new ExecutionManifestError(
            'missing_secret',
            'Execution manifest private key is not configured',
        );
    }

    const payload = payloadForClaims(claims);
    return encodeSignedManifest(payload, ed25519Sign(payload, privateKey));
}

export function signExecutionManifestWithKey(
    claims: ExecutionManifestClaims,
    signer: ExecutionManifestSigner,
): string {
    if (signer.privateKey) {
        return signExecutionManifestWithPrivateKey(claims, signer.privateKey);
    }
    return signExecutionManifest(claims, signer.secret ?? '');
}

export function verifyExecutionManifest(
    token: string,
    secret: string,
    options: ExecutionManifestVerifyOptions = {},
): ExecutionManifestClaims {
    if (!secret) {
        throw new ExecutionManifestError(
            'missing_secret',
            'Execution manifest secret is not configured',
        );
    }

    const manifest = decodeSignedManifest(token);
    const expected = hmacSha256(manifest.payload, secret);
    if (
        manifest.signature.length !== expected.length ||
        !crypto.timingSafeEqual(manifest.signature, expected)
    ) {
        throw new ExecutionManifestError(
            'invalid_signature',
            'Execution manifest signature is invalid',
        );
    }
    assertManifestTimeWindow(manifest.claims, options);
    return manifest.claims;
}

export function verifyExecutionManifestWithPublicKey(
    token: string,
    publicKey: string,
    options: ExecutionManifestVerifyOptions = {},
): ExecutionManifestClaims {
    if (!publicKey) {
        throw new ExecutionManifestError(
            'missing_secret',
            'Execution manifest public key is not configured',
        );
    }

    const manifest = decodeSignedManifest(token);
    if (!ed25519Verify(manifest.payload, publicKey, manifest.signature)) {
        throw new ExecutionManifestError(
            'invalid_signature',
            'Execution manifest signature is invalid',
        );
    }
    assertManifestTimeWindow(manifest.claims, options);
    return manifest.claims;
}

export function verifyExecutionManifestWithKey(
    token: string,
    verifier: ExecutionManifestVerifier,
    options: ExecutionManifestVerifyOptions = {},
): ExecutionManifestClaims {
    if (verifier.publicKey) {
        try {
            return verifyExecutionManifestWithPublicKey(
                token,
                verifier.publicKey,
                options,
            );
        } catch (error) {
            if (
                error instanceof ExecutionManifestError &&
                error.reason === 'invalid_signature' &&
                verifier.secret
            ) {
                return verifyExecutionManifest(token, verifier.secret, options);
            }
            throw error;
        }
    }
    return verifyExecutionManifest(token, verifier.secret ?? '', options);
}
