import path from 'path';
import type * as t from '../types';
import { isValidId, isValidResourceId } from '../utils';
import { CODE_ENV_KINDS } from '../types';
import { resolveSessionKey, SessionKeyResolutionError } from '../session-key';

const MAX_FILE_REF_NAME_LENGTH = 256;
const MAX_FILE_REF_NESTING_DEPTH = 10;
const KNOWN_KINDS = new Set<string>(CODE_ENV_KINDS);

/* Diagnostic redaction bounds for `describeValue`. Short strings
 * (≤64 chars — typical id/slug shapes) inline whole; longer ones
 * become a head…tail sample so logs can distinguish "wrong shape"
 * from "wrong char" without dumping unbounded user input. */
const REDACT_INLINE_THRESHOLD = 64;
const REDACT_PREFIX_LEN = 32;
const REDACT_SUFFIX_LEN = 16;

type FileRefStore = {
    get(key: string): Promise<string | null>;
    exists(key: string): Promise<number>;
};

export type FileRefAuthDenyReason =
    'session_key_mismatch' | 'upload_missing' | 'invalid_input';

export class FileRefAuthorizationError extends Error {
    readonly status: 400 | 403;
    readonly reason: FileRefAuthDenyReason;
    readonly context: Record<string, unknown>;

    constructor(
        status: 400 | 403,
        message: string,
        reason: FileRefAuthDenyReason = 'invalid_input',
        context: Record<string, unknown> = {},
    ) {
        super(message);
        this.name = 'FileRefAuthorizationError';
        this.status = status;
        this.reason = reason;
        this.context = context;
    }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeValue(value: unknown): Record<string, unknown> {
    const type = typeof value;
    if (type !== 'string') {
        return { type };
    }
    const s = value as string;
    if (s.length <= REDACT_INLINE_THRESHOLD) {
        return { type, length: s.length, value: s };
    }
    return {
        type,
        length: s.length,
        sample: `${s.slice(0, REDACT_PREFIX_LEN)}…${s.slice(-REDACT_SUFFIX_LEN)}`,
    };
}

function failValidation(
    message: string,
    context: Record<string, unknown>,
): never {
    throw new FileRefAuthorizationError(400, message, 'invalid_input', context);
}

function validateFileRefName(name: string, index: number): void {
    const ctx = { index, field: 'name', ...describeValue(name) };
    if (!name || name === '.') {
        failValidation('files[].name must not be empty', ctx);
    }
    if (name.length > MAX_FILE_REF_NAME_LENGTH) {
        failValidation(
            `files[].name must not exceed ${MAX_FILE_REF_NAME_LENGTH} characters`,
            ctx,
        );
    }
    if (name.includes('\0') || name.includes('\\')) {
        failValidation('files[].name contains invalid path characters', ctx);
    }
    if (path.posix.isAbsolute(name)) {
        failValidation('files[].name must be a relative path', ctx);
    }
    const segments = name.split('/');
    if (
        segments.some(
            segment => segment === '' || segment === '.' || segment === '..',
        )
    ) {
        failValidation(
            'files[].name must not contain empty, current, or parent path segments',
            ctx,
        );
    }
    if (path.posix.normalize(name) !== name || name.endsWith('/')) {
        failValidation('files[].name must be canonical and file-like', ctx);
    }
    const depth = segments.length;
    if (depth > MAX_FILE_REF_NESTING_DEPTH) {
        failValidation(
            `files[].name exceeds maximum nesting depth of ${MAX_FILE_REF_NESTING_DEPTH}`,
            ctx,
        );
    }
}

export function validateRequestedFiles(files: unknown): t.RequestFile[] {
    if (files == null) return [];
    if (!Array.isArray(files)) {
        throw new FileRefAuthorizationError(400, 'files must be an array');
    }

    return files.map((file, index) => {
        if (!isPlainObject(file)) {
            failValidation(`files[${index}] must be an object`, {
                index,
                ...describeValue(file),
            });
        }

        const { id, resource_id, storage_session_id, name, kind, version } =
            file;
        if (typeof id !== 'string' || !isValidId(id)) {
            failValidation(`files[${index}].id is invalid`, {
                index,
                field: 'id',
                ...describeValue(id),
            });
        }
        /* `resource_id` covers heterogeneous upstream identity formats
         * (24-char Mongo ObjectId for skills, agent slugs, etc.) — see
         * `isValidResourceId` for the rationale on the looser shape. */
        if (
            typeof resource_id !== 'string' ||
            !isValidResourceId(resource_id)
        ) {
            failValidation(`files[${index}].resource_id is invalid`, {
                index,
                field: 'resource_id',
                ...describeValue(resource_id),
            });
        }
        if (
            typeof storage_session_id !== 'string' ||
            !isValidId(storage_session_id)
        ) {
            failValidation(`files[${index}].storage_session_id is invalid`, {
                index,
                field: 'storage_session_id',
                ...describeValue(storage_session_id),
            });
        }
        if (typeof name !== 'string') {
            failValidation(`files[${index}].name must be a string`, {
                index,
                field: 'name',
                ...describeValue(name),
            });
        }
        validateFileRefName(name, index);

        if (typeof kind !== 'string' || !KNOWN_KINDS.has(kind)) {
            failValidation(
                `files[${index}].kind must be one of: ${[...CODE_ENV_KINDS].join(', ')}`,
                { index, field: 'kind', ...describeValue(kind) },
            );
        }
        /* `version` rules pin the cache-invalidation contract at the type
         * boundary: skill files MUST carry version (so a skill edit ->
         * version bump -> new sessionKey -> fresh cache); other kinds MUST
         * NOT carry version (it would silently change the sessionKey shape
         * for what is otherwise a versionless resource). */
        if (kind === 'skill') {
            if (typeof version !== 'number' || !Number.isFinite(version)) {
                failValidation(
                    `files[${index}].version is required for kind: 'skill'`,
                    {
                        index,
                        field: 'version',
                        kind,
                        ...describeValue(version),
                    },
                );
            }
        } else if (version !== undefined) {
            failValidation(
                `files[${index}].version is only valid for kind: 'skill'`,
                {
                    index,
                    field: 'version',
                    kind,
                    ...describeValue(version),
                },
            );
        }

        const result: t.RequestFile = {
            id,
            resource_id,
            storage_session_id,
            name,
            kind: kind as t.CodeEnvKind,
        };
        if (version !== undefined) {
            result.version = version as number;
        }
        return result;
    });
}

export async function authorizeRequestedFiles(args: {
    req: t.AuthenticatedRequest;
    files: unknown;
    store: FileRefStore;
}): Promise<t.RequestFile[]> {
    const requestedFiles = validateRequestedFiles(args.files);
    if (requestedFiles.length === 0) return requestedFiles;

    for (const file of requestedFiles) {
        let sessionKey: string;
        try {
            /* `SessionKeyInput.id` is the RESOURCE id (skill/agent identity),
             * not the storage id. RequestFile keeps `id` on the storage role
             * (matching the worker-side `TFile.id` storage URL contract);
             * map across at the boundary. */
            sessionKey = resolveSessionKey(args.req, {
                kind: file.kind,
                id: file.resource_id,
                version: file.version,
            });
        } catch (err) {
            if (err instanceof SessionKeyResolutionError) {
                /* `SessionKeyResolutionError.status` is 400 | 500; the auth
                 * surface only emits 400 | 403. A 500 here means an
                 * environmental misconfiguration (e.g. strict-mode tenantId
                 * gap) that the auth layer should propagate as-is — let it
                 * bubble out unwrapped so the callsite handler maps it to a
                 * 500 with the original message. */
                if (err.status === 400) {
                    throw new FileRefAuthorizationError(
                        400,
                        err.message,
                        'invalid_input',
                    );
                }
                throw err;
            }
            throw err;
        }

        const cachedSessionKey = await args.store.get(
            `session:${file.storage_session_id}`,
        );
        if (cachedSessionKey !== sessionKey) {
            throw new FileRefAuthorizationError(
                403,
                'Unauthorized file reference',
                'session_key_mismatch',
                {
                    file: {
                        id: file.id,
                        resource_id: file.resource_id,
                        storage_session_id: file.storage_session_id,
                        name: file.name,
                        kind: file.kind,
                        version: file.version,
                    },
                    resolvedSessionKey: sessionKey,
                    cachedSessionKey,
                },
            );
        }

        /* Upload-key check uses `file.id` (the storage nanoid the
         * file_server registered the upload under). `file.resource_id`
         * fed `resolveSessionKey` above for sessionKey re-derivation —
         * the two are different values for shared kinds (skill `_id` vs
         * storage nanoid). */
        const uploadKey = `upload:${sessionKey}${file.storage_session_id}${file.id}`;
        const exists = await args.store.exists(uploadKey);
        if (exists !== 1) {
            throw new FileRefAuthorizationError(
                403,
                'Unauthorized file reference',
                'upload_missing',
                {
                    file: {
                        id: file.id,
                        resource_id: file.resource_id,
                        storage_session_id: file.storage_session_id,
                        name: file.name,
                        kind: file.kind,
                        version: file.version,
                    },
                    resolvedSessionKey: sessionKey,
                    uploadKey,
                },
            );
        }
    }

    return requestedFiles;
}
