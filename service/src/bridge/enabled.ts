import { env } from '../config';

/** API-only deployments can serve bridges without selecting that worker backend. */
export function isBridgeEnabled(): boolean {
  return env.SANDBOX_BACKEND === 'remote-bridge'
    || env.BRIDGE_AUTH_MODE === 'paired'
    || env.BRIDGE_DYNAMIC_WORKERS
    || env.BRIDGE_TOKEN.length > 0;
}
