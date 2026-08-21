import type { Request, Response, NextFunction } from 'express';
import { httpLatencyElapsedSeconds, httpLatencyStartMs, recordHttpRequest } from '../metrics';

function expressRouteLabel(req: Request): string {
  if (req.route?.path != null) {
    return `${req.baseUrl ?? ''}${req.route.path}`;
  }
  return 'unmatched';
}

export function httpMetricPath(req: Request, res: Response): string {
  const override = res.locals?.codeapiMetricPath;
  return typeof override === 'string' && override.length > 0 ? override : req.path;
}

export function httpMetricsMiddleware(req: Request, res: Response, next: NextFunction): void {
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
      rawPath: httpMetricPath(req, res),
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
