import type { ErrorRequestHandler, Request, RequestHandler } from 'express';
import type { AuthenticatedRequest } from '../types';
import { SessionKeyResolutionError } from '../session-key';
import { CodeApiJwtAuthError } from '../auth/librechat-jwt';
import { AuthProviderConfigError } from '../auth/provider';
import { hasSyntheticAccessToken } from '../auth/synthetic';
import logger from '../logger';

function serializeError(error: unknown): unknown {
    if (error instanceof Error) {
        return {
            name: error.name,
            message: error.message,
            stack: error.stack,
            ...(error instanceof CodeApiJwtAuthError
                ? { reason: error.reason }
                : {}),
        };
    }
    return error;
}

function statusFromError(error: unknown): number {
    if (error instanceof SessionKeyResolutionError) {
        return error.status;
    }
    const status = (
        error as { status?: unknown; statusCode?: unknown } | undefined
    )?.status;
    if (typeof status === 'number' && status >= 400 && status < 600) {
        return status;
    }
    const statusCode = (error as { statusCode?: unknown } | undefined)
        ?.statusCode;
    if (
        typeof statusCode === 'number' &&
        statusCode >= 400 &&
        statusCode < 600
    ) {
        return statusCode;
    }
    if (error instanceof CodeApiJwtAuthError) {
        return error.reason === 'config' ? 500 : 401;
    }
    if (error instanceof AuthProviderConfigError) {
        return 500;
    }
    return 500;
}

function requestPath(req: Request): string {
    return req.originalUrl || req.path || req.url;
}

export function buildRequestErrorLogMeta(
    error: unknown,
    req: Request,
): Record<string, unknown> {
    const authReq = req as AuthenticatedRequest;
    return {
        status: statusFromError(error),
        method: req.method,
        path: requestPath(req),
        requestId: req.header('x-request-id') || req.header('x-correlation-id'),
        userAgent: req.header('user-agent'),
        ip: req.ip,
        authProvider: process.env.CODEAPI_AUTH_PROVIDER || 'librechat-jwt',
        principalSource: authReq.codeApiPrincipal?.principalSource,
        userId: authReq.codeApiAuthContext?.userId,
        tenantId: authReq.codeApiAuthContext?.tenantId,
        authContextHash: authReq.codeApiAuthContext?.authContextHash,
        error: serializeError(error),
    };
}

export function buildRequestNotFoundLogMeta(
    req: Request,
): Record<string, unknown> {
    return {
        status: 404,
        method: req.method,
        path: requestPath(req),
        requestId: req.header('x-request-id') || req.header('x-correlation-id'),
        userAgent: req.header('user-agent'),
        ip: req.ip,
        authProvider: process.env.CODEAPI_AUTH_PROVIDER || 'librechat-jwt',
        hasBearerToken: Boolean(
            req
                .header('Authorization')
                ?.match(/^Bearer\s+(.+)$/i)?.[1]
                ?.trim(),
        ),
        hasApiKeyHeader: Boolean(req.header('X-API-Key')),
        hasSyntheticToken: hasSyntheticAccessToken(req),
    };
}

export const requestNotFoundLogger: RequestHandler = (req, res) => {
    logger.warn('Unhandled CodeAPI route', buildRequestNotFoundLogMeta(req));
    res.status(404).json({ error: 'Not found' });
};

export const requestErrorLogger: ErrorRequestHandler = (
    error,
    req,
    res,
    next,
) => {
    const status = statusFromError(error);
    logger.error(
        'Unhandled CodeAPI request error',
        buildRequestErrorLogMeta(error, req),
    );

    if (res.headersSent) {
        next(error);
        return;
    }

    if (error instanceof SessionKeyResolutionError) {
        res.status(status).json({ error: error.message });
        return;
    }

    res.status(status).json({
        error:
            status >= 500
                ? 'Internal server error'
                : ((error as Error | undefined)?.message ?? 'Request failed'),
    });
};
