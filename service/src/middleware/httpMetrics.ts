import type { Request, Response, NextFunction } from 'express';
import {
    httpLatencyElapsedSeconds,
    httpLatencyStartMs,
    recordHttpRequest,
} from '../metrics';

function expressRouteLabel(req: Request): string {
    if (req.route?.path != null) {
        return `${req.baseUrl ?? ''}${req.route.path}`;
    }
    return 'unmatched';
}

export function httpMetricsMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
): void {
    const start = httpLatencyStartMs();
    let recorded = false;

    const recordOnce = (statusCode: number): void => {
        if (recorded) {
            return;
        }
        recorded = true;

        const durationSeconds = httpLatencyElapsedSeconds(start);
        recordHttpRequest({
            method: req.method,
            route: expressRouteLabel(req),
            rawPath: req.path,
            statusCode,
            durationSeconds,
        });
    };

    res.once('finish', () => {
        recordOnce(res.statusCode);
    });

    req.once('aborted', () => {
        recordOnce(499);
    });

    res.once('close', () => {
        if (!res.writableEnded) {
            recordOnce(499);
        }
    });
    next();
}
