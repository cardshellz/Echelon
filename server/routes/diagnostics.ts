import type { Express } from "express";
import { db, pool } from "../db";
import { sql } from "drizzle-orm";
import { backfillMemberTiers } from "../modules/oms/member-tier-enrichment";
import { WmsSyncService } from "../modules/oms/wms-sync.service";
import { createDropshipOmsChannelResolver } from "../modules/dropship/oms-channel-resolver.api";
import { requireAuth, requireInternalApiKey, requirePermission } from "./middleware";

export function registerDiagnosticsRoutes(app: Express) {
  app.use("/api/_internal/diagnostics", requireInternalApiKey);

  // Retired destructive non-transactional duplicate-delete endpoints (PLAT-01 / FND-3).
  // Use scripts/cleanup-duplicate-wms-orders.ts, which classifies duplicates, cancels
  // only unstarted duplicate WMS orders, and writes an OMS audit event without deleting
  // ledger or order rows.
  for (const path of ["cleanup-duplicates-normalized", "cleanup-duplicates"]) {
    app.post(`/api/_internal/diagnostics/${path}`, requireAuth, requirePermission("orders", "edit"), (_req, res) => {
      res.status(410).json({
        code: "DIAGNOSTIC_DUPLICATE_DELETE_RETIRED",
        error: "Direct duplicate order and ledger deletion is retired. Use the audited duplicate-order retirement workflow.",
      });
    });
  }

  // Check for duplicate orders
  app.get("/api/_internal/diagnostics/duplicate-orders", requireAuth, requirePermission("orders", "view"), async (_req, res) => {
    try {
      const pickQueueDupes = await db.execute(sql`
        SELECT 
          order_number, 
          COUNT(*) as count,
          array_agg(id ORDER BY created_at) as order_ids,
          array_agg(warehouse_status) as statuses
        FROM wms.orders 
        WHERE warehouse_status IN ('ready', 'in_progress')
        GROUP BY order_number 
        HAVING COUNT(*) > 1
        ORDER BY count DESC
        LIMIT 50
      `);

      const allShopifyDupes = await db.execute(sql`
        SELECT 
          order_number,
          COUNT(*) as count
        FROM wms.orders
        WHERE source = 'shopify'
        GROUP BY order_number
        HAVING COUNT(*) > 1
      `);

      res.json({
        pickQueueDuplicates: pickQueueDupes.rows.length,
        totalShopifyDuplicates: allShopifyDupes.rows.length,
        diagnosis: pickQueueDupes.rows.length > 0 
          ? "DATABASE_DUPLICATES" 
          : "NO_DUPLICATES_OR_UI_ISSUE",
        details: pickQueueDupes.rows,
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Backfill member tiers for existing orders
  app.post("/api/_internal/diagnostics/backfill-member-tiers", requireAuth, requirePermission("orders", "edit"), async (req, res) => {
    try {
      const { limit = 100 } = req.body;
      const enriched = await backfillMemberTiers(limit);
      res.json({ 
        success: true,
        enriched,
        message: `Enriched ${enriched} orders with member tiers`
      });
    } catch (error: any) {
      console.error("Member tier backfill error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // Diagnose broken WMS orders (items mismatch with OMS)
  app.get("/api/_internal/diagnostics/broken-wms-orders", requireAuth, requirePermission("orders", "view"), async (req, res) => {
    try {
      const services = (req.app.locals as any).services;
      const wmsSyncSvc = new WmsSyncService({
        inventoryCore: services.inventoryCore,
        reservation: services.reservation,
        fulfillmentRouter: services.fulfillmentRouter,
        dropshipOmsChannel: createDropshipOmsChannelResolver(pool),
      });
      const result = await wmsSyncSvc.repairBrokenOrders(true); // dry run
      res.json({ ...result, dryRun: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Repair broken WMS orders — resyncs items from OMS
  app.post("/api/_internal/diagnostics/repair-wms-orders", requireAuth, requirePermission("orders", "edit"), async (req, res) => {
    try {
      const services = (req.app.locals as any).services;
      const wmsSyncSvc = new WmsSyncService({
        inventoryCore: services.inventoryCore,
        reservation: services.reservation,
        fulfillmentRouter: services.fulfillmentRouter,
        dropshipOmsChannel: createDropshipOmsChannelResolver(pool),
      });
      const result = await wmsSyncSvc.repairBrokenOrders(false); // actually fix
      res.json({ ...result, dryRun: false });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Resync a single WMS order's items from OMS
  app.post("/api/_internal/diagnostics/resync-wms-order/:wmsOrderId", requireAuth, requirePermission("orders", "edit"), async (req, res) => {
    try {
      const wmsOrderId = parseInt(req.params.wmsOrderId, 10);
      const services = (req.app.locals as any).services;
      const wmsSyncSvc = new WmsSyncService({
        inventoryCore: services.inventoryCore,
        reservation: services.reservation,
        fulfillmentRouter: services.fulfillmentRouter,
        dropshipOmsChannel: createDropshipOmsChannelResolver(pool),
      });
      const result = await wmsSyncSvc.resyncOrderItems(wmsOrderId);
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Retired unaudited release bypasses. Use the per-order, permission-checked
  // assignment command with the assignment snapshot shown in the queue.
  for (const path of ["release-stuck-orders", "force-release-by-number/:orderNumber"]) {
    app.post(`/api/_internal/diagnostics/${path}`, requireAuth, (_req, res) => {
      res.status(410).json({
        code: "PICKING_RELEASE_ENDPOINT_RETIRED",
        error: "Use Release picking assignment in the pick queue. Holds and pick progress are preserved.",
      });
    });
  }
}
