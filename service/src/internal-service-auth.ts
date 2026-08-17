import crypto from 'crypto';
import type { NextFunction, Request, Response } from 'express';

export const INTERNAL_SERVICE_TOKEN_ENV = 'CODEAPI_INTERNAL_SERVICE_TOKEN';
export const INTERNAL_SERVICE_TOKEN_HEADER = 'X-CodeAPI-Internal-Token';

type HeaderRecord = Record<string, string | string[] | undefined>;

function configuredToken(): string {
    return (process.env[INTERNAL_SERVICE_TOKEN_ENV] ?? '').trim();
}

export function internalServiceAuthEnabled(): boolean {
    return configuredToken().length > 0;
}

function constantTimeEquals(actual: string, expected: string): boolean {
    const actualHash = crypto.createHash('sha256').update(actual).digest();
    const expectedHash = crypto.createHash('sha256').update(expected).digest();
    return crypto.timingSafeEqual(actualHash, expectedHash);
}

function headerValue(headers: Headers | HeaderRecord, name: string): string {
    if (typeof (headers as Headers).get === 'function') {
        return (headers as Headers).get(name) ?? '';
    }

    const value = (headers as HeaderRecord)[name.toLowerCase()];
    if (Array.isArray(value)) {
        return value[0] ?? '';
    }
    return value ?? '';
}

export function isAuthorizedInternalServiceRequest(
    headers: Headers | HeaderRecord,
): boolean {
    const expected = configuredToken();
    if (!expected) return true;

    const actual = headerValue(headers, INTERNAL_SERVICE_TOKEN_HEADER).trim();
    if (!actual) return false;
    return constantTimeEquals(actual, expected);
}

export function internalServiceHeaders(
    headers: Record<string, string> = {},
): Record<string, string> {
    const token = configuredToken();
    if (!token) return headers;
    return {
        ...headers,
        [INTERNAL_SERVICE_TOKEN_HEADER]: token,
    };
}

export function requireInternalServiceAuth(
    req: Request,
    res: Response,
    next: NextFunction,
): void | Response {
    if (isAuthorizedInternalServiceRequest(req.headers)) {
        return next();
    }

    return res.status(401).json({ error: 'Unauthorized' });
}

export function requireConfiguredInternalServiceAuth(
    req: Request,
    res: Response,
    next: NextFunction,
): void | Response {
    if (!internalServiceAuthEnabled()) {
        return res
            .status(503)
            .json({ error: 'Internal service auth is not configured' });
    }

    return requireInternalServiceAuth(req, res, next);
}
