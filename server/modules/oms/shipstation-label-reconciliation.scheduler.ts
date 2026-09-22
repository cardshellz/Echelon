import type { createShipStationLabelReconciliationService } from "./shipstation-label-reconciliation.service";

const INTERVAL_MS = 5 * 60 * 1_000;
const INITIAL_DELAY_MS = 30 * 1_000;
export function startShipStationLabelReconciliationScheduler(
  service: ReturnType<typeof createShipStationLabelReconciliationService>,
  logger: Pick<Console, "info" | "error"> = console,
) {
  let running = false;
  let stopped = false;
  async function run(): Promise<void> {
    if (running || stopped) return;
    running = true;
    try {
      const result = await service.runOnce();
      if (result.outcome === "processed" || result.recovered || result.deferred || result.reviewRequired) logger.info(JSON.stringify({
        code: "SHIPSTATION_LABEL_RECONCILIATION_COMPLETED", ...result,
      }));
    } catch {
      // Provider errors may contain addresses or response bodies. The durable
      // checkpoint exposes a safe error code; never dump the raw exception.
      logger.error(JSON.stringify({ code: "SHIPSTATION_LABEL_RECONCILIATION_FAILED",
        message: "Void reconciliation failed; checkpoint retained for retry. Inspect OMS label reconciliation checkpoint." }));
    } finally { running = false; }
  }
  const initial = setTimeout(run, INITIAL_DELAY_MS);
  const timer = setInterval(run, INTERVAL_MS);
  initial.unref?.(); timer.unref?.();
  return { stop() { stopped = true; clearTimeout(initial); clearInterval(timer); } };
}
