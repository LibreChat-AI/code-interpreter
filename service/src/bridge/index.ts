import { connection } from '../queue';
import { env } from '../config';
import { RedisBridgePairingStore } from './pairing';
import { createBridgeRouter } from './router';
import { RedisBridgeStore } from './store';

export const bridgeStore = new RedisBridgeStore(connection);
export const bridgePairings = new RedisBridgePairingStore(connection);

export default createBridgeRouter({
  store: bridgeStore,
  pairings: bridgePairings,
  authMode: env.BRIDGE_AUTH_MODE,
  adminToken: env.BRIDGE_TOKEN,
  configuredWorkerId: env.BRIDGE_WORKER_ID,
});
