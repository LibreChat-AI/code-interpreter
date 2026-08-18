// src/middleware/limits.ts
import { createHash } from 'crypto';
import rateLimitFactory, { ipKeyGenerator } from 'express-rate-limit';
import { RedisStore as RateLimitRedisStore } from 'rate-limit-redis';
import type { RateLimitRequestHandler } from 'express-rate-limit';
import type { RedisReply, SendCommandFn } from 'rate-limit-redis';
import type { NextFunction, Request, Response } from 'express';
import type { AuthenticatedRequest } from '../types';
import { env } from '../config';
import { getExecutionIdentity } from '../execution-identity';
import logger from '../logger';

type RedisCommandTarget = {
    call?: (
        command: string,
        ...args: (string | number | Buffer)[]
    ) => Promise<unknown>;
};

let redisCommands: RedisCommandTarget | undefined;

async function getRedisCommands(): Promise<RedisCommandTarget> {
    if (redisCommands) return redisCommands;
    const { connection } = await import('../queue');
    return connection;
}

const sendCommand: SendCommandFn = async (
    command: string,
    ...args: string[]
): Promise<RedisReply> => {
    const target = await getRedisCommands();
    if (typeof target.call === 'function') {
        const result = await target.call(command, ...args);
        return result as RedisReply;
    }
    const commandMethod = (target as Record<string, unknown>)[
        command.toLowerCase()
    ];
    if (typeof commandMethod !== 'function') {
        throw new Error(`Redis command method unavailable: ${command}`);
    }
    const result = await commandMethod.apply(target, args);
    return result as RedisReply;
};

type RequestWithRateLimit = Request & {
    rateLimit?: {
        limit: number;
        used: number;
        remaining: number;
        resetTime?: Date;
    };
};

type RateLimitResponseOptions = {
    message: string;
    structuredBody?: boolean;
    logRejections?: boolean;
};

const unknownPrincipal = 'unknown';

const keySegment = (
    value: string | undefined,
    fallback = unknownPrincipal,
): string => {
    const trimmed = value?.trim();
    return trimmed ? trimmed.replace(/:/g, '_') : fallback;
};

const hashLabel = (value: string | undefined): string | undefined => {
    const trimmed = value?.trim();
    if (!trimmed) return undefined;
    return createHash('sha256').update(trimmed).digest('hex').slice(0, 12);
};

export function setRateLimitRedisForTests(client?: RedisCommandTarget): void {
    redisCommands = client;
}

export function retryAfterSeconds(req: Request, windowMs: number): number {
    const resetTime = (req as RequestWithRateLimit).rateLimit?.resetTime;
    if (resetTime instanceof Date) {
        return Math.max(
            1,
            Math.ceil((resetTime.getTime() - Date.now()) / 1000),
        );
    }
    return Math.max(1, Math.ceil(windowMs / 1000));
}

export function rateLimitResponseBody(
    message: string,
    retryAfter: number,
): {
    error: 'rate_limited';
    message: string;
    retry_after_seconds: number;
} {
    const retryAfterLabel =
        retryAfter === 1 ? '1 second' : `${retryAfter} seconds`;
    return {
        error: 'rate_limited',
        message: `${message} Please retry in ${retryAfterLabel}.`,
        retry_after_seconds: retryAfter,
    };
}

export const keyGenerator = (req: Request): string => {
    const authReq = req as AuthenticatedRequest;
    const identity = getExecutionIdentity(authReq);
    if (identity.canonicalUserId) {
        return `${keySegment(identity.storageNamespace, 'legacy')}:user:${keySegment(identity.canonicalUserId)}`;
    }
    return `ip:${keySegment(ipKeyGenerator(req.ip ?? ''))}`;
};

const buildRateLimiter = (
    prefix: string,
    windowMs: number,
    max: number,
    options: RateLimitResponseOptions,
): RateLimitRequestHandler => {
    return rateLimitFactory({
        windowMs,
        max,
        standardHeaders: 'draft-6',
        legacyHeaders: false,
        store: new RateLimitRedisStore({
            sendCommand,
            prefix: `${prefix}:`,
        }),
        keyGenerator,
        handler: (req: Request, res: Response) => {
            const retryAfter = retryAfterSeconds(req, windowMs);
            const rateLimit = (req as RequestWithRateLimit).rateLimit;
            res.setHeader(
                'RateLimit-Limit',
                (rateLimit?.limit ?? max).toString(),
            );
            res.setHeader('RateLimit-Remaining', '0');
            res.setHeader('RateLimit-Reset', retryAfter.toString());

            if (options.logRejections) {
                const authReq = req as AuthenticatedRequest;
                const principal = authReq.codeApiPrincipal;
                const identity = getExecutionIdentity(authReq);
                const hasIdentity = Boolean(identity.canonicalUserId);
                logger.warn('CodeAPI rate limit rejected', {
                    limiter: prefix,
                    path: req.originalUrl || req.path,
                    retryAfterSeconds: retryAfter,
                    limit: rateLimit?.limit ?? max,
                    windowMs,
                    principalSource: hasIdentity
                        ? identity.principalSource
                        : undefined,
                    tenantHash: hasIdentity
                        ? hashLabel(identity.storageNamespace)
                        : undefined,
                    userHash: hasIdentity
                        ? hashLabel(identity.canonicalUserId)
                        : undefined,
                    credentialHash: hashLabel(principal?.credentialId),
                });
            }

            if (options.structuredBody) {
                return res
                    .status(429)
                    .json(rateLimitResponseBody(options.message, retryAfter));
            }
            const retryAfterLabel =
                retryAfter === 1 ? '1 second' : `${retryAfter} seconds`;
            res.status(429).json({
                error: `${options.message} Please retry in ${retryAfterLabel}.`,
            });
        },
    });
};

export const createRateLimiter = (
    prefix: string,
    windowMs: number,
    max: number,
    options: RateLimitResponseOptions,
): RateLimitRequestHandler => {
    let limiter: RateLimitRequestHandler | undefined;
    const getLimiter = (): RateLimitRequestHandler => {
        limiter ??= buildRateLimiter(prefix, windowMs, max, options);
        return limiter;
    };

    const lazyLimiter = ((req: Request, res: Response, next: NextFunction) => {
        return getLimiter()(req, res, next);
    }) as RateLimitRequestHandler;
    lazyLimiter.resetKey = (key: string): void => getLimiter().resetKey(key);
    lazyLimiter.getKey = (key: string): ReturnType<RateLimitRequestHandler['getKey']> =>
        getLimiter().getKey(key);
    return lazyLimiter;
};

export const executionLimiter = createRateLimiter(
    'exec',
    env.EXEC_LIMIT_WINDOW,
    env.EXEC_MAX_REQUESTS,
    {
        message: 'Too many CodeAPI execution requests.',
        structuredBody: true,
        logRejections: true,
    },
);

export const uploadLimiter = createRateLimiter(
    'upload',
    env.UPLOAD_LIMIT_WINDOW,
    env.UPLOAD_MAX_REQUESTS,
    { message: 'Too many file uploads.' },
);

export const downloadLimiter = createRateLimiter(
    'download',
    env.DOWNLOAD_LIMIT_WINDOW,
    env.DOWNLOAD_MAX_REQUESTS,
    { message: 'Too many file downloads.' },
);

export const fetchLimiter = createRateLimiter(
    'fetch',
    env.FETCH_LIMIT_WINDOW,
    env.FETCH_MAX_REQUESTS,
    { message: 'Too many file list requests.' },
);
