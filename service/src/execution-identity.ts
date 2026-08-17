import type { CodeApiPrincipal } from './auth/principal';
import type { AuthenticatedRequest, CodeApiAuthContext } from './types';

const DEFAULT_SINGLE_TENANT_NAMESPACE = 'legacy';
const DEFAULT_PRINCIPAL_SOURCE = 'librechat_jwt';

export interface ExecutionIdentity {
    /** Requesting user from the authenticated principal. */
    userId: string;
    /** User identity to persist across replay and sandbox capability scopes. */
    canonicalUserId: string;
    /** Core storage/rate-limit namespace. Enterprise adapters map this from tenant identity. */
    storageNamespace: string;
    /** Back-compat alias for wire/persisted fields that still use tenant naming. */
    tenantId: string;
    orgId?: string;
    serviceId?: string;
    externalUserId?: string;
    principalSource: string;
    authContextHash?: string;
    credentialId?: string;
    planId?: string;
}

export interface BuildExecutionIdentityArgs {
    userId: string;
    authContext?: CodeApiAuthContext;
    principal?: CodeApiPrincipal;
    canonicalUserId?: string;
    storageNamespace?: string;
    orgId?: string;
    serviceId?: string;
    externalUserId?: string;
    principalSource?: string;
    authContextHash?: string;
    credentialId?: string;
    planId?: string;
}

export interface ResolveStorageNamespaceOptions {
    requireTenant?: boolean;
    onMissingTenant?: () => Error;
    singleTenantNamespace?: string;
}

export function resolveSingleTenantNamespace(): string {
    const configured = process.env.CODEAPI_JWT_SINGLE_TENANT_ID;
    if (configured != null && configured.trim() !== '') {
        return configured.trim();
    }
    return DEFAULT_SINGLE_TENANT_NAMESPACE;
}

export function resolveStorageNamespace(
    authContext: CodeApiAuthContext | undefined,
    options: ResolveStorageNamespaceOptions = {},
): string {
    const tenant = authContext?.tenantId;
    if (tenant) {
        return tenant;
    }
    if (options.requireTenant === true) {
        throw (
            options.onMissingTenant?.() ??
            new Error('tenantId missing from auth context')
        );
    }
    return options.singleTenantNamespace ?? resolveSingleTenantNamespace();
}

export function buildExecutionIdentity(
    args: BuildExecutionIdentityArgs,
): ExecutionIdentity {
    const principal = args.principal;
    const authContext = args.authContext;
    const storageNamespace =
        args.storageNamespace ??
        principal?.tenantId ??
        resolveStorageNamespace(authContext);
    const canonicalUserId =
        args.canonicalUserId ??
        authContext?.userId ??
        principal?.userId ??
        args.userId;

    return {
        userId: args.userId,
        canonicalUserId,
        storageNamespace,
        tenantId: storageNamespace,
        orgId: args.orgId ?? principal?.orgId ?? authContext?.orgId,
        serviceId:
            args.serviceId ?? principal?.serviceId ?? authContext?.serviceId,
        externalUserId:
            args.externalUserId ??
            principal?.externalUserId ??
            authContext?.externalUserId,
        principalSource:
            args.principalSource ??
            principal?.principalSource ??
            authContext?.principalSource ??
            DEFAULT_PRINCIPAL_SOURCE,
        authContextHash:
            args.authContextHash ??
            principal?.authContextHash ??
            authContext?.authContextHash,
        credentialId: args.credentialId ?? principal?.credentialId,
        planId: args.planId ?? principal?.planId,
    };
}

export function executionIdentityFromPrincipal(
    principal: CodeApiPrincipal,
): ExecutionIdentity {
    return buildExecutionIdentity({
        userId: principal.userId,
        canonicalUserId: principal.userId,
        storageNamespace: principal.tenantId,
        principal,
    });
}

export function getExecutionIdentity(
    req: AuthenticatedRequest,
    fallbackUserId = req.codeApiAuthContext?.userId ??
        req.codeApiPrincipal?.userId ??
        '',
): ExecutionIdentity {
    if (req.executionIdentity) {
        return req.executionIdentity;
    }
    const principal = req.codeApiPrincipal;
    return buildExecutionIdentity({
        userId: fallbackUserId,
        authContext: req.codeApiAuthContext,
        principal,
    });
}

export function applyExecutionIdentity(
    req: AuthenticatedRequest,
    identity: ExecutionIdentity,
): void {
    req.executionIdentity = identity;
}
