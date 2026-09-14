import type { Response } from 'express';
import type { AuthenticatedRequest } from './types';
import { CLIENT_DISCONNECT_REASON } from './job-cancellation';

export interface RequestDisconnectObserver {
  signal: AbortSignal;
  isDisconnected(): boolean;
  dispose(): void;
}

/**
 * Observe a genuinely abandoned HTTP response across Node and Bun.
 *
 * Bun may mark the consumed IncomingMessage stream as `destroyed` while the
 * response remains healthy, so request stream destruction is deliberately not
 * treated as a disconnect. Express' `aborted` event and ServerResponse's
 * pre-finish `close` event are the portable abandonment signals.
 */
export function observeRequestDisconnect(
  req: AuthenticatedRequest,
  res: Response,
): RequestDisconnectObserver {
  const controller = new AbortController();
  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    req.removeListener('aborted', disconnect);
    res.removeListener('close', disconnect);
    res.removeListener('finish', dispose);
  };
  const disconnect = (): void => {
    if (!res.writableFinished && !controller.signal.aborted) {
      controller.abort(CLIENT_DISCONNECT_REASON);
    }
    dispose();
  };

  req.once('aborted', disconnect);
  res.once('close', disconnect);
  res.once('finish', dispose);
  if (req.aborted || res.destroyed) disconnect();

  return {
    signal: controller.signal,
    isDisconnected: () => controller.signal.aborted,
    dispose,
  };
}
