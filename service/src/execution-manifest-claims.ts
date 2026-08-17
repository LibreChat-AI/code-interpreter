import { env } from './config';
import type * as t from './types';
import { buildExecutionIdentity } from './execution-identity';
import {
    EXECUTION_MANIFEST_VERSION,
    type ExecutionManifestClaims,
    type ExecutionManifestInputFile,
} from './execution-manifest';

interface PayloadFileRef {
    /** Storage file id (the per-file uuid the file_server registered the
     *  upload under). Lives in `RequestFile.id` after the resource-id
     *  split — the resource identity (skill/agent) is carried in
     *  `resource_id` instead, but isn't part of the manifest's input
     *  file scope (which only verifies the storage tuple hasn't shifted
     *  between sign-time and validation-time). */
    id: string;
    storage_session_id: string;
    name: string;
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

export function collectManifestInputFiles(
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

export function buildExecutionManifestClaims(args: {
    req: t.AuthenticatedRequest;
    executionId: string;
    userId: string;
    sessionKey: string;
    outputSessionId: string;
    payload: t.PayloadBody;
    nowSeconds?: number;
    tenantId?: string;
    canonicalUserId?: string;
    orgId?: string;
    serviceId?: string;
    externalUserId?: string;
    principalSource?: string;
    authContextHash?: string;
}): ExecutionManifestClaims {
    const now = args.nowSeconds ?? Math.floor(Date.now() / 1000);
    const inputFiles = collectManifestInputFiles(args.payload);
    const readSessions = Array.from(
        new Set(inputFiles.map(file => file.session_id)),
    ).sort();
    const ctx = args.req.codeApiAuthContext;
    const identity = buildExecutionIdentity({
        userId: args.userId,
        authContext: ctx,
        storageNamespace: args.tenantId,
        canonicalUserId: args.canonicalUserId,
        orgId: args.orgId,
        serviceId: args.serviceId,
        externalUserId: args.externalUserId,
        principalSource: args.principalSource,
        authContextHash: args.authContextHash,
    });

    return {
        v: EXECUTION_MANIFEST_VERSION,
        exec_id: args.executionId,
        tenant_id: identity.storageNamespace,
        user_id: identity.canonicalUserId,
        session_key: args.sessionKey,
        input_files: inputFiles,
        read_sessions: readSessions,
        output_session_id: args.outputSessionId,
        max_upload_bytes: env.EXECUTION_MANIFEST_MAX_UPLOAD_BYTES,
        max_output_files: env.EXECUTION_MANIFEST_MAX_OUTPUT_FILES,
        max_requests: env.EXECUTION_MANIFEST_MAX_REQUESTS,
        iat: now,
        exp: now + env.EXECUTION_MANIFEST_TTL_SECONDS,
        tool_call_socket: args.payload.tool_call_socket === true,
        ...(identity.externalUserId
            ? { external_user_id: identity.externalUserId }
            : {}),
        ...(identity.orgId ? { org_id: identity.orgId } : {}),
        ...(identity.serviceId ? { service_id: identity.serviceId } : {}),
        principal_source: identity.principalSource,
        ...(identity.authContextHash
            ? { auth_context_hash: identity.authContextHash }
            : {}),
    };
}

export function maybeBuildExecutionManifestClaims(
    args: Parameters<typeof buildExecutionManifestClaims>[0],
): ExecutionManifestClaims | undefined {
    if (!env.EXECUTION_MANIFEST_PRIVATE_KEY && !env.EXECUTION_MANIFEST_SECRET)
        return undefined;
    return buildExecutionManifestClaims(args);
}
