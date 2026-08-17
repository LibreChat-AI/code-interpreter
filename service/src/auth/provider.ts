import type { Request } from 'express';
import type { CodeApiPrincipal } from './principal';

export interface AuthProvider {
    verify(req: Request): Promise<CodeApiPrincipal | null>;
}

export type CodeApiAuthProviderMode = 'librechat-jwt' | 'none';

export class AuthProviderConfigError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'AuthProviderConfigError';
    }
}

export function getAuthProviderMode(): CodeApiAuthProviderMode {
    const mode = process.env.CODEAPI_AUTH_PROVIDER;
    if (mode == null || mode === '') {
        return 'librechat-jwt';
    }
    if (mode === 'librechat-jwt' || mode === 'none') {
        return mode;
    }
    throw new AuthProviderConfigError(`Invalid CODEAPI_AUTH_PROVIDER: ${mode}`);
}
