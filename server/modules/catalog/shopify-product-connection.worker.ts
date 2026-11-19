import { startNonOverlappingScheduler, type NonOverlappingSchedulerHandle } from "../../infrastructure/non-overlapping-scheduler";
import { schedulerIsDisabled } from "../../infrastructure/scheduler-config";
import type { ShopifyProductConnectionService } from "./shopify-product-connection.service";

const CONNECTION_WORKER_INTERVAL_MS = 5_000;

/** Only persisted, operator-reviewed commands are eligible. Database leases
 * coordinate dynos; the shared scheduler prevents overlapping local ticks. */
export function startShopifyProductConnectionWorker(
  service: Pick<ShopifyProductConnectionService, "processDue">,
  environment: NodeJS.ProcessEnv = process.env,
): NonOverlappingSchedulerHandle | null {
  if (schedulerIsDisabled("SHOPIFY_PRODUCT_CONNECTION_DISABLED", environment)) return null;
  return startNonOverlappingScheduler({
    taskName: "shopify-product-connections", initialDelayMs: 1_000, intervalMs: CONNECTION_WORKER_INTERVAL_MS,
    logger: { error: payload => console.error(JSON.stringify(payload)) },
    run: async () => { await service.processDue(); },
  });
}
