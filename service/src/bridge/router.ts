import { timingSafeEqual } from 'crypto';

import { Router } from 'express';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { BridgeWorkerRegistration } from '../../../packages/code/src/protocol';
import type { CodeBridgeAssignment, CodeBridgeSettlement } from './store';

import {
  BRIDGE_PROTOCOL_VERSION,
  isValidBridgeWorkerId,
} from '../../../packages/code/src/protocol';
import { connection } from '../queue';
import { env } from '../config';
import { BridgeStoreError, RedisBridgeStore } from './store';

const INCARNATION_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const MAX_LEASE_WAIT_MS = 30_000;

export const bridgeStore = new RedisBridgeStore(connection);

function sameToken(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function bridgeAuth(req: Request, res: Response, next: NextFunction): void {
  if (!env.BRIDGE_TOKEN) {
    res.status(503).json({ error: 'Code bridge is not configured' });
    return;
  }
  const token =
    req
      .header('Authorization')
      ?.match(/^Bearer\s+(.+)$/i)?.[1]
      ?.trim() ?? '';
  if (!token || !sameToken(token, env.BRIDGE_TOKEN)) {
    res.status(401).json({ error: 'Invalid code bridge worker token' });
    return;
  }
  next();
}

function validWorkerId(value: string): boolean {
  return isValidBridgeWorkerId(value);
}

function validIncarnationId(value: unknown): value is string {
  return typeof value === 'string' && INCARNATION_ID_PATTERN.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asyncRoute(
  handler: (req: Request, res: Response) => Promise<void>,
): RequestHandler {
  return (req, res, next) => {
    void handler(req, res).catch(next);
  };
}

function sendStoreError(error: BridgeStoreError, res: Response): void {
  const status =
    error.code === 'ASSIGNMENT_NOT_FOUND'
      ? 404
      : error.code === 'WORKER_BUSY'
        ? 503
        : 409;
  res.status(status).json({ error: error.message, code: error.code });
}

function isSettlement(value: unknown): value is CodeBridgeSettlement {
  if (!isRecord(value)) return false;
  if (
    value.protocolVersion !== BRIDGE_PROTOCOL_VERSION ||
    typeof value.generation !== 'number' ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 1 ||
    typeof value.leaseToken !== 'string' ||
    value.leaseToken.length < 32 ||
    !validIncarnationId(value.incarnationId)
  ) {
    return false;
  }
  if (value.status === 'rejected') {
    return typeof value.error === 'string' && value.error.length <= 4096;
  }
  return (
    value.status === 'fulfilled' &&
    typeof value.result === 'object' &&
    value.result !== null
  );
}

const router = Router();
router.use(bridgeAuth);

router.post(
  '/workers/register',
  asyncRoute(async (req, res) => {
    const registration = req.body as unknown;
    if (
      !isRecord(registration) ||
      registration.protocolVersion !== BRIDGE_PROTOCOL_VERSION ||
      typeof registration.workerId !== 'string' ||
      !validWorkerId(registration.workerId) ||
      !validIncarnationId(registration.incarnationId) ||
      !isRecord(registration.capabilities) ||
      typeof registration.capabilities.statefulWorkspace !== 'boolean' ||
      typeof registration.capabilities.sandboxProfile !== 'string' ||
      registration.capabilities.sandboxProfile.trim().length === 0 ||
      registration.capabilities.sandboxProfile.length > 128 ||
      !Array.isArray(registration.capabilities.runtimes) ||
      registration.capabilities.runtimes.length > 32 ||
      !registration.capabilities.runtimes.every(
        (runtime) =>
          typeof runtime === 'string' &&
          runtime.length > 0 &&
          runtime.length <= 64,
      ) ||
      (registration.capabilities.policyDigest !== undefined &&
        (typeof registration.capabilities.policyDigest !== 'string' ||
          !/^[a-f0-9]{64}$/.test(registration.capabilities.policyDigest)))
    ) {
      res.status(400).json({ error: 'Invalid bridge worker registration' });
      return;
    }
    if (
      env.BRIDGE_WORKER_ID &&
      registration.workerId !== env.BRIDGE_WORKER_ID
    ) {
      res.status(403).json({
        error: 'Worker is not authorized for this Code API deployment',
      });
      return;
    }
    try {
      await bridgeStore.register(
        registration as unknown as BridgeWorkerRegistration,
      );
    } catch (error) {
      if (error instanceof BridgeStoreError) {
        sendStoreError(error, res);
        return;
      }
      throw error;
    }
    res.json({
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      workerId: registration.workerId,
      incarnationId: registration.incarnationId,
      registeredAt: new Date().toISOString(),
      leaseTtlMs: 60_000,
    });
  }),
);

router.post(
  '/workers/:workerId/workspaces/reset',
  asyncRoute(async (req, res) => {
    const workerId = req.params.workerId;
    const body = isRecord(req.body) ? req.body : {};
    if (
      !validWorkerId(workerId) ||
      body.protocolVersion !== BRIDGE_PROTOCOL_VERSION ||
      !validIncarnationId(body.incarnationId) ||
      typeof body.runtimeSessionId !== 'string' ||
      body.runtimeSessionId.trim().length === 0 ||
      body.runtimeSessionId.length > 512 ||
      body.confirmDiscarded !== true
    ) {
      res.status(400).json({
        error: 'Workspace reset requires confirmation of local discard',
      });
      return;
    }
    if (env.BRIDGE_WORKER_ID && workerId !== env.BRIDGE_WORKER_ID) {
      res.status(403).json({
        error: 'Worker is not authorized for this Code API deployment',
      });
      return;
    }
    try {
      await bridgeStore.resetWorkspace(
        workerId,
        body.incarnationId,
        body.runtimeSessionId,
      );
      res.json({ protocolVersion: BRIDGE_PROTOCOL_VERSION, reset: true });
    } catch (error) {
      if (error instanceof BridgeStoreError) {
        sendStoreError(error, res);
        return;
      }
      throw error;
    }
  }),
);

router.post(
  '/workers/:workerId/lease',
  asyncRoute(async (req, res) => {
    const requestStartedAtMs = Date.now();
    const workerId = req.params.workerId;
    const body = isRecord(req.body) ? req.body : {};
    const requestedWait = Number(body.waitMs ?? 25_000);
    if (
      !validWorkerId(workerId) ||
      body.protocolVersion !== BRIDGE_PROTOCOL_VERSION ||
      !validIncarnationId(body.incarnationId) ||
      !Number.isFinite(requestedWait) ||
      requestedWait < 0
    ) {
      res.status(400).json({ error: 'Invalid bridge lease request' });
      return;
    }
    if (env.BRIDGE_WORKER_ID && workerId !== env.BRIDGE_WORKER_ID) {
      res.status(403).json({
        error: 'Worker is not authorized for this Code API deployment',
      });
      return;
    }
    try {
      const leaseController = new AbortController();
      const abortLease = (): void => leaseController.abort();
      req.once('aborted', abortLease);
      res.once('close', abortLease);
      let assignment: CodeBridgeAssignment | undefined;
      try {
        assignment = await bridgeStore.lease(
          workerId,
          body.incarnationId,
          Math.min(requestedWait, MAX_LEASE_WAIT_MS),
          leaseController.signal,
        );
        if (leaseController.signal.aborted) {
          if (assignment != null) await bridgeStore.returnLease(assignment);
          return;
        }
        res.json({
          protocolVersion: BRIDGE_PROTOCOL_VERSION,
          serverElapsedMs: Math.max(0, Date.now() - requestStartedAtMs),
          assignment,
        });
      } finally {
        req.off('aborted', abortLease);
        res.off('close', abortLease);
      }
    } catch (error) {
      if (error instanceof BridgeStoreError) {
        sendStoreError(error, res);
        return;
      }
      throw error;
    }
  }),
);

router.post(
  '/workers/:workerId/assignments/:assignmentId/ack',
  asyncRoute(async (req, res) => {
    const body = isRecord(req.body) ? req.body : {};
    if (
      body.protocolVersion !== BRIDGE_PROTOCOL_VERSION ||
      !validIncarnationId(body.incarnationId) ||
      !Number.isSafeInteger(body.generation) ||
      Number(body.generation) < 1 ||
      typeof body.leaseToken !== 'string' ||
      body.leaseToken.length < 32
    ) {
      res.status(400).json({ error: 'Invalid bridge lease acknowledgement' });
      return;
    }
    try {
      await bridgeStore.acknowledgeLease(
        req.params.workerId,
        body.incarnationId,
        req.params.assignmentId,
        Number(body.generation),
        body.leaseToken,
      );
      res.json({ protocolVersion: BRIDGE_PROTOCOL_VERSION, accepted: true });
    } catch (error) {
      if (error instanceof BridgeStoreError) {
        sendStoreError(error, res);
        return;
      }
      throw error;
    }
  }),
);

router.post(
  '/workers/:workerId/assignments/:assignmentId/settle',
  asyncRoute(async (req, res) => {
    const settlement = req.body as unknown;
    if (!isSettlement(settlement)) {
      res.status(400).json({ error: 'Invalid bridge settlement' });
      return;
    }
    try {
      await bridgeStore.settle(
        req.params.workerId,
        req.params.assignmentId,
        settlement,
      );
      res.json({
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        accepted: true,
      });
    } catch (error) {
      if (error instanceof BridgeStoreError) {
        sendStoreError(error, res);
        return;
      }
      throw error;
    }
  }),
);

router.post(
  '/workers/:workerId/assignments/:assignmentId/cancellation',
  asyncRoute(async (req, res) => {
    const body = isRecord(req.body) ? req.body : {};
    if (
      body.protocolVersion !== BRIDGE_PROTOCOL_VERSION ||
      !validIncarnationId(body.incarnationId)
    ) {
      res.status(400).json({ error: 'Invalid bridge cancellation request' });
      return;
    }
    const cancellationController = new AbortController();
    const abortCancellation = (): void => cancellationController.abort();
    req.once('aborted', abortCancellation);
    res.once('close', abortCancellation);
    try {
      const cancelled = await bridgeStore.cancelled(
        req.params.workerId,
        body.incarnationId,
        req.params.assignmentId,
        cancellationController.signal,
      );
      if (!cancellationController.signal.aborted) {
        res.json({ protocolVersion: BRIDGE_PROTOCOL_VERSION, cancelled });
      }
    } finally {
      req.off('aborted', abortCancellation);
      res.off('close', abortCancellation);
    }
  }),
);

export default router;
