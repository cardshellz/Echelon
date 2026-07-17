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
import { sql } from "drizzle-orm";
import { envPositiveInteger } from "../../infrastructure/scheduler-config";

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
    private services: { oms?: any; wmsSync?: any; shipStation?: any },
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
      // Drain durable local work before calling any remote source API.
      stages.push(await this.runShopifyToOmsBackfill());
      stages.push(await this.runOmsToWmsBackfill());
      stages.push(await this.runWmsToShipStationBackfill());

      const sourceResult = await this.runShopifyReconcile();
      stages.push(sourceResult);

      // Source reconciliation bridges recovered rows into OMS. Complete
      // their downstream handoff without waiting for the next interval.
      if ((sourceResult.data?.reconciled ?? 0) > 0) {
        stages.push(
          await this.runOmsToWmsBackfill("oms_to_wms_after_shopify_reconcile"),
        );
        stages.push(
          await this.runWmsToShipStationBackfill(
            "wms_to_shipstation_after_shopify_reconcile",
          ),
        );
      }
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
      const failed = result?.failed ?? 0;
      return {
        name: "shopify_reconcile",
        ok: failed === 0,
        data: {
          checked: result?.checked ?? 0,
          reconciled: result?.reconciled ?? 0,
          failed,
          skipped: result?.skipped ?? 0,
        },
        error: failed > 0
          ? `${failed} Shopify source order(s) failed reconciliation`
          : undefined,
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
      const result = await backfillShopifyOrders(
        this.db,
        this.services.oms,
        envPositiveInteger("SYNC_RECOVERY_SHOPIFY_TO_OMS_LIMIT", 50),
      );
      return {
        name: "shopify_to_oms",
        ok: result.failed === 0,
        data: {
          attempted: result.attempted,
          bridged: result.bridged,
          failed: result.failed,
        },
        error: result.failed > 0
          ? `${result.failed} Shopify order(s) failed raw-to-OMS recovery`
          : undefined,
      };
    } catch (err: any) {
      console.error("[SyncRecovery] shopify_to_oms failed:", err);
      return {
        name: "shopify_to_oms",
        ok: false,
        error: err?.message || String(err),
      };
    }
  }

  async runOmsToWmsBackfill(name = "oms_to_wms"): Promise<StageResult> {
    try {
      if (!this.services.wmsSync?.backfillUnsynced) {
        return {
          name,
          ok: false,
          error: "wmsSync service unavailable",
        };
      }
      const synced = await this.services.wmsSync.backfillUnsynced(
        envPositiveInteger("SYNC_RECOVERY_OMS_TO_WMS_LIMIT", 50),
      );
      return { name, ok: true, data: { synced } };
    } catch (err: any) {
      console.error("[SyncRecovery] oms_to_wms failed:", err);
      return {
        name,
        ok: false,
        error: err?.message || String(err),
      };
    }
  }

  async runWmsToShipStationBackfill(
    name = "wms_to_shipstation",
  ): Promise<StageResult> {
    try {
      if (!this.services.shipStation) {
        return {
          name,
          ok: false,
          error: "shipStation service unavailable",
        };
      }

      const shipmentLimit = envPositiveInteger("SYNC_RECOVERY_WMS_TO_SHIPSTATION_LIMIT", 25);

      // Find planned outbound shipments that do NOT have a ShipStation order ID.
      const result: any = await this.db.execute(sql`
        SELECT id
        FROM wms.outbound_shipments
        WHERE status = 'planned'
          AND engine_order_ref IS NULL
        ORDER BY created_at ASC
        LIMIT ${shipmentLimit}
      `);
      
      const shipmentIds = result.rows.map((r: any) => r.id);
      if (shipmentIds.length === 0) {
        return { name, ok: true, data: { checked: 0, pushed: 0, failed: 0 } };
      }
      
      let pushed = 0;
      let failed = 0;
      
      for (const id of shipmentIds) {
        try {
          await this.services.shipStation.pushShipment(id);
          pushed++;
        } catch (err: any) {
          console.warn(`[SyncRecovery] wms_to_shipstation failed to push shipment ${id}: ${err.message}`);
          failed++;
        }
        await new Promise(r => setTimeout(
          r,
          envPositiveInteger("SYNC_RECOVERY_WMS_TO_SHIPSTATION_DELAY_MS", 1000),
        ));
      }

      return {
        name,
        ok: failed === 0,
        data: { checked: shipmentIds.length, pushed, failed },
        error: failed > 0
          ? `${failed} WMS shipment(s) failed ShipStation recovery`
          : undefined,
      };
    } catch (err: any) {
      console.error("[SyncRecovery] wms_to_shipstation sweep failed:", err);
      return {
        name,
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
  startScheduled(
    intervalMinutes = envPositiveInteger("SYNC_RECOVERY_INTERVAL_MINUTES", 15),
    initialDelayMs = envPositiveInteger("SYNC_RECOVERY_INITIAL_DELAY_MS", 120_000),
  ) {
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
