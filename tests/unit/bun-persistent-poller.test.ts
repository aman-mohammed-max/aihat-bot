import { describe, expect, test } from "bun:test";
import { startPersistentPoller } from "../../apps/bun-runtime/src/persistent-poller.js";

describe("persistent Bun polling worker", () => {
  test("drains the active batch on stop and does not start another batch", async () => {
    let releaseBatch: (() => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const batch = new Promise<void>((resolve) => {
      releaseBatch = resolve;
    });
    let runs = 0;

    const worker = startPersistentPoller({
      intervalMs: 2,
      run: async () => {
        runs += 1;
        markStarted?.();
        await batch;
      },
      onError: () => undefined,
    });

    await started;
    const stopped = worker.stop();
    let stopFinished = false;
    void stopped.then(() => {
      stopFinished = true;
    });

    await Bun.sleep(12);
    expect(runs).toBe(1);
    expect(stopFinished).toBe(false);

    releaseBatch?.();
    await stopped;
    await Bun.sleep(8);
    expect(stopFinished).toBe(true);
    expect(runs).toBe(1);
  });

  test("logs a failed batch and continues polling", async () => {
    let markSecondRun: (() => void) | undefined;
    const secondRun = new Promise<void>((resolve) => {
      markSecondRun = resolve;
    });
    const errors: unknown[] = [];
    let runs = 0;
    const worker = startPersistentPoller({
      intervalMs: 2,
      run: async () => {
        runs += 1;
        if (runs === 1) throw new Error("batch failure");
        markSecondRun?.();
      },
      onError: (error) => errors.push(error),
    });

    await secondRun;
    await worker.stop();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(Error);
    expect(runs).toBeGreaterThanOrEqual(2);
  });

  test("rejects timer intervals that cannot be scheduled safely", () => {
    expect(() =>
      startPersistentPoller({
        intervalMs: 0,
        run: async () => undefined,
        onError: () => undefined,
      }),
    ).toThrow(RangeError);
  });
});
