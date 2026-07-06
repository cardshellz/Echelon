/**
 * Manual sync runner — makes "Run Now" asynchronous.
 *
 * WHY: POST /api/sync/trigger used to run the whole sweep inside the request.
 * A full sweep regularly exceeds Heroku's 30s router limit, so the browser
 * got an H12/503 while the sweep kept running server-side — the button looked
 * broken even when the sync succeeded. Now the route starts the sweep in the
 * background and answers 202 immediately; progress lands in the sync log and
 * the "Last sweep" timestamp exactly as before, and GET
 * /api/sync/trigger/status reports in-flight state.
 *
 * Overlap guard: one manual sweep at a time per process (409 on the second
 * click). The scheduled sweep is a separate concern and unchanged.
 */

import type { SyncLogWriteParams } from "./sync-settings.service";

export interface ManualSyncServices {
  echelonOrchestrator: {
    runFullSync(config: { dryRun: boolean }): Promise<{ inventory: any[] }>;
  };
  syncSettings: {
    writeSyncLog(entry: SyncLogWriteParams): Promise<unknown>;
    updateLastSweep(durationMs: number): Promise<unknown>;
  };
}

export interface ManualSyncStatus {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  lastResult: {
    channels: number;
    pushed: number;
    errors: number;
    durationMs: number;
  } | null;
  lastError: string | null;
}

export interface ManualSyncRunner {
  /** Start a sweep in the background. Returns whether one was started. */
  trigger(services: ManualSyncServices): "started" | "already_running";
  getStatus(): ManualSyncStatus;
  /** Resolves when the in-flight sweep (if any) settles — for tests. */
  whenIdle(): Promise<void>;
}

export function createManualSyncRunner(clock: () => number = Date.now): ManualSyncRunner {
  const status: ManualSyncStatus = {
    running: false,
    startedAt: null,
    finishedAt: null,
    lastResult: null,
    lastError: null,
  };
  let inFlight: Promise<void> = Promise.resolve();

  async function runSweep(services: ManualSyncServices): Promise<void> {
    const startTime = clock();
    try {
      const result = await services.echelonOrchestrator.runFullSync({ dryRun: false });

      for (const inv of result.inventory) {
        for (const detail of inv.details || []) {
          await services.syncSettings.writeSyncLog({
            channelId: inv.channelId,
            channelName: inv.channelName,
            action: "inventory_push",
            sku: detail.sku,
            productVariantId: detail.variantId,
            previousValue: detail.previousQty != null ? String(detail.previousQty) : null,
            newValue: String(detail.allocatedQty),
            status:
              detail.status === "success" ? "pushed" : detail.status === "error" ? "error" : "skipped",
            errorMessage: detail.error || null,
            source: "manual",
          });
        }
      }

      const durationMs = clock() - startTime;
      await services.syncSettings.updateLastSweep(durationMs);

      status.lastResult = {
        channels: result.inventory.length,
        pushed: result.inventory.reduce((s: number, i: any) => s + i.variantsPushed, 0),
        errors: result.inventory.reduce((s: number, i: any) => s + i.variantsErrored, 0),
        durationMs,
      };
      status.lastError = null;
    } catch (error: any) {
      // The requester already got their 202 — this is the only place the
      // failure can surface. Keep it loud and queryable via getStatus().
      status.lastError = error?.message || String(error);
      console.error(`[ManualSync] Background sweep failed: ${status.lastError}`);
    } finally {
      status.running = false;
      status.finishedAt = new Date(clock()).toISOString();
    }
  }

  return {
    trigger(services: ManualSyncServices): "started" | "already_running" {
      if (status.running) return "already_running";
      status.running = true;
      status.startedAt = new Date(clock()).toISOString();
      status.finishedAt = null;
      inFlight = runSweep(services);
      return "started";
    },
    getStatus(): ManualSyncStatus {
      return { ...status, lastResult: status.lastResult ? { ...status.lastResult } : null };
    },
    whenIdle(): Promise<void> {
      return inFlight;
    },
  };
}
