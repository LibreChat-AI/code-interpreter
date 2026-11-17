type DrainWaiter = () => void;

let draining = false;
let activeExecutions = 0;
const drainWaiters = new Set<DrainWaiter>();
let pendingDrain: Promise<SandboxDrainResult> | undefined;

export interface SandboxDrainSnapshot {
  draining: boolean;
  activeExecutions: number;
}

export interface SandboxDrainResult extends SandboxDrainSnapshot {
  drained: boolean;
}

export function startSandboxDrain(): boolean {
  if (draining) return false;
  draining = true;
  return true;
}

export function sandboxDrainSnapshot(): SandboxDrainSnapshot {
  return { draining, activeExecutions };
}

/**
 * Admits an execution synchronously so a drain cannot begin between checking
 * readiness and accounting for work. The returned release function is
 * idempotent because error paths may converge in nested finally blocks.
 */
export function admitSandboxExecution(): (() => void) | undefined {
  if (draining) return undefined;
  activeExecutions += 1;
  let released = false;

  return () => {
    if (released) return;
    released = true;
    activeExecutions = Math.max(0, activeExecutions - 1);
    if (activeExecutions === 0) {
      for (const resolve of drainWaiters) resolve();
      drainWaiters.clear();
    }
  };
}

export async function waitForSandboxDrain(timeoutMillis: number): Promise<SandboxDrainResult> {
  if (activeExecutions === 0) {
    return { ...sandboxDrainSnapshot(), drained: true };
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  let resolveWaiter: DrainWaiter | undefined;
  const drained = await new Promise<boolean>((resolve) => {
    resolveWaiter = () => resolve(true);
    drainWaiters.add(resolveWaiter);
    timeout = setTimeout(() => resolve(false), timeoutMillis);
    (timeout as { unref?: () => void }).unref?.();
  });

  if (resolveWaiter) drainWaiters.delete(resolveWaiter);
  if (timeout) clearTimeout(timeout);
  return { ...sandboxDrainSnapshot(), drained };
}

/** preStop and SIGTERM share a deadline; a timeout must not buy a second drain budget. */
export function drainSandbox(timeoutMillis: number, minDelayMillis: number): Promise<SandboxDrainResult> {
  if (!pendingDrain) {
    startSandboxDrain();
    pendingDrain = Promise.all([
      waitForSandboxDrain(timeoutMillis),
      new Promise<void>((resolve) => setTimeout(resolve, minDelayMillis)),
    ]).then(([result]) => result);
  }
  return pendingDrain;
}

export function resetSandboxDrainForTests(): void {
  draining = false;
  activeExecutions = 0;
  pendingDrain = undefined;
  for (const resolve of drainWaiters) resolve();
  drainWaiters.clear();
}
