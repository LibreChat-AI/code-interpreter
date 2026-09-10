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
export const bridgePairings = new RedisBridgePairingStore(connection);

export default createBridgeRouter({
  enabled: isBridgeEnabled(),
  store: bridgeStore,
  pairings: bridgePairings,
  authMode: env.BRIDGE_AUTH_MODE,
  adminToken: env.BRIDGE_TOKEN,
  configuredWorkerId: env.BRIDGE_WORKER_ID,
  allowDynamicWorkers: env.BRIDGE_DYNAMIC_WORKERS,
});
