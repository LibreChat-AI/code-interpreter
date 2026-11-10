import express, { type Request, type Response, type RequestHandler } from 'express';
import { createPublicKey, verify } from 'node:crypto';
import { MAX_RUNNER_DRAIN_RETRY_DELAY_MS, RUNNER_DRAIN_MESSAGE } from '../../../shared/drain-contract';
import { config } from '../config';
import { logger } from '../logger';
import {
  sandboxDrainSnapshot,
  admitSandboxExecution,
  drainSandbox,
} from '../drain';
import { checkSandboxWorkspaceHealth } from '../workspace-isolation';

const router = express.Router();

export function validateDrainConfiguration(): void {
  if (!config.graceful_drain_enabled) return;
  if (config.drain_min_delay_ms > config.drain_timeout_ms || config.drain_timeout_ms > 2_147_483_647) {
    throw new Error('Drain timeout must cover propagation and fit the runtime timer bound');
  }
  if (config.drain_min_delay_ms > MAX_RUNNER_DRAIN_RETRY_DELAY_MS
    || config.drain_retry_after_seconds * 1000 > MAX_RUNNER_DRAIN_RETRY_DELAY_MS) {
    throw new Error('Drain propagation and retry delays must not exceed the 5-second transport retry bound');
  }
  const key = createPublicKey({ key: Buffer.from(config.drain_public_key, 'base64'), format: 'der', type: 'spki' });
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Drain requires an Ed25519 public verifier');
}

/** Count uploads before the parser runs, and hold admission through handler cleanup.
 * A disconnect during execution is not a release: the job may still have side effects. */
export function withSandboxDrain(
  parse: RequestHandler,
  handler: (req: Request, res: Response) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    const release = admitSandboxExecution();
    if (!release) {
      res.set('Retry-After', String(Math.max(config.drain_retry_after_seconds, Math.ceil(config.drain_min_delay_ms / 1000))));
      // A pooled connection stays pinned to this pod after Service endpoint removal.
      res.set('Connection', 'close');
      res.status(503).json({
        error: 'runner_draining',
        message: 'Sandbox runner is draining for shutdown',
      });
      return;
    }
    let uploadAborted = false;
    let handlerComplete = false;
    let responseComplete = res.writableFinished || res.destroyed;
    const maybeRelease = (): void => {
      if (!handlerComplete || !responseComplete) return;
      res.removeListener('finish', settledResponse);
      res.removeListener('close', settledResponse);
      release();
    };
    const settledResponse = (): void => {
      responseComplete = true;
      maybeRelease();
    };
    res.once('finish', settledResponse);
    res.once('close', settledResponse);
    const abortUpload = (): void => {
      uploadAborted = true;
      handlerComplete = true;
      responseComplete = true;
      maybeRelease();
    };
    req.once('aborted', abortUpload);
    const parsed = (error?: unknown): void => {
      req.removeListener('aborted', abortUpload);
      if (error || uploadAborted) {
        handlerComplete = true;
        if (error) next(error);
        maybeRelease();
        return;
      }
      Promise.resolve().then(() => handler(req, res)).catch(next).finally(() => {
        handlerComplete = true;
        maybeRelease();
      });
    };
    try {
      parse(req, res, parsed);
    } catch (error) {
      parsed(error);
    }
  };
}

router.get('/ready', async (_req: Request, res: Response) => {
  const snapshot = sandboxDrainSnapshot();
  if (snapshot.draining) {
    return res.status(503).json({ status: 'draining', activeExecutions: snapshot.activeExecutions });
  }

  try {
    const health = await checkSandboxWorkspaceHealth();
    const current = sandboxDrainSnapshot();
    if (current.draining) {
      return res.status(503).json({ status: 'draining', activeExecutions: current.activeExecutions });
    }
    return res.status(200).json(health);
  } catch (error) {
    logger.error({ err: error }, 'Sandbox workspace readiness check failed');
    return res.status(503).json({
      status: 'unhealthy',
      error: 'workspace_unavailable',
      message: 'Sandbox workspace root is unavailable',
    });
  }
});

const drainHandler = async (_req: Request, res: Response): Promise<Response> => {
  if (!config.graceful_drain_enabled) {
    return res.status(404).json({ message: 'Not Found' });
  }
  try {
    const signature = _req.get('X-CodeAPI-Drain-Signature') ?? '';
    if (!/^[A-Za-z0-9+/]{86}==$/.test(signature)
      || !verify(null, Buffer.from(RUNNER_DRAIN_MESSAGE),
        createPublicKey({ key: Buffer.from(config.drain_public_key, 'base64'), format: 'der', type: 'spki' }),
        Buffer.from(signature, 'base64'))) {
      return res.status(403).json({ message: 'Invalid drain signature' });
    }
  } catch {
    return res.status(403).json({ message: 'Invalid drain signature' });
  }
  const result = await drainSandbox(config.drain_timeout_ms, config.drain_min_delay_ms);

  if (!result.drained) {
    logger.warn(
      { activeExecutions: result.activeExecutions, timeoutMillis: config.drain_timeout_ms },
      'Sandbox drain timed out with executions still active',
    );
  } else {
    logger.info('Sandbox drain completed');
  }

  return res.status(200).json({
    status: result.drained ? 'drained' : 'drain_timeout',
    activeExecutions: result.activeExecutions,
  });
};

// Only the host has the per-pod private key; the guest receives a public verifier.
router.post('/drain', drainHandler);

export default router;
