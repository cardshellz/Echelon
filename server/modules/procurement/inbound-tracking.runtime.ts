import { pool } from "../../db";
import { schedulerIsDisabled } from "../../infrastructure/scheduler-config";
import { InboundTrackingRepository } from "./inbound-tracking.repository";
import { createInboundTrackingProviders } from "./inbound-tracking.providers";
import { InboundTrackingService } from "./inbound-tracking.service";
const logger = { info: (event: Record<string, unknown>) => console.info(JSON.stringify(event)), error: (event: Record<string, unknown>) => console.error(JSON.stringify(event)) };
let service: InboundTrackingService | undefined;
/** Reads and manual refresh must reflect the same emergency stops as polling. */
export function inboundTrackingPollingEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment.PROCUREMENT_TRACKING_POLLING_ENABLED === "true"
    && !schedulerIsDisabled("PROCUREMENT_TRACKING_DISABLED", environment);
}
export function getInboundTrackingService(): InboundTrackingService {
  return service ??= new InboundTrackingService(new InboundTrackingRepository(pool), createInboundTrackingProviders(), inboundTrackingPollingEnabled(), () => new Date(), logger);
}
export function startInboundTrackingScheduler(tracking = getInboundTrackingService()): { stop(): void } {
  let stopped = false; let running = false;
  const run = async (): Promise<void> => {
    if (running || stopped) return;
    running = true;
    try { await tracking.poll(); }
    catch { logger.error({ event: "procurement.inbound_tracking.sweep_failed", code: "TRACKING_SWEEP_FAILED", message: "Inbound tracking sweep failed; outstanding leases will be retried." }); }
    finally { running = false; }
  };
  const initial = setTimeout(run, 30_000);
  const interval = setInterval(run, 60_000);
  initial.unref(); interval.unref();
  return { stop: () => { stopped = true; clearTimeout(initial); clearInterval(interval); } };
}
