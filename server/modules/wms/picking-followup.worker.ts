const FOLLOWUP_INTERVAL_MS = 15_000;
export const FOLLOWUP_OPERATION_TIMEOUT_MS = 30_000;

function withOperationTimeout(
  promise: Promise<void>,
  operation: string,
  timeoutMs: number,
): Promise<void> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  return new Promise<void>((resolve, reject) => {
    const handle = setTimeout(() => {
      reject(new Error(`Followup operation '${operation}' timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    handle.unref?.();
    promise.then(
      () => {
        clearTimeout(handle);
        resolve();
      },
      (err) => {
        clearTimeout(handle);
        reject(err);
      },
    );
  });
}

export function startPickingFollowupWorker(
  service: {
    recoverPendingPickingCommands(): Promise<void>;
    recoverReplenishmentFollowups(): Promise<void>;
    recoverInventoryTransfers(): Promise<void>;
    recoverSupplierReturns(): Promise<void>;
  },
  options?: { operationTimeoutMs?: number },
): { stop(): void } {
  let running = false;
  let stopped = false;
  const timeoutMs = options?.operationTimeoutMs ?? FOLLOWUP_OPERATION_TIMEOUT_MS;
  const run = async () => {
    if (running || stopped) return;
    running = true;
    try {
      for (const operation of [
        "recoverPendingPickingCommands",
        "recoverReplenishmentFollowups",
        "recoverInventoryTransfers",
        "recoverSupplierReturns",
      ] as const) {
        try {
          await withOperationTimeout(service[operation](), operation, timeoutMs);
        } catch (error) {
          console.error(
            JSON.stringify({
              event: "warehouse_followup_worker_failed",
              operation,
              message: error instanceof Error ? error.message : String(error),
            }),
          );
        }
      }
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => {
    void run();
  }, FOLLOWUP_INTERVAL_MS);
  timer.unref();
  void run();
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
