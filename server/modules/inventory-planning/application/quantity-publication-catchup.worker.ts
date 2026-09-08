import type { QuantityPublicationCatchupService } from "./quantity-publication-admission.port";

const DEFAULT_INTERVAL_MS = 15_000;
const STARTUP_DELAY_MS = 5_000;
const MAX_INTERVAL_MS = 3_600_000;
type Processor = Pick<QuantityPublicationCatchupService, "processDue">;
type Log = (entry: Readonly<Record<string, unknown>>) => void;

/** One finite batch at a time. Shutdown prevents new work and awaits the owned
 * batch; it does not interrupt an HTTP request whose outcome must be journaled. */
export function startQuantityPublicationCatchupWorker(processor: Processor, options: {
  intervalMs?: number;
  log?: Log;
} = {}): { stop(): Promise<void> } {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1 || intervalMs > MAX_INTERVAL_MS) {
    throw new Error("Quantity publication catch-up interval is outside the supported range.");
  }
  const log: Log = options.log ?? (entry => console.info(JSON.stringify(entry)));
  let stopped = false;
  let running: Promise<void> | null = null;
  const tick = (): void => {
    if (stopped || running) return;
    running = (async () => {
      try {
        const result = await processor.processDue();
        if (result.completed > 0 || result.failed > 0) log({ event: "quantity_publication_catchup_batch", ...result });
      } catch {
        // Per-scope failures are retained by the owner; infrastructure failure is
        // actionable without exposing provider payloads or credentials in logs.
        log({ event: "quantity_publication_catchup_failed", code: "PUBLICATION_CATCHUP_WORKER_FAILED" });
      }
    })().finally(() => { running = null; });
  };
  const startup = setTimeout(tick, Math.min(intervalMs, STARTUP_DELAY_MS));
  const interval = setInterval(tick, intervalMs);
  return { async stop() {
    stopped = true;
    clearTimeout(startup);
    clearInterval(interval);
    await running;
  } };
}
