import crypto from 'crypto';
import type {
    ExecutionManifestClaims,
    ExecutionManifestInputFile,
} from './execution-manifest';
import type * as t from './types';

export const EGRESS_GRANT_HEADER = 'X-CodeAPI-Egress-Grant';
export const EGRESS_GRANT_VERSION = 1;

const TOKEN_PREFIX = 'ceg1';
const AAD = Buffer.from('codeapi-egress-grant:v1', 'utf8');
const MIN_SECRET_BYTES = 32;
const TOKEN_RE = /^[A-Za-z0-9_-]+$/;
const LEGACY_GRANT_ID_PREFIX = 'legacy_';
const LEGACY_MAX_OUTPUT_FILES = 50;
const LEGACY_MAX_REQUESTS = 1000;

export type EgressGrantErrorReason =
    | 'missing_secret'
    | 'weak_secret'
    | 'malformed'
    | 'expired'
    | 'wrong_type'
    | 'scope_mismatch';

export class EgressGrantError extends Error {
    readonly reason: EgressGrantErrorReason;

    constructor(reason: EgressGrantErrorReason, message: string) {
        super(message);
        this.name = 'EgressGrantError';
        this.reason = reason;
    }
}

export interface EgressGrantClaims {
    v: typeof EGRESS_GRANT_VERSION;
    typ: 'grant';
    grant_id: string;
    legacy_grant?: true;
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
    external_user_id?: string;
    org_id?: string;
    service_id?: string;
    principal_source?: string;
    auth_context_hash?: string;
}

export type EgressHandleClaims =
    | {
          v: typeof EGRESS_GRANT_VERSION;
          typ: 'session';
          dir: 'read' | 'write';
          grant_id?: string;
          exec_id: string;
          session_id: string;
          iat: number;
          exp: number;
      }
    | {
          v: typeof EGRESS_GRANT_VERSION;
          typ: 'object';
          dir: 'read';
          grant_id?: string;
          exec_id: string;
          session_id: string;
          object_id: string;
          name: string;
          iat: number;
          exp: number;
      }
    | {
          v: typeof EGRESS_GRANT_VERSION;
          typ: 'ptc-callback';
          grant_id?: string;
          exec_id: string;
          session_id: string;
          callback_token: string;
          allowed_tool_names?: string[];
          iat: number;
          exp: number;
      };

type WithoutVersion<T> = T extends unknown ? Omit<T, 'v'> : never;

type PayloadFileRef = { id: string; storage_session_id: string; name: string };

export interface PreparedSandboxEgress {
    payload: t.PayloadBody;
    egressGrantToken: string;
    executionManifestClaims: ExecutionManifestClaims;
}

function keyFromSecret(secret: string): Buffer {
    if (!secret) {
        throw new EgressGrantError(
            'missing_secret',
            'CODEAPI_EGRESS_GRANT_SECRET is not configured',
        );
    }
    if (Buffer.byteLength(secret, 'utf8') < MIN_SECRET_BYTES) {
        throw new EgressGrantError(
            'weak_secret',
            `CODEAPI_EGRESS_GRANT_SECRET must be at least ${MIN_SECRET_BYTES} bytes`,
        );
    }
    return crypto.createHash('sha256').update(secret, 'utf8').digest();
}

function b64(input: Buffer): string {
    return input.toString('base64url');
}

function b64decode(input: string): Buffer {
    if (!TOKEN_RE.test(input) || input.length % 4 === 1) {
        throw new EgressGrantError(
            'malformed',
            'Egress token is not valid base64url',
        );
    }
    try {
        return Buffer.from(input, 'base64url');
    } catch {
        throw new EgressGrantError(
            'malformed',
            'Egress token is not valid base64url',
        );
    }
}

function sealToken(
    claims: EgressGrantClaims | EgressHandleClaims,
    secret: string,
): string {
    const key = keyFromSecret(secret);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(AAD);
    const plaintext = Buffer.from(JSON.stringify(claims), 'utf8');
    const ciphertext = Buffer.concat([
        cipher.update(plaintext),
        cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return `${TOKEN_PREFIX}.${b64(iv)}.${b64(ciphertext)}.${b64(tag)}`;
}

function openToken(
    secret: string,
    token: string,
    nowSeconds = Math.floor(Date.now() / 1000),
): unknown {
    const [prefix, ivPart, ciphertextPart, tagPart, extra] = token.split('.');
    if (
        prefix !== TOKEN_PREFIX ||
        !ivPart ||
        !ciphertextPart ||
        !tagPart ||
        extra !== undefined
    ) {
        throw new EgressGrantError('malformed', 'Egress token is malformed');
    }

    const key = keyFromSecret(secret);
    const iv = b64decode(ivPart);
    const ciphertext = b64decode(ciphertextPart);
    const tag = b64decode(tagPart);
    try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAAD(AAD);
        decipher.setAuthTag(tag);
        const plaintext = Buffer.concat([
            decipher.update(ciphertext),
            decipher.final(),
        ]).toString('utf8');
        const claims = JSON.parse(plaintext) as {
            exp?: unknown;
            iat?: unknown;
        };
        if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp)) {
            throw new EgressGrantError(
                'malformed',
                'Egress token expiry is invalid',
            );
        }
        if (claims.exp <= nowSeconds - 30) {
            throw new EgressGrantError('expired', 'Egress token is expired');
        }
        if (typeof claims.iat !== 'number' || claims.iat > nowSeconds + 30) {
            throw new EgressGrantError(
                'malformed',
                'Egress token issue time is invalid',
            );
        }
        return claims;
    } catch (error) {
        if (error instanceof EgressGrantError) throw error;
        throw new EgressGrantError(
            'malformed',
            'Egress token could not be decrypted',
        );
    }
}

function assertString(value: unknown, field: string): asserts value is string {
    if (typeof value !== 'string' || value.length === 0) {
        throw new EgressGrantError('malformed', `Egress ${field} is invalid`);
    }
}

function assertStringArray(
    value: unknown,
    field: string,
): asserts value is string[] {
    if (
        !Array.isArray(value) ||
        value.some(item => typeof item !== 'string' || item.length === 0)
    ) {
        throw new EgressGrantError('malformed', `Egress ${field} is invalid`);
    }
}

function assertInputFiles(
    value: unknown,
): asserts value is ExecutionManifestInputFile[] {
    if (!Array.isArray(value)) {
        throw new EgressGrantError(
            'malformed',
            'Egress input_files must be an array',
        );
    }
    for (const file of value) {
        if (
            file == null ||
            typeof file !== 'object' ||
            typeof (file as ExecutionManifestInputFile).id !== 'string' ||
            typeof (file as ExecutionManifestInputFile).session_id !==
                'string' ||
            typeof (file as ExecutionManifestInputFile).name !== 'string'
        ) {
            throw new EgressGrantError(
                'malformed',
                'Egress input_files contains an invalid file',
            );
        }
    }
}

function legacyGrantId(token: string): string {
    return `${LEGACY_GRANT_ID_PREFIX}${crypto.createHash('sha256').update(token, 'utf8').digest('base64url').slice(0, 32)}`;
}

function validateGrant(value: unknown, token: string): EgressGrantClaims {
    const claims = value as Partial<EgressGrantClaims> | null;
    if (claims == null || typeof claims !== 'object') {
        throw new EgressGrantError(
            'malformed',
            'Egress grant must be an object',
        );
    }
    if (claims.v !== EGRESS_GRANT_VERSION || claims.typ !== 'grant') {
        throw new EgressGrantError('wrong_type', 'Egress token is not a grant');
    }

    if (claims.grant_id === undefined) {
        claims.grant_id = legacyGrantId(token);
        claims.legacy_grant = true;
    } else {
        assertString(claims.grant_id, 'grant_id');
    }

    for (const field of [
        'exec_id',
        'tenant_id',
        'user_id',
        'session_key',
        'output_session_id',
    ] as const) {
        assertString(claims[field], field);
    }
    assertInputFiles(claims.input_files);
    assertStringArray(claims.read_sessions, 'read_sessions');
    if (claims.max_output_files === undefined) {
        claims.max_output_files = LEGACY_MAX_OUTPUT_FILES;
    }
    if (claims.max_requests === undefined) {
        claims.max_requests = LEGACY_MAX_REQUESTS;
    }
    for (const field of [
        'max_upload_bytes',
        'max_output_files',
        'max_requests',
        'iat',
        'exp',
    ] as const) {
        if (
            typeof claims[field] !== 'number' ||
            !Number.isFinite(claims[field])
        ) {
            throw new EgressGrantError(
                'malformed',
                `Egress ${field} is invalid`,
            );
        }
    }
    return claims as EgressGrantClaims;
}

function validateHandle(value: unknown): EgressHandleClaims {
    const claims = value as Partial<EgressHandleClaims> | null;
    if (claims == null || typeof claims !== 'object') {
        throw new EgressGrantError(
            'malformed',
            'Egress handle must be an object',
        );
    }
    if (claims.v !== EGRESS_GRANT_VERSION) {
        throw new EgressGrantError(
            'wrong_type',
            'Egress handle version is unsupported',
        );
    }
    if (claims.grant_id !== undefined) {
        assertString(claims.grant_id, 'grant_id');
    }
    assertString(claims.exec_id, 'exec_id');
    for (const field of ['iat', 'exp'] as const) {
        if (
            typeof claims[field] !== 'number' ||
            !Number.isFinite(claims[field])
        ) {
            throw new EgressGrantError(
                'malformed',
                `Egress handle ${field} is invalid`,
            );
        }
    }
    if (claims.typ === 'session') {
        if (claims.dir !== 'read' && claims.dir !== 'write') {
            throw new EgressGrantError(
                'malformed',
                'Egress session handle direction is invalid',
            );
        }
        assertString(claims.session_id, 'session_id');
        return claims as EgressHandleClaims;
    }
    if (claims.typ === 'object') {
        if (claims.dir !== 'read') {
            throw new EgressGrantError(
                'malformed',
                'Egress object handle direction is invalid',
            );
        }
        assertString(claims.session_id, 'session_id');
        assertString(claims.object_id, 'object_id');
        assertString(claims.name, 'name');
        return claims as EgressHandleClaims;
    }
    if (claims.typ === 'ptc-callback') {
        assertString(claims.session_id, 'session_id');
        assertString(claims.callback_token, 'callback_token');
        if (claims.allowed_tool_names !== undefined) {
            assertStringArray(claims.allowed_tool_names, 'allowed_tool_names');
        }
        return claims as EgressHandleClaims;
    }
    throw new EgressGrantError(
        'wrong_type',
        'Egress token is not a recognized handle',
    );
}

export function sealEgressGrant(
    claims: Omit<EgressGrantClaims, 'v' | 'typ'>,
    secret: string,
): string {
    return sealToken(
        {
            v: EGRESS_GRANT_VERSION,
            typ: 'grant',
            grant_id: claims.grant_id,
            exec_id: claims.exec_id,
            tenant_id: claims.tenant_id,
            user_id: claims.user_id,
            session_key: claims.session_key,
            input_files: claims.input_files,
            read_sessions: claims.read_sessions,
            output_session_id: claims.output_session_id,
            max_upload_bytes: claims.max_upload_bytes,
            max_output_files: claims.max_output_files,
            max_requests: claims.max_requests,
            iat: claims.iat,
            exp: claims.exp,
            ...(claims.external_user_id
                ? { external_user_id: claims.external_user_id }
                : {}),
            ...(claims.org_id ? { org_id: claims.org_id } : {}),
            ...(claims.service_id ? { service_id: claims.service_id } : {}),
            ...(claims.principal_source
                ? { principal_source: claims.principal_source }
                : {}),
            ...(claims.auth_context_hash
                ? { auth_context_hash: claims.auth_context_hash }
                : {}),
        },
        secret,
    );
}

export function openEgressGrant(
    token: string,
    secret: string,
    nowSeconds?: number,
): EgressGrantClaims {
    return validateGrant(openToken(secret, token, nowSeconds), token);
}

export function sealEgressHandle(
    claims: WithoutVersion<EgressHandleClaims>,
    secret: string,
): string {
    return sealToken(
        { ...claims, v: EGRESS_GRANT_VERSION } as EgressHandleClaims,
        secret,
    );
}

export function openEgressHandle(
    token: string,
    secret: string,
    nowSeconds?: number,
): EgressHandleClaims {
    return validateHandle(openToken(secret, token, nowSeconds));
}

export function egressGrantFromExecutionClaims(
    claims: ExecutionManifestClaims,
    grantId: string,
): Omit<EgressGrantClaims, 'v' | 'typ'> {
    return {
        grant_id: grantId,
        exec_id: claims.exec_id,
        tenant_id: claims.tenant_id,
        user_id: claims.user_id,
        session_key: claims.session_key,
        input_files: claims.input_files,
        read_sessions: claims.read_sessions,
        output_session_id: claims.output_session_id,
        max_upload_bytes: claims.max_upload_bytes,
        max_output_files: claims.max_output_files,
        max_requests: claims.max_requests,
        iat: claims.iat,
        exp: claims.exp,
        ...(claims.external_user_id
            ? { external_user_id: claims.external_user_id }
            : {}),
        ...(claims.org_id ? { org_id: claims.org_id } : {}),
        ...(claims.service_id ? { service_id: claims.service_id } : {}),
        ...(claims.principal_source
            ? { principal_source: claims.principal_source }
            : {}),
        ...(claims.auth_context_hash
            ? { auth_context_hash: claims.auth_context_hash }
            : {}),
    };
}

function isPayloadFileRef(
    file: t.PayloadBody['files'][number],
): file is PayloadFileRef {
    return (
        'id' in file &&
        'storage_session_id' in file &&
        typeof file.id === 'string' &&
        typeof file.storage_session_id === 'string' &&
        typeof file.name === 'string'
    );
}

function opaqueLabel(prefix: string, value: string): string {
    return `${prefix}:${crypto.createHash('sha256').update(value, 'utf8').digest('base64url').slice(0, 32)}`;
}

function sandboxWorkspaceSessionId(): string {
    return `sbx_${crypto.randomBytes(16).toString('base64url')}`;
}

function collectMaskedInputFiles(
    payload: t.PayloadBody,
): ExecutionManifestInputFile[] {
    return payload.files
        .filter(isPayloadFileRef)
        .map(file => ({
            id: file.id,
            session_id: file.storage_session_id,
            name: file.name,
        }))
        .sort(
            (a, b) =>
                a.session_id.localeCompare(b.session_id) ||
                a.id.localeCompare(b.id) ||
                a.name.localeCompare(b.name),
        );
}

export function prepareSandboxEgress(args: {
    payload: t.PayloadBody;
    claims: ExecutionManifestClaims;
    grantId: string;
    secret: string;
}): PreparedSandboxEgress {
    const { claims, secret } = args;
    const grant = sealEgressGrant(
        egressGrantFromExecutionClaims(claims, args.grantId),
        secret,
    );
    const sessionHandles = new Map<string, string>();
    const now = claims.iat;

    const readSessionHandle = (sessionId: string): string => {
        const cached = sessionHandles.get(sessionId);
        if (cached) return cached;
        const handle = sealEgressHandle(
            {
                typ: 'session',
                dir: 'read',
                grant_id: args.grantId,
                exec_id: claims.exec_id,
                session_id: sessionId,
                iat: now,
                exp: claims.exp,
            },
            secret,
        );
        sessionHandles.set(sessionId, handle);
        return handle;
    };

    const maskedPayload: t.PayloadBody = {
        ...args.payload,
        files: args.payload.files.map(file => {
            if (!isPayloadFileRef(file)) return { ...file };
            return {
                id: sealEgressHandle(
                    {
                        typ: 'object',
                        dir: 'read',
                        grant_id: args.grantId,
                        exec_id: claims.exec_id,
                        session_id: file.storage_session_id,
                        object_id: file.id,
                        name: file.name,
                        iat: now,
                        exp: claims.exp,
                    },
                    secret,
                ),
                storage_session_id: readSessionHandle(file.storage_session_id),
                name: file.name,
            };
        }),
    };

    const outputSessionHandle = sealEgressHandle(
        {
            typ: 'session',
            dir: 'write',
            grant_id: args.grantId,
            exec_id: claims.exec_id,
            session_id: claims.output_session_id,
            iat: now,
            exp: claims.exp,
        },
        secret,
    );
    maskedPayload.session_id = sandboxWorkspaceSessionId();
    maskedPayload.output_session_id = outputSessionHandle;

    const maskedInputFiles = collectMaskedInputFiles(maskedPayload);
    const sandboxVisibleClaims: ExecutionManifestClaims = { ...claims };
    delete sandboxVisibleClaims.external_user_id;
    // Manifests signed by pre-rename workers carry the legacy field name;
    // keep scrubbing it until the external_user_id rollout completes.
    delete (sandboxVisibleClaims as unknown as Record<string, unknown>)[
        'chc_user_id'
    ]; // leak-check:allow
    delete sandboxVisibleClaims.org_id;
    delete sandboxVisibleClaims.service_id;
    const executionManifestClaims: ExecutionManifestClaims = {
        ...sandboxVisibleClaims,
        tenant_id: opaqueLabel('tenant', claims.tenant_id),
        user_id: opaqueLabel('user', claims.user_id),
        session_key: opaqueLabel('session', claims.session_key),
        input_files: maskedInputFiles,
        read_sessions: Array.from(
            new Set(maskedInputFiles.map(file => file.session_id)),
        ).sort(),
        output_session_id: outputSessionHandle,
    };

    return {
        payload: maskedPayload,
        egressGrantToken: grant,
        executionManifestClaims,
    };
}

function inputFileKey(
    file: Pick<ExecutionManifestInputFile, 'session_id' | 'id' | 'name'>,
): string {
    return `${file.session_id}\0${file.id}\0${file.name}`;
}

function isDirkeepName(name: string): boolean {
    return name === '.dirkeep' || name.endsWith('/.dirkeep');
}

function verifyHandleExec(
    handle: EgressHandleClaims,
    grant: EgressGrantClaims,
): void {
    if (handle.exec_id !== grant.exec_id) {
        throw new EgressGrantError(
            'scope_mismatch',
            'Egress handle execution does not match grant',
        );
    }
    if (handle.grant_id && handle.grant_id !== grant.grant_id) {
        throw new EgressGrantError(
            'scope_mismatch',
            'Egress handle grant does not match request grant',
        );
    }
}

function assertSessionHandleScope(
    handle: Extract<EgressHandleClaims, { typ: 'session' }>,
    grant: EgressGrantClaims,
    expectedDirection?: 'read' | 'write',
): void {
    if (expectedDirection && handle.dir !== expectedDirection) {
        throw new EgressGrantError(
            'scope_mismatch',
            'Egress session handle direction does not match expected use',
        );
    }
    if (handle.dir === 'read') {
        if (!grant.read_sessions.includes(handle.session_id)) {
            throw new EgressGrantError(
                'scope_mismatch',
                'Egress session handle is outside the grant read scope',
            );
        }
        return;
    }
    if (handle.session_id !== grant.output_session_id) {
        throw new EgressGrantError(
            'scope_mismatch',
            'Egress session handle is outside the grant write scope',
        );
    }
}

function unwrapSessionHandle(
    token: string | undefined,
    grant: EgressGrantClaims,
    secret: string,
    expectedDirection?: 'read' | 'write',
): string | undefined {
    if (!token) return token;
    const handle = openEgressHandle(token, secret);
    verifyHandleExec(handle, grant);
    if (handle.typ !== 'session') {
        throw new EgressGrantError(
            'wrong_type',
            'Expected an egress session handle',
        );
    }
    assertSessionHandleScope(handle, grant, expectedDirection);
    return handle.session_id;
}

function unwrapObjectHandle(
    token: string | undefined,
    rawSessionId: string | undefined,
    grant: EgressGrantClaims,
    secret: string,
): string | undefined {
    if (!token) return token;
    if (!token.startsWith(`${TOKEN_PREFIX}.`)) return token;
    const handle = openEgressHandle(token, secret);
    verifyHandleExec(handle, grant);
    if (handle.typ !== 'object') {
        throw new EgressGrantError(
            'wrong_type',
            'Expected an egress object handle',
        );
    }
    if (rawSessionId && handle.session_id !== rawSessionId) {
        throw new EgressGrantError(
            'scope_mismatch',
            'Egress object handle session does not match file ref',
        );
    }
    const allowedInputs = new Set(grant.input_files.map(inputFileKey));
    const isAllowedDirkeep =
        isDirkeepName(handle.name) &&
        grant.read_sessions.includes(handle.session_id);
    if (
        !allowedInputs.has(
            inputFileKey({
                session_id: handle.session_id,
                id: handle.object_id,
                name: handle.name,
            }),
        ) &&
        !isAllowedDirkeep
    ) {
        throw new EgressGrantError(
            'scope_mismatch',
            'Egress object handle is outside the grant input scope',
        );
    }
    return handle.object_id;
}

function isOpaqueEgressToken(token: string | undefined): boolean {
    return token?.startsWith(`${TOKEN_PREFIX}.`) === true;
}

function rejectRawReadObjectRef(
    objectId: string | undefined,
    storageSessionId: string | undefined,
    storageSessionWasOpaque: boolean,
    grant: EgressGrantClaims,
): void {
    if (
        objectId &&
        storageSessionWasOpaque &&
        storageSessionId &&
        storageSessionId !== grant.output_session_id &&
        !isOpaqueEgressToken(objectId)
    ) {
        throw new EgressGrantError(
            'scope_mismatch',
            'Sandbox returned a raw object id for a read-scoped file ref',
        );
    }
}

function restoreFileRef(
    file: t.FileRef,
    grant: EgressGrantClaims,
    secret: string,
): t.FileRef {
    const storageSessionWasOpaque = isOpaqueEgressToken(
        file.storage_session_id,
    );
    const storageSessionId = unwrapSessionHandle(
        file.storage_session_id,
        grant,
        secret,
    );
    rejectRawReadObjectRef(
        file.id,
        storageSessionId,
        storageSessionWasOpaque,
        grant,
    );
    const restored: t.FileRef = {
        ...file,
        id:
            unwrapObjectHandle(file.id, storageSessionId, grant, secret) ??
            file.id,
        storage_session_id: storageSessionId,
    };
    if (file.modified_from) {
        const modifiedFromSessionWasOpaque = isOpaqueEgressToken(
            file.modified_from.storage_session_id,
        );
        const modifiedFromSession = unwrapSessionHandle(
            file.modified_from.storage_session_id,
            grant,
            secret,
        );
        rejectRawReadObjectRef(
            file.modified_from.id,
            modifiedFromSession,
            modifiedFromSessionWasOpaque,
            grant,
        );
        restored.modified_from = {
            id:
                unwrapObjectHandle(
                    file.modified_from.id,
                    modifiedFromSession,
                    grant,
                    secret,
                ) ?? file.modified_from.id,
            storage_session_id:
                modifiedFromSession ?? file.modified_from.storage_session_id,
        };
    }
    return restored;
}

export function restoreSandboxExecuteResult<
    T extends { session_id: string; files?: t.FileRefs },
>(response: T, token: string, secret: string): T {
    const grant = openEgressGrant(token, secret);
    return {
        ...response,
        session_id:
            unwrapSessionHandle(response.session_id, grant, secret, 'write') ??
            response.session_id,
        files: response.files?.map(file => restoreFileRef(file, grant, secret)),
    };
}

export function sealPtcCallbackToken(args: {
    grantId?: string;
    executionId: string;
    sessionId: string;
    callbackToken: string;
    allowedToolNames?: string[];
    expiresAt: number;
    issuedAt: number;
    secret: string;
}): string {
    return sealEgressHandle(
        {
            typ: 'ptc-callback',
            ...(args.grantId ? { grant_id: args.grantId } : {}),
            exec_id: args.executionId,
            session_id: args.sessionId,
            callback_token: args.callbackToken,
            ...(args.allowedToolNames
                ? { allowed_tool_names: args.allowedToolNames }
                : {}),
            iat: args.issuedAt,
            exp: args.expiresAt,
        },
        args.secret,
    );
}

export function openPtcCallbackToken(
    token: string,
    secret: string,
    nowSeconds?: number,
): Extract<EgressHandleClaims, { typ: 'ptc-callback' }> {
    const handle = openEgressHandle(token, secret, nowSeconds);
    if (handle.typ !== 'ptc-callback') {
        throw new EgressGrantError(
            'wrong_type',
            'Expected a PTC callback token',
        );
    }
    return handle;
}
