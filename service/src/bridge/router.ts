import { timingSafeEqual } from 'crypto';

import { Router } from 'express';

import type { NextFunction, Request, Response } from 'express';
import type { BridgeWorkerRegistration } from '../../../packages/code/src/protocol';
import type { BridgeWorkerBinding, BridgePrincipalType } from './pairing';
import type { CodeBridgeSettlement } from './store';

import { BRIDGE_PROTOCOL_VERSION } from '../../../packages/code/src/protocol';
import { BridgePairingError, RedisBridgePairingStore } from './pairing';
import { BRIDGE_WORKER_ID_PATTERN } from './selection';
import { BridgeStoreError, RedisBridgeStore } from './store';

const INCARNATION_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const MAX_LEASE_WAIT_MS = 30_000;
const BRIDGE_BINDING_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PRINCIPAL_TYPES = new Set<BridgePrincipalType>([
  'deployment',
  'tenant',
  'user',
  'role',
  'group',
]);

export type BridgeAuthMode = 'static' | 'paired';

export interface BridgeRouterOptions {
  store: RedisBridgeStore;
  pairings: RedisBridgePairingStore;
  authMode: BridgeAuthMode;
  adminToken: string;
  configuredWorkerId?: string;
  allowDynamicWorkers?: boolean;
}

function sameToken(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function validWorkerId(value: string): boolean {
  return BRIDGE_WORKER_ID_PATTERN.test(value);
}

function validIncarnationId(value: unknown): value is string {
  return typeof value === 'string' && INCARNATION_ID_PATTERN.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseBinding(value: unknown): BridgeWorkerBinding | undefined {
  if (!isRecord(value) || !isRecord(value.principal)) return undefined;
  const { tenantId, principal } = value;
  if (
    typeof tenantId !== 'string' ||
    !BRIDGE_BINDING_ID_PATTERN.test(tenantId) ||
    typeof principal.type !== 'string' ||
    !PRINCIPAL_TYPES.has(principal.type as BridgePrincipalType) ||
    typeof principal.id !== 'string' ||
    !BRIDGE_BINDING_ID_PATTERN.test(principal.id)
  ) {
    return undefined;
  }
  return {
    tenantId,
    principal: {
      type: principal.type as BridgePrincipalType,
      id: principal.id,
    },
  };
}

function sendStoreError(error: BridgeStoreError, res: Response): void {
  let status = 409;
  if (error.code === 'ASSIGNMENT_NOT_FOUND') status = 404;
  if (error.code === 'WORKER_UNAUTHORIZED') status = 403;
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

export function createBridgeRouter(options: BridgeRouterOptions): Router {
  const router = Router();

  const configuredWorker = (workerId: string): boolean =>
    options.allowDynamicWorkers === true ||
    workerId === options.configuredWorkerId;

  const bearerToken = (req: Request): string =>
    req
      .header('Authorization')
      ?.match(/^Bearer\s+(.+)$/i)?.[1]
      ?.trim() ?? '';

  const adminAuth = (
    req: Request,
    res: Response,
    next: NextFunction,
  ): void => {
    if (!options.adminToken) {
      res.status(503).json({ error: 'Code bridge is not configured' });
      return;
    }
    const token = bearerToken(req);
    if (!token || !sameToken(token, options.adminToken)) {
      res.status(401).json({ error: 'Invalid code bridge administrator token' });
      return;
    }
    next();
  };

  const staticWorkerAuth = (
    req: Request,
    res: Response,
    next: NextFunction,
  ): void => {
    const token = bearerToken(req);
    if (!token || !sameToken(token, options.adminToken)) {
      res.status(401).json({ error: 'Invalid code bridge worker token' });
      return;
    }
    next();
  };

  const pairedWorkerAuth = (
    req: Request,
    res: Response,
    next: NextFunction,
  ): void => {
    const workerId =
      req.params.workerId ||
      (isRecord(req.body) && typeof req.body.workerId === 'string'
        ? req.body.workerId
        : '');
    const credential =
      req
        .header('Authorization')
        ?.match(/^Bridge\s+(.+)$/i)?.[1]
        ?.trim() ?? '';
    const timestamp = req.header('X-LibreChat-Code-Timestamp') ?? '';
    const nonce = req.header('X-LibreChat-Code-Nonce') ?? '';
    const signature = req.header('X-LibreChat-Code-Signature') ?? '';
    if (
      !validWorkerId(workerId) ||
      !credential ||
      !timestamp ||
      !nonce ||
      !signature
    ) {
      res.status(401).json({ error: 'Invalid paired worker authorization' });
      return;
    }
    void options.pairings
      .authorize({
        workerId,
        credential,
        method: req.method,
        path: req.originalUrl.split('?')[0],
        timestamp,
        nonce,
        body: JSON.stringify(req.body ?? {}),
        signature,
      })
      .then((authorization) => {
        res.locals.bridgeWorkerAuthorization = authorization;
        next();
      })
      .catch((error: unknown) => {
        if (error instanceof BridgePairingError) {
          res.status(401).json({ error: error.message, code: error.code });
          return;
        }
        next(error);
      });
  };

  const workerAuth =
    options.authMode === 'paired' ? pairedWorkerAuth : staticWorkerAuth;

  router.post('/pairings', adminAuth, async (req: Request, res: Response) => {
    if (options.authMode !== 'paired') {
      res.status(409).json({ error: 'Paired worker authentication is disabled' });
      return;
    }
    const workerId = isRecord(req.body) ? req.body.workerId : undefined;
    if (
      typeof workerId !== 'string' ||
      !validWorkerId(workerId) ||
      !configuredWorker(workerId)
    ) {
      res.status(400).json({ error: 'Invalid bridge worker ID' });
      return;
    }
    const hasBinding = isRecord(req.body) &&
      Object.prototype.hasOwnProperty.call(req.body, 'binding');
    const binding = isRecord(req.body) ? parseBinding(req.body.binding) : undefined;
    if (hasBinding && binding == null) {
      res.status(400).json({ error: 'Invalid bridge worker principal binding' });
      return;
    }
    if (options.allowDynamicWorkers === true && binding == null) {
      res.status(400).json({ error: 'Dynamic bridge workers require a valid principal binding' });
      return;
    }
    const pairing = await options.pairings.issue(workerId, binding);
    res.json({ protocolVersion: BRIDGE_PROTOCOL_VERSION, ...pairing });
  });

  router.post('/pairings/redeem', async (req: Request, res: Response) => {
    if (options.authMode !== 'paired') {
      res.status(409).json({ error: 'Paired worker authentication is disabled' });
      return;
    }
    const redemption = req.body as unknown;
    if (
      !isRecord(redemption) ||
      redemption.protocolVersion !== BRIDGE_PROTOCOL_VERSION ||
      typeof redemption.workerId !== 'string' ||
      !validWorkerId(redemption.workerId) ||
      !configuredWorker(redemption.workerId) ||
      typeof redemption.code !== 'string' ||
      redemption.code.length < 16 ||
      typeof redemption.publicKey !== 'string' ||
      redemption.publicKey.length > 4096
    ) {
      res.status(400).json({ error: 'Invalid bridge pairing redemption' });
      return;
    }
    try {
      const credential = await options.pairings.redeem({
        workerId: redemption.workerId,
        code: redemption.code,
        publicKey: redemption.publicKey,
      });
      res.json({ protocolVersion: BRIDGE_PROTOCOL_VERSION, ...credential });
    } catch (error) {
      if (error instanceof BridgePairingError) {
        const status = error.code === 'PUBLIC_KEY_INVALID' ? 400 : 401;
        res.status(status).json({ error: error.message, code: error.code });
        return;
      }
      throw error;
    }
  });

  router.post(
    '/workers/:workerId/revoke',
    adminAuth,
    async (req: Request, res: Response) => {
      if (
        !validWorkerId(req.params.workerId) ||
        !configuredWorker(req.params.workerId)
      ) {
        res.status(400).json({ error: 'Invalid bridge worker ID' });
        return;
      }
      await options.pairings.revoke(req.params.workerId);
      res.json({ protocolVersion: BRIDGE_PROTOCOL_VERSION, revoked: true });
    },
  );

  router.post(
    '/workers/:workerId/credentials/refresh',
    workerAuth,
    async (req: Request, res: Response) => {
      try {
        const credential = await options.pairings.rotate(
          req.params.workerId,
          (
            res.locals.bridgeWorkerAuthorization as
              | { credentialId: string }
              | undefined
          )?.credentialId,
        );
        res.json({ protocolVersion: BRIDGE_PROTOCOL_VERSION, ...credential });
      } catch (error) {
        if (error instanceof BridgePairingError) {
          res.status(401).json({ error: error.message, code: error.code });
          return;
        }
        throw error;
      }
    },
  );

  router.post(
    '/workers/register',
    workerAuth,
    async (req: Request, res: Response) => {
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
      if (!configuredWorker(registration.workerId)) {
        res.status(403).json({
          error: 'Worker is not authorized for this Code API deployment',
        });
        return;
      }
      const authorization = res.locals.bridgeWorkerAuthorization as
        | {
            workerId: string;
            credentialId: string;
            activeCredentialId: string;
            identityId?: string;
            binding?: BridgeWorkerBinding;
          }
        | undefined;
      const capabilities = registration.capabilities;
      const trustedRegistration: BridgeWorkerRegistration = {
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        workerId: registration.workerId,
        incarnationId: registration.incarnationId,
        capabilities: {
          statefulWorkspace: capabilities.statefulWorkspace as boolean,
          sandboxProfile: capabilities.sandboxProfile as string,
          runtimes: capabilities.runtimes as string[],
          ...(typeof capabilities.policyDigest === 'string'
            ? { policyDigest: capabilities.policyDigest }
            : {}),
        },
      };
      try {
        await options.store.register({
          ...trustedRegistration,
          ...(authorization?.credentialId != null
            ? { credentialId: authorization.credentialId }
            : {}),
          ...(authorization?.identityId != null
            ? { identityId: authorization.identityId }
            : {}),
          ...(authorization?.binding != null
            ? { binding: authorization.binding }
            : {}),
        }, authorization?.activeCredentialId);
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
    },
  );

  router.post(
    '/workers/:workerId/lease',
    workerAuth,
    async (req: Request, res: Response) => {
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
      if (!configuredWorker(workerId)) {
        res.status(403).json({
          error: 'Worker is not authorized for this Code API deployment',
        });
        return;
      }
      try {
        const assignment = await options.store.lease(
          workerId,
          body.incarnationId,
          Math.min(requestedWait, MAX_LEASE_WAIT_MS),
          undefined,
          (
            res.locals.bridgeWorkerAuthorization as
              | { identityId: string }
              | undefined
          )?.identityId,
        );
        res.json({ protocolVersion: BRIDGE_PROTOCOL_VERSION, assignment });
      } catch (error) {
        if (error instanceof BridgeStoreError) {
          sendStoreError(error, res);
          return;
        }
        throw error;
      }
    },
  );

  router.post(
    '/workers/:workerId/assignments/:assignmentId/settle',
    workerAuth,
    async (req: Request, res: Response) => {
      const settlement = req.body as unknown;
      if (!isSettlement(settlement)) {
        res.status(400).json({ error: 'Invalid bridge settlement' });
        return;
      }
      try {
        await options.store.settle(
          req.params.workerId,
          req.params.assignmentId,
          settlement,
          (
            res.locals.bridgeWorkerAuthorization as
              | { identityId: string }
              | undefined
          )?.identityId,
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
    },
  );

  router.post(
    '/workers/:workerId/assignments/:assignmentId/cancellation',
    workerAuth,
    async (req: Request, res: Response) => {
      const body = isRecord(req.body) ? req.body : {};
      if (
        body.protocolVersion !== BRIDGE_PROTOCOL_VERSION ||
        !validIncarnationId(body.incarnationId)
      ) {
        res.status(400).json({ error: 'Invalid bridge cancellation request' });
        return;
      }
      const cancelled = await options.store.cancelled(
        req.params.workerId,
        body.incarnationId,
        req.params.assignmentId,
      );
      res.json({ protocolVersion: BRIDGE_PROTOCOL_VERSION, cancelled });
    },
  );

  return router;
}
