import { startNonOverlappingScheduler } from "../../../infrastructure/non-overlapping-scheduler";
import { withAdvisoryLock } from "../../../infrastructure/scheduler-lock";
import { logger } from "../../../platform/observability/logger";
import { PRODUCT_SYNC_WORKFLOW_LIMITS } from "../domain/product-sync-workflow";
import type { ProductSyncWorkflowService } from "../application/product-sync-workflow.service";
import { STOCK_LINK_LOCK_ID } from "./stock-link-runner";

/** Shares the stock-link engine's cluster lock: manual and background checks
 * retain one provider/fence budget. Durable row leases also fence restart recovery. */
export function startProductSyncWorkflowRunner(service: Pick<ProductSyncWorkflowService, "tick">) {
  return startNonOverlappingScheduler({ taskName: "product-inventory-sync", initialDelayMs: PRODUCT_SYNC_WORKFLOW_LIMITS.pollMs,
    intervalMs: PRODUCT_SYNC_WORKFLOW_LIMITS.pollMs,
    run: async () => { await withAdvisoryLock(STOCK_LINK_LOCK_ID, () => service.tick()); },
    logger: { error: payload => logger.error("inventory_product_sync_runner", {
      outcome: "failed", error_code: payload.code, context: payload.context }) },
  });
}
