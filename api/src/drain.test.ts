import { afterEach, describe, expect, test } from 'bun:test';
import {
  admitSandboxExecution,
  drainSandbox,
  resetSandboxDrainForTests,
  sandboxDrainSnapshot,
  startSandboxDrain,
  waitForSandboxDrain,
} from './drain';

afterEach(() => resetSandboxDrainForTests());

describe('sandbox drain state', () => {
  test('preStop and signal reuse one bounded drain including after timeout', async () => {
    const release = admitSandboxExecution();
    const first = drainSandbox(5, 0);
    expect(drainSandbox(1000, 1000)).toBe(first);
    expect((await first).drained).toBe(false);
    expect(drainSandbox(1000, 1000)).toBe(first);
    release?.();
  });

  test('waits for the endpoint-removal floor even with no active work', async () => {
    let completed = false;
    const pending = drainSandbox(1000, 20).then(() => { completed = true; });
    await Bun.sleep(5);
    expect(completed).toBe(false);
    await pending;
    expect(completed).toBe(true);
  });
  test('rejects new executions once draining starts', () => {
    expect(startSandboxDrain()).toBe(true);
    expect(startSandboxDrain()).toBe(false);
    expect(admitSandboxExecution()).toBeUndefined();
    expect(sandboxDrainSnapshot()).toEqual({ draining: true, activeExecutions: 0 });
  });

  test('waits for admitted executions and releases each execution once', async () => {
    const releaseFirst = admitSandboxExecution();
    const releaseSecond = admitSandboxExecution();
    expect(releaseFirst).toBeFunction();
    expect(releaseSecond).toBeFunction();

    startSandboxDrain();
    const pending = waitForSandboxDrain(1_000);
    releaseFirst?.();
    releaseFirst?.();
    expect(sandboxDrainSnapshot().activeExecutions).toBe(1);
    releaseSecond?.();

    expect(await pending).toEqual({ draining: true, activeExecutions: 0, drained: true });
  });

  test('reports active executions when the drain times out', async () => {
    const release = admitSandboxExecution();
    startSandboxDrain();

    expect(await waitForSandboxDrain(5)).toEqual({
      draining: true,
      activeExecutions: 1,
      drained: false,
    });
    release?.();
  });
});
