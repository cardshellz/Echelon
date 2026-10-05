const FOLLOWUP_INTERVAL_MS = 15_000;
export function startPickingFollowupWorker(service: {
  recoverPendingPickingCommands(): Promise<void>;
  recoverReplenishmentFollowups(): Promise<void>;
  recoverInventoryTransfers(): Promise<void>;
}): { stop(): void } {
  let running = false;
  let stopped = false;
  const run = async () => {
    if (running || stopped) return;
    running = true;
    try {
      for (const operation of [
        "recoverPendingPickingCommands",
        "recoverReplenishmentFollowups",
        "recoverInventoryTransfers",
      ] as const) {
        try {
          await service[operation]();
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
