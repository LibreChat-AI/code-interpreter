import { CODE_ENV_KINDS } from './types';
import type { AuthenticatedRequest, CodeEnvKind } from './types';
import {
    getExecutionIdentity,
    resolveStorageNamespace,
} from './execution-identity';

/* Read directly from `process.env` (not the snapshotted `env` object)
 * so test suites can flip the flag between cases without module-cache
 * surgery. The cost of one env access per sessionKey resolution is
 * trivial relative to the request lifecycle. */
function strictTenantIsolation(): boolean {
    return process.env.CODEAPI_TENANT_ISOLATION_STRICT === 'true';
}

const KNOWN_KINDS_RUNTIME = new Set<string>(CODE_ENV_KINDS);

/**
 * Inputs sufficient to derive a sessionKey. `RequestFile` (per-file
 * payloads on `/exec`) satisfies this shape directly; the upload and
 * download paths construct an inline literal from form fields / URL
 * params with the same shape so every call site flows through the
 * same kind switch.
 */
export interface SessionKeyInput {
    kind: CodeEnvKind;
    /** Resource identity. Sessionkey-meaningful for `'skill'` / `'agent'`;
     *  ignored for `'user'` (auth context provides the userId). Carried on
     *  the input for shape uniformity across kinds. */
    id: string;
    /** Required when `kind === 'skill'`; rejected by the validator
     *  otherwise. */
    version?: number;
}

export class SessionKeyResolutionError extends Error {
    readonly status: 400 | 500;
    constructor(status: 400 | 500, message: string) {
        super(message);
        this.name = 'SessionKeyResolutionError';
        this.status = status;
    }
}

/**
 * Derive the sessionKey for a file or upload bucket from the request's
 * auth context and the resource it belongs to.
 *
 * Output shape per kind:
 *   - `skill`:  `<storageNamespace>:skill:<id>:v:<version>`
 *   - `agent`:  `<storageNamespace>:agent:<id>`
 *   - `user`:   `<storageNamespace>:user:<executionIdentity.canonicalUserId>`
 *
 * Cross-user-within-tenant sharing for `'skill'` and `'agent'` is a
 * designed property of the kind switch (the user dimension is omitted
 * from the sessionKey for those kinds), not an emergent side effect of
 * any legacy `entity_id` behavior.
 *
 * Storage namespace is derived server-side from execution identity. Enterprise
 * deployments currently map this from `req.codeApiAuthContext.tenantId`; OSS
 * or single-tenant deployments use the configured single-tenant namespace.
 * When `CODEAPI_TENANT_ISOLATION_STRICT=true` and tenantId is missing, throws a
 * 500 — the auth layer is responsible for populating it on every
 * authenticated request, and a missing value would otherwise silently
 * collapse cross-tenant requests under the same `'legacy'` prefix. In
 * non-strict mode the configured single-tenant fallback is intentional so
 * deploys without an auth tenancy concept keep working.
 */
export function resolveSessionKey(
    req: AuthenticatedRequest,
    input: SessionKeyInput,
): string {
    const storageNamespace = resolveSessionStorageNamespace(req);

    switch (input.kind) {
        case 'skill': {
            if (input.version == null) {
                throw new SessionKeyResolutionError(
                    400,
                    `resolveSessionKey: kind 'skill' requires version (got id=${input.id})`,
                );
            }
            return `${storageNamespace}:skill:${input.id}:v:${input.version}`;
        }
        case 'agent':
            return `${storageNamespace}:agent:${input.id}`;
        case 'user': {
            /* `input.id` is informational only for `kind: 'user'` — the
             * sessionKey derives from auth context. Kept on the input for
             * shape uniformity. */
            const userId = getExecutionIdentity(req).canonicalUserId;
            if (!userId) {
                throw new SessionKeyResolutionError(
                    400,
                    "resolveSessionKey: kind 'user' requires authContext.userId",
                );
            }
            return `${storageNamespace}:user:${userId}`;
        }
        default: {
            /* Exhaustive check: TypeScript catches missing switch arms when a
             * new kind is added to `CODE_ENV_KINDS`. */
            const _exhaustive: never = input.kind;
            throw new SessionKeyResolutionError(
                400,
                `unknown kind: ${_exhaustive as string}`,
            );
        }
    }
}

/**
 * Output bucket sessionKey for `/exec` runs. Hardcoded user-private
 * regardless of input file kinds — outputs always belong to the
 * requesting user. Same `CODEAPI_TENANT_ISOLATION_STRICT` gate as
 * `resolveSessionKey`. Skill executions do NOT produce a skill-scoped
 * output bucket; that's a deliberate behavioral change from the legacy
 * entity_id-driven derivation. See codeapi #1455 / Phase C design.
 */
export function resolveOutputBucketSessionKey(
    req: AuthenticatedRequest,
): string {
    const storageNamespace = resolveSessionStorageNamespace(req);
    const userId = getExecutionIdentity(req).canonicalUserId;
    if (!userId) {
        throw new SessionKeyResolutionError(
            500,
            'resolveOutputBucketSessionKey: authContext.userId is missing',
        );
    }
    return `${storageNamespace}:user:${userId}`;
}

/**
 * Parse `kind`/`id`/`version` upload form fields (or the equivalent
 * URL query params on download routes) into a validated
 * `SessionKeyInput`. Throws `SessionKeyResolutionError(400, ...)` on
 * invalid input. Same semantic rules as `validateRequestedFiles`:
 * kind is required, version is required for `'skill'` and forbidden
 * otherwise.
 *
 * `authContextUserId` is the fallback `id` for `kind: 'user'` when
 * the caller didn't include `id` on the request — sessionKey
 * derivation ignores `id` for user-kind anyway, but we still set it
 * for shape uniformity.
 */
export function parseUploadSessionKeyInput(args: {
    kind: string | undefined;
    id: string | undefined;
    version: string | undefined;
    authContextUserId: string;
}): SessionKeyInput {
    const { kind, id, version, authContextUserId } = args;
    if (typeof kind !== 'string' || !KNOWN_KINDS_RUNTIME.has(kind)) {
        throw new SessionKeyResolutionError(
            400,
            `kind must be one of: ${[...KNOWN_KINDS_RUNTIME].join(', ')}`,
        );
    }
    const resolvedId =
        typeof id === 'string' && id
            ? id
            : kind === 'user'
              ? authContextUserId
              : '';
    if (!resolvedId) {
        throw new SessionKeyResolutionError(
            400,
            `id is required for kind: '${kind}'`,
        );
    }
    if (kind === 'skill') {
        if (version === undefined || version === '') {
            throw new SessionKeyResolutionError(
                400,
                "version is required for kind: 'skill'",
            );
        }
        const versionNum = Number(version);
        if (!Number.isFinite(versionNum)) {
            throw new SessionKeyResolutionError(
                400,
                "version must be a number for kind: 'skill'",
            );
        }
        return { kind: 'skill', id: resolvedId, version: versionNum };
    }
    if (version !== undefined && version !== '') {
        throw new SessionKeyResolutionError(
            400,
            `version is only valid for kind: 'skill'`,
        );
    }
    return { kind: kind as CodeEnvKind, id: resolvedId };
}

function resolveSessionStorageNamespace(req: AuthenticatedRequest): string {
    const identity = getExecutionIdentity(req);
    if (!strictTenantIsolation() || req.codeApiAuthContext?.tenantId) {
        return identity.storageNamespace;
    }

    return resolveStorageNamespace(req.codeApiAuthContext, {
        requireTenant: true,
        onMissingTenant: () =>
            new SessionKeyResolutionError(
                500,
                'tenantId missing from auth context (CODEAPI_TENANT_ISOLATION_STRICT=true)',
            ),
    });
}
