import { registerScheduledJob } from "../../../infrastructure/job-registry";
import { getSchedulerDisableReason } from "../../../infrastructure/scheduler-config";
import {
  startInventoryPublicationSweepScheduler,
  type InventoryPublicationSweepSchedulerHandle,
} from "./inventory-publication-sweep.scheduler";
import type { SyncSettingsService } from "./sync-settings.service";
import { logger as platformLogger } from "../../../platform/observability/logger";

export const ECHELON_SYNC_SWEEP_LOCK_ID = 918501;

export interface EchelonSyncSweepDeps {
  db?: { execute: (query: any) => Promise<any> };
  syncSettings: SyncSettingsService;
  inventoryPublicationWork: {
    syncAllProducts(trigger: "scheduled_sync"): Promise<{
      skippedReason?: string | null;
      authority?: string | null;
      inventory: Array<{
        channelId: number;
        channelName: string;
        variantsPushed: number;
        variantsErrored: number;
        details?: Array<{
          sku: string | null;
          variantId: number;
          previousQty?: number | null;
          allocatedQty: number;
          status: string;
          error?: string | null;
        }>;
      }>;
    }>;
  };
  log: (message: string, source?: string) => void;
}

/**
 * Echelon Sync Scheduler (`P1.5` / `P1.7`) — periodically runs the Echelon
 * orchestrator under a cluster-wide advisory lock and registers its status in
 * the canonical Job Registry.
 */
export function startEchelonSyncScheduler(
  deps: EchelonSyncSweepDeps,
): InventoryPublicationSweepSchedulerHandle | null {
  const disableReason = getSchedulerDisableReason("ECHELON_SYNC_SCHEDULER_DISABLED");

  async function runSweep(): Promise<void> {
    const startTime = Date.now();
    try {
      const globalSettings = await deps.syncSettings.getGlobalSettings();
      if (!globalSettings.globalEnabled) {
        return;
      }

      try {
        const result = await deps.inventoryPublicationWork.syncAllProducts("scheduled_sync");
        if (result.skippedReason) {
          deps.log(`[Echelon Sync] Sweep skipped: ${result.skippedReason}`, "echelon-sync");
          await deps.syncSettings.updateLastSweep(Date.now() - startTime);
          return;
        }
        deps.log(
          result.authority === "canonical"
            ? "[Echelon Sync] Completed canonical live-target planning"
            : "[Echelon Sync] Completed exact legacy channel planning",
          "echelon-sync",
        );

        for (const inv of result.inventory) {
          for (const detail of inv.details || []) {
            await deps.syncSettings.writeSyncLog({
              channelId: inv.channelId,
              channelName: inv.channelName,
              action: "inventory_push",
              sku: detail.sku ?? undefined,
              productVariantId: detail.variantId,
              previousValue: detail.previousQty != null ? String(detail.previousQty) : null,
              newValue: String(detail.allocatedQty),
              status:
                detail.status === "success"
                  ? "pushed"
                  : detail.status === "dry_run"
                    ? "dry_run"
                    : detail.status === "error"
                      ? "error"
                      : "skipped",
              errorMessage: detail.error || null,
              source: "sweep",
            });
          }
        }

        const totalPushed = result.inventory.reduce((s, i) => s + i.variantsPushed, 0);
        const totalErrors = result.inventory.reduce((s, i) => s + i.variantsErrored, 0);
        deps.log(
          `[Echelon Sync] Orchestrator: ${totalPushed} pushed, ${totalErrors} errors across ${result.inventory.length} channels`,
          "echelon-sync",
        );
      } catch (err: any) {
        deps.log(`[Echelon Sync] Orchestrator error: ${err.message}`, "echelon-sync");
        await deps.syncSettings.writeSyncLog({
          channelId: null,
          channelName: "ALL",
          action: "inventory_push",
          status: "error",
          errorMessage: err.message,
          source: "sweep",
        });
      }

      const durationMs = Date.now() - startTime;
      await deps.syncSettings.updateLastSweep(durationMs);
      deps.log(`[Echelon Sync] Sweep completed in ${durationMs}ms`, "echelon-sync");
    } catch (err: any) {
      platformLogger.warn("channels.echelon_sync_sweep_scheduler", { message: "[Echelon Sync] Sweep error:", error: err?.message });
    }
  }

  const jobHandle = registerScheduledJob({
    name: "inventory.sync_sweep",
    cadenceMs: 15 * 60 * 1000,
    initialDelayMs: 60 * 1000,
    advisoryLockId: ECHELON_SYNC_SWEEP_LOCK_ID,
    writableStates: [
      "inventory.inventory_publication_outbox",
      "channels.sync_log",
      "channels.sync_settings.last_sweep_at",
    ],
    deadLetterPolicy: "sync_log",
    disableEnvVar: "ECHELON_SYNC_SCHEDULER_DISABLED",
    db: deps.db,
    autoStartLoop: false,
    run: runSweep,
  });

  if (disableReason) {
    deps.log(`Echelon sync scheduler disabled (${disableReason})`, "echelon-sync");
    return null;
  }

  return startInventoryPublicationSweepScheduler({
    readControl: () => deps.syncSettings.getGlobalSettings(),
    runSweep: async () => {
      await jobHandle.runOnceLocked();
    },
    logger: {
      info: (message) => deps.log(`[Echelon Sync] ${message}`, "echelon-sync"),
      error: (message) => platformLogger.warn("channels.echelon_sync_sweep_scheduler", { message: `[Echelon Sync] ${message}` }),
    },
  });
}
