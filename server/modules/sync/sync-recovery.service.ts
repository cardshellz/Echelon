/**
 * SyncRecoveryService — unified order-recovery orchestration.
 *
 * Closes sync gaps across the full order pipeline:
 *   Shopify API  →  shopify_orders  →  oms.oms_orders  →  wms.orders
 *
 * Each stage has its own backfill function; this service runs them in
 * sequence and reports aggregated results. Callable both from a scheduled
 * interval (every N minutes) and from the manual 'Sync Now' admin button.
 *
 * Designed to scale to multiple channels: when eBay/Amazon/wholesale add
 * reconciliation support, add new `runX()` methods and include them in
 * `runAll()`.
 */

import { runReconciliationNow as shopifyReconcile } from "../orders/shopify-order-reconciliation";
import { backfillShopifyOrders } from "./shopify-bridge-wrapper";

export interface StageResult {
  name: string;
  ok: boolean;
  /** stage-specific numeric output, e.g. { reconciled: 5, checked: 12 } */
  data?: Record<string, number>;
  error?: string;
}

export interface SyncRecoveryResult {
  startedAt: string;
  durationMs: number;
  stages: StageResult[];
  /** Convenience: true if every stage succeeded (even with 0 changes). */
  allOk: boolean;
}

export class SyncRecoveryService {
  private isRunning = false;

  constructor(
    private db: any,
    private services: { oms?: any; wmsSync?: any },
  ) {}

  /**
   * Run every recovery stage in order. Each stage runs independently; a
   * failure in one doesn't abort the others. Returns per-stage results.
   *
   * Safe to call concurrently — a second call while one is in flight
   * returns immediately with a skipped result to avoid hammering upstream
   * APIs.
   */
  async runAll(): Promise<SyncRecoveryResult> {
    const startedAt = new Date().toISOString();
    const started = Date.now();
    const stages: StageResult[] = [];

    if (this.isRunning) {
      return {
        startedAt,
        durationMs: 0,
        stages: [
          { name: "skipped", ok: true, data: { reason: 0 } },
        ],
        allOk: true,
      };
    }

    this.isRunning = true;
    try {
      // 1) Pull any missing orders from Shopify → shopify_orders
      stages.push(await this.runShopifyReconcile());

      // 2) Bridge shopify_orders that haven't reached OMS yet
      stages.push(await this.runShopifyToOmsBackfill());

      // 3) Bridge oms_orders that haven't reached WMS yet
      stages.push(await this.runOmsToWmsBackfill());
    } finally {
      this.isRunning = false;
    }

    const durationMs = Date.now() - started;
    const allOk = stages.every((s) => s.ok);
    if (stages.some((s) => s.data && Object.values(s.data).some((n) => n > 0))) {
      console.log(
        `[SyncRecovery] completed in ${durationMs}ms ${JSON.stringify(stages)}`,
      );
    }
    return { startedAt, durationMs, stages, allOk };
  }

  async runShopifyReconcile(): Promise<StageResult> {
    try {
      const result = await shopifyReconcile();
      return {
        name: "shopify_reconcile",
        ok: true,
        data: {
          checked: result?.checked ?? 0,
          reconciled: result?.reconciled ?? 0,
          failed: result?.failed ?? 0,
          skipped: result?.skipped ?? 0,
        },
      };
    } catch (err: any) {
      console.error("[SyncRecovery] shopify_reconcile failed:", err);
      return {
        name: "shopify_reconcile",
        ok: false,
        error: err?.message || String(err),
      };
    }
  }

  async runShopifyToOmsBackfill(): Promise<StageResult> {
    try {
      if (!this.services.oms) {
        return {
          name: "shopify_to_oms",
          ok: false,
          error: "oms service unavailable",
        };
      }
      const bridged = await backfillShopifyOrders(
        this.db,
        this.services.oms,
        500,
      );
      return { name: "shopify_to_oms", ok: true, data: { bridged } };
    } catch (err: any) {
      console.error("[SyncRecovery] shopify_to_oms failed:", err);
      return {
        name: "shopify_to_oms",
        ok: false,
        error: err?.message || String(err),
      };
    }
  }

  async runOmsToWmsBackfill(): Promise<StageResult> {
    try {
      if (!this.services.wmsSync?.backfillUnsynced) {
        return {
          name: "oms_to_wms",
          ok: false,
          error: "wmsSync service unavailable",
        };
      }
      const synced = await this.services.wmsSync.backfillUnsynced(500);
      return { name: "oms_to_wms", ok: true, data: { synced } };
    } catch (err: any) {
      console.error("[SyncRecovery] oms_to_wms failed:", err);
      return {
        name: "oms_to_wms",
        ok: false,
        error: err?.message || String(err),
      };
    }
  }

  /**
   * Start a scheduled interval that runs runAll() every `intervalMinutes`
   * minutes. Returns a handle you can clear with clearInterval().
   *
   * The first run fires `initialDelayMs` milliseconds after start (default
   * 30s) so we don't compete with boot startup.
   */
  startScheduled(intervalMinutes = 10, initialDelayMs = 30_000) {
    const intervalMs = intervalMinutes * 60 * 1000;
    console.log(
      `[SyncRecovery] Scheduled runs every ${intervalMinutes}min (first in ${
        initialDelayMs / 1000
      }s)`,
    );

    const firstTimer = setTimeout(() => {
      this.runAll().catch((err) => {
        console.error("[SyncRecovery] Initial run failed:", err);
      });

      const loopTimer = setInterval(() => {
        this.runAll().catch((err) => {
          console.error("[SyncRecovery] Scheduled run failed:", err);
        });
      }, intervalMs);

      // Attach loopTimer to be clearable from the outside
      (firstTimer as any)._syncLoopTimer = loopTimer;
    }, initialDelayMs);

    return {
      stop: () => {
        clearTimeout(firstTimer);
        const loopTimer = (firstTimer as any)._syncLoopTimer;
        if (loopTimer) clearInterval(loopTimer);
      },
    };
  }
}
