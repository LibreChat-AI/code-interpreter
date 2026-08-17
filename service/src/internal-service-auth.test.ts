import { afterEach, describe, expect, test } from 'bun:test';
import type { NextFunction, Request, Response } from 'express';
import {
    INTERNAL_SERVICE_TOKEN_ENV,
    INTERNAL_SERVICE_TOKEN_HEADER,
    internalServiceAuthEnabled,
    internalServiceHeaders,
    isAuthorizedInternalServiceRequest,
    requireConfiguredInternalServiceAuth,
    requireInternalServiceAuth,
} from './internal-service-auth';

const originalToken = process.env[INTERNAL_SERVICE_TOKEN_ENV];

afterEach(() => {
    if (originalToken === undefined) {
        delete process.env[INTERNAL_SERVICE_TOKEN_ENV];
    } else {
        process.env[INTERNAL_SERVICE_TOKEN_ENV] = originalToken;
    }
});

describe('internal service auth', () => {
    test('is disabled when no token is configured', () => {
        delete process.env[INTERNAL_SERVICE_TOKEN_ENV];

        expect(internalServiceAuthEnabled()).toBe(false);
        expect(isAuthorizedInternalServiceRequest({})).toBe(true);
        expect(internalServiceHeaders()).toEqual({});
    });

    test('adds the configured token to outbound headers', () => {
        process.env[INTERNAL_SERVICE_TOKEN_ENV] = 'secret-token';

        expect(internalServiceAuthEnabled()).toBe(true);
        expect(internalServiceHeaders({ Accept: 'application/json' })).toEqual({
            Accept: 'application/json',
            [INTERNAL_SERVICE_TOKEN_HEADER]: 'secret-token',
        });
    });

    test('authorizes matching node-style headers only', () => {
        process.env[INTERNAL_SERVICE_TOKEN_ENV] = 'secret-token';

        expect(
            isAuthorizedInternalServiceRequest({
                [INTERNAL_SERVICE_TOKEN_HEADER.toLowerCase()]: 'secret-token',
            }),
        ).toBe(true);
        expect(
            isAuthorizedInternalServiceRequest({
                [INTERNAL_SERVICE_TOKEN_HEADER.toLowerCase()]: 'wrong-token',
            }),
        ).toBe(false);
        expect(isAuthorizedInternalServiceRequest({})).toBe(false);
    });

    test('authorizes matching fetch headers only', () => {
        process.env[INTERNAL_SERVICE_TOKEN_ENV] = 'secret-token';

        const ok = new Headers({
            [INTERNAL_SERVICE_TOKEN_HEADER]: 'secret-token',
        });
        const bad = new Headers({
            [INTERNAL_SERVICE_TOKEN_HEADER]: 'wrong-token',
        });

        expect(isAuthorizedInternalServiceRequest(ok)).toBe(true);
        expect(isAuthorizedInternalServiceRequest(bad)).toBe(false);
    });

    test('express middleware advances valid tokens', () => {
        process.env[INTERNAL_SERVICE_TOKEN_ENV] = 'secret-token';

        let nextCalled = false;

        const req = {
            headers: {
                [INTERNAL_SERVICE_TOKEN_HEADER.toLowerCase()]: 'secret-token',
            },
        } as Request;
        const res = {} as Response;
        const next: NextFunction = () => {
            nextCalled = true;
        };

        requireInternalServiceAuth(req, res, next);

        expect(nextCalled).toBe(true);
    });

    test('express middleware rejects missing tokens', () => {
        process.env[INTERNAL_SERVICE_TOKEN_ENV] = 'secret-token';

        let statusCode = 0;
        let body: unknown;
        let nextCalled = false;

        const req = { headers: {} } as Request;
        const res = {
            status(code: number) {
                statusCode = code;
                return this;
            },
            json(value: unknown) {
                body = value;
                return this;
            },
        } as Response;
        const next: NextFunction = () => {
            nextCalled = true;
        };

        requireInternalServiceAuth(req, res, next);

        expect(nextCalled).toBe(false);
        expect(statusCode).toBe(401);
        expect(body).toEqual({ error: 'Unauthorized' });
    });

    test('express middleware rejects wrong tokens', () => {
        process.env[INTERNAL_SERVICE_TOKEN_ENV] = 'secret-token';

        let statusCode = 0;
        let body: unknown;
        let nextCalled = false;

        const req = {
            headers: {
                [INTERNAL_SERVICE_TOKEN_HEADER.toLowerCase()]: 'wrong-token',
            },
        } as Request;
        const res = {
            status(code: number) {
                statusCode = code;
                return this;
            },
            json(value: unknown) {
                body = value;
                return this;
            },
        } as Response;
        const next: NextFunction = () => {
            nextCalled = true;
        };

        requireInternalServiceAuth(req, res, next);

        expect(nextCalled).toBe(false);
        expect(statusCode).toBe(401);
        expect(body).toEqual({ error: 'Unauthorized' });
    });

    test('configured-token middleware fails closed when no token is configured', () => {
        delete process.env[INTERNAL_SERVICE_TOKEN_ENV];

        let statusCode = 0;
        let body: unknown;
        let nextCalled = false;

        const req = { headers: {} } as Request;
        const res = {
            status(code: number) {
                statusCode = code;
                return this;
            },
            json(value: unknown) {
                body = value;
                return this;
            },
        } as Response;
        const next: NextFunction = () => {
            nextCalled = true;
        };

        requireConfiguredInternalServiceAuth(req, res, next);

        expect(nextCalled).toBe(false);
        expect(statusCode).toBe(503);
        expect(body).toEqual({
            error: 'Internal service auth is not configured',
        });
    });
});
