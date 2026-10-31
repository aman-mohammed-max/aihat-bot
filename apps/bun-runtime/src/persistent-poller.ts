export interface PersistentPoller {
  stop(): Promise<void>;
}

/** Runs durable work periodically and drains the current batch during shutdown. */
export function startPersistentPoller(input: {
  readonly intervalMs: number;
  readonly run: () => Promise<unknown>;
  readonly onError: (error: unknown) => void;
}): PersistentPoller {
  if (!Number.isSafeInteger(input.intervalMs) || input.intervalMs < 1 || input.intervalMs > 2_147_483_647) {
    throw new RangeError("Poll interval must be a positive timer duration.");
  }

  let stopped = false;
  let inFlight: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;

  const timer = setInterval(() => {
    if (stopped || inFlight) return;

    const current = Promise.resolve()
      .then(() => input.run())
      .then(() => undefined)
      .catch((error: unknown) => {
        try {
          input.onError(error);
        } catch {
          // Logging must not leave the polling promise rejected.
        }
      });
    inFlight = current;
    void current.then(() => {
      if (inFlight === current) inFlight = undefined;
    });
  }, input.intervalMs);

  return {
    stop(): Promise<void> {
      if (!stopPromise) {
        stopped = true;
        clearInterval(timer);
        stopPromise = inFlight ?? Promise.resolve();
      }
      return stopPromise;
    },
  };
}
