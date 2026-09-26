import { connection } from '../queue';
import { env } from '../config';
import { RedisBridgePairingStore } from './pairing';
import { createBridgeRouter } from './router';
import { RedisBridgeStore } from './store';
import { isBridgeEnabled } from './enabled';

export const bridgeStore = new RedisBridgeStore(
  connection,
  undefined,
  undefined,
  env.BRIDGE_MAX_WORKSPACE_LEASE_SLOTS,
);
export const bridgePairings = new RedisBridgePairingStore(
  connection,
  undefined,
  undefined,
  undefined,
  undefined,
  env.BRIDGE_RECOVERY_SERVER_ID
    ? {
      serverId: env.BRIDGE_RECOVERY_SERVER_ID,
      enrollmentTtlSeconds: env.BRIDGE_ENROLLMENT_TTL_SECONDS,
      challengeTtlSeconds: env.BRIDGE_RECOVERY_CHALLENGE_TTL_SECONDS,
      maxChallengesPerMinute: env.BRIDGE_RECOVERY_MAX_CHALLENGES_PER_MINUTE,
      maxAttemptsPerMinute: env.BRIDGE_RECOVERY_MAX_ATTEMPTS_PER_MINUTE,
    }
    : undefined,
);

export default createBridgeRouter({
  enabled: isBridgeEnabled(),
  store: bridgeStore,
  pairings: bridgePairings,
  authMode: env.BRIDGE_AUTH_MODE,
  adminToken: env.BRIDGE_TOKEN,
  configuredWorkerId: env.BRIDGE_WORKER_ID,
  allowDynamicWorkers: env.BRIDGE_DYNAMIC_WORKERS,
  maxCommandTimeoutMs: env.JOB_TIMEOUT,
});
