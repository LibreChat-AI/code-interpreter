import type { RequestHandler } from 'express';

/**
 * `/v1/health` for the API entry points, which Helm and Compose use as the
 * readiness signal. A file server on another Redis is reported the same way
 * an unreachable Redis is: 503, so the replica is not served traffic it would
 * accept and then silently mishandle.
 */
export function createHealthHandler(deps: {
  ping: () => Promise<unknown>;
  fileServerStoreMismatch: () => boolean;
  onPingError: (error: unknown) => void;
}): RequestHandler {
  return async (_req, res) => {
    if (deps.fileServerStoreMismatch()) {
      res.status(503).json({ status: 'not ready', checks: { fileServerStore: 'mismatch' } });
      return;
    }
    try {
      await deps.ping();
      res.sendStatus(200);
    } catch (error) {
      deps.onPingError(error);
      res.sendStatus(503);
    }
  };
}
