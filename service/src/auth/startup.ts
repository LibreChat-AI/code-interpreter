import { env } from '../config';
import logger from '../logger';
import { validateLibreChatJwtVerifierConfig } from './librechat-jwt';
import { AuthProviderConfigError, getAuthProviderMode } from './provider';
import { validateSyntheticAccessTokenConfig } from './synthetic';
import type { CodeApiAuthProviderMode } from './provider';

type StartupAuthOptions = {
    mode?: CodeApiAuthProviderMode;
    isLocalMode?: boolean;
    allowNone?: boolean;
    validateJwtVerifierConfig?: () => void;
};

export async function validateStartupAuthConfig(
    options: StartupAuthOptions = {},
): Promise<void> {
    const mode = options.mode ?? getAuthProviderMode();
    const isLocalMode = options.isLocalMode ?? env.LOCAL_MODE;

    validateSyntheticAccessTokenConfig();

    if (isLocalMode) {
        logger.info('LOCAL MODE - Authentication bypassed');
        return;
    }

    if (mode === 'none') {
        const allowNone =
            options.allowNone ??
            process.env.CODEAPI_ALLOW_AUTH_PROVIDER_NONE === 'true';
        if (!allowNone) {
            throw new AuthProviderConfigError(
                'CODEAPI_AUTH_PROVIDER=none is only allowed in local mode',
            );
        }
        logger.warn('CODEAPI_AUTH_PROVIDER=none - authentication bypassed');
        return;
    }

    const validateJwtVerifierConfig =
        options.validateJwtVerifierConfig ?? validateLibreChatJwtVerifierConfig;
    validateJwtVerifierConfig();
    logger.info('CodeAPI LibreChat JWT verifier configuration validated');
}
