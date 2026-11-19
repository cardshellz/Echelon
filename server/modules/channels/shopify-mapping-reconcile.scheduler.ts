import {
  registerScheduledJob,
  type RegisteredJobHandle,
} from "../../infrastructure/job-registry";

export const SHOPIFY_MAPPING_RECONCILE_LOCK_ID = 918505;

export function startShopifyMappingReconcileScheduler(deps: {
  db?: { execute: (query: any) => Promise<any> };
} = {}): RegisteredJobHandle {
  const runShopifyMappingReconcile = async (): Promise<void> => {
    try {
      const { runShopifyMappingReconciliation } = await import(
        "../../jobs/shopify-mapping-reconciliation.job"
      );
      await runShopifyMappingReconciliation();
    } catch (err: any) {
      console.warn("[mapping-reconciler] sweep error:", err?.message);
    }
  };

  return registerScheduledJob({
    name: "channels.shopify_mapping_reconcile",
    cadenceMs: 24 * 60 * 60 * 1000,
    initialDelayMs: 5 * 60 * 1000,
    advisoryLockId: SHOPIFY_MAPPING_RECONCILE_LOCK_ID,
    writableStates: [
      "channels.channel_listings",
      "warehouse.product_locations",
    ],
    deadLetterPolicy: "log_and_retry_next_tick",
    disableEnvVar: "SHOPIFY_MAPPING_RECONCILE_DISABLED",
    db: deps.db,
    gateInitialRunOnSchedule: true,
    run: runShopifyMappingReconcile,
  });
}
