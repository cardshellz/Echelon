import type { Express } from "express";
import { db } from "../db";
import { sql } from "drizzle-orm";
import { backfillMemberTiers } from "../modules/oms/member-tier-enrichment";
import { WmsSyncService } from "../modules/oms/wms-sync.service";

export function registerDiagnosticsRoutes(app: Express) {
  // Clean up duplicate orders with normalized Shopify IDs (handles gid:// prefix differences)
  app.post("/api/diagnostics/cleanup-duplicates-normalized", async (req, res) => {
    try {
      const { confirm } = req.body;
      if (confirm !== "DELETE_DUPLICATES") {
        return res.status(400).json({ 
          error: "Confirmation required",
          message: "Send { confirm: 'DELETE_DUPLICATES' } to proceed"
        });
      }

      // Delete duplicates where shopify_order_id differs only by gid:// prefix
      // Keep the EARLIEST created row
      
      // First: delete inventory_transactions that reference order_items
      const transactionsResult = await db.execute(sql`
        DELETE FROM inventory_transactions
        WHERE order_item_id IN (
          SELECT oi.id FROM wms.order_items oi
          WHERE oi.order_id IN (
            SELECT id FROM (
              SELECT 
                id,
                REPLACE(COALESCE(shopify_order_id, ''), 'gid://shopify/Order/', '') as normalized_id,
                ROW_NUMBER() OVER (
                  PARTITION BY REPLACE(COALESCE(shopify_order_id, ''), 'gid://shopify/Order/', '')
                  ORDER BY created_at ASC
                ) as rn
              FROM wms.orders
              WHERE source = 'shopify' AND shopify_order_id IS NOT NULL
            ) t
            WHERE rn > 1 AND normalized_id != ''
          )
        )
        RETURNING id
      `);

      // Second: delete order_items
      const itemsResult = await db.execute(sql`
        DELETE FROM wms.order_items 
        WHERE order_id IN (
          SELECT id FROM (
            SELECT 
              id,
              REPLACE(COALESCE(shopify_order_id, ''), 'gid://shopify/Order/', '') as normalized_id,
              ROW_NUMBER() OVER (
                PARTITION BY REPLACE(COALESCE(shopify_order_id, ''), 'gid://shopify/Order/', '')
                ORDER BY created_at ASC
              ) as rn
            FROM wms.orders
            WHERE source = 'shopify' AND shopify_order_id IS NOT NULL
          ) t
          WHERE rn > 1 AND normalized_id != ''
        )
        RETURNING id
      `);

      const ordersResult = await db.execute(sql`
        DELETE FROM wms.orders 
        WHERE id IN (
          SELECT id FROM (
            SELECT 
              id,
              REPLACE(COALESCE(shopify_order_id, ''), 'gid://shopify/Order/', '') as normalized_id,
              ROW_NUMBER() OVER (
                PARTITION BY REPLACE(COALESCE(shopify_order_id, ''), 'gid://shopify/Order/', '')
                ORDER BY created_at ASC
              ) as rn
            FROM wms.orders
            WHERE source = 'shopify' AND shopify_order_id IS NOT NULL
          ) t
          WHERE rn > 1 AND normalized_id != ''
        )
        RETURNING id
      `);

      res.json({
        success: true,
        deletedTransactions: transactionsResult.rows.length,
        deletedItems: itemsResult.rows.length,
        deletedOrders: ordersResult.rows.length,
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Clean up duplicate orders (DELETE operation - requires confirmation)
  app.post("/api/diagnostics/cleanup-duplicates", async (req, res) => {
    try {
      const { confirm } = req.body;
      if (confirm !== "DELETE_DUPLICATES") {
        return res.status(400).json({ 
          error: "Confirmation required",
          message: "Send { confirm: 'DELETE_DUPLICATES' } to proceed"
        });
      }

      // Delete order items first (foreign key constraint)
      const itemsResult = await db.execute(sql`
        DELETE FROM wms.order_items 
        WHERE order_id IN (
          SELECT id FROM (
            SELECT id, 
              ROW_NUMBER() OVER (PARTITION BY shopify_order_id ORDER BY created_at ASC) as rn
            FROM wms.orders
            WHERE source = 'shopify' AND shopify_order_id IS NOT NULL
          ) t
          WHERE rn > 1
        )
        RETURNING id
      `);

      // Delete duplicate orders (keep earliest)
      const ordersResult = await db.execute(sql`
        DELETE FROM wms.orders 
        WHERE id IN (
          SELECT id FROM (
            SELECT id, 
              ROW_NUMBER() OVER (PARTITION BY shopify_order_id ORDER BY created_at ASC) as rn
            FROM wms.orders
            WHERE source = 'shopify' AND shopify_order_id IS NOT NULL
          ) t
          WHERE rn > 1
        )
        RETURNING id
      `);

      res.json({
        success: true,
        deletedItems: itemsResult.rows.length,
        deletedOrders: ordersResult.rows.length,
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Check for duplicate orders (admin-only for security)
  app.get("/api/diagnostics/duplicate-orders", async (req, res) => {
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
  app.post("/api/diagnostics/backfill-member-tiers", async (req, res) => {
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
  app.get("/api/diagnostics/broken-wms-orders", async (req, res) => {
    try {
      const services = (req.app.locals as any).services;
      const wmsSyncSvc = new WmsSyncService({
        inventoryCore: services.inventoryCore,
        reservation: services.reservation,
        fulfillmentRouter: services.fulfillmentRouter,
      });
      const result = await wmsSyncSvc.repairBrokenOrders(true); // dry run
      res.json({ ...result, dryRun: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Repair broken WMS orders — resyncs items from OMS
  app.post("/api/diagnostics/repair-wms-orders", async (req, res) => {
    try {
      const services = (req.app.locals as any).services;
      const wmsSyncSvc = new WmsSyncService({
        inventoryCore: services.inventoryCore,
        reservation: services.reservation,
        fulfillmentRouter: services.fulfillmentRouter,
      });
      const result = await wmsSyncSvc.repairBrokenOrders(false); // actually fix
      res.json({ ...result, dryRun: false });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Resync a single WMS order's items from OMS
  app.post("/api/diagnostics/resync-wms-order/:wmsOrderId", async (req, res) => {
    try {
      const wmsOrderId = parseInt(req.params.wmsOrderId, 10);
      const services = (req.app.locals as any).services;
      const wmsSyncSvc = new WmsSyncService({
        inventoryCore: services.inventoryCore,
        reservation: services.reservation,
        fulfillmentRouter: services.fulfillmentRouter,
      });
      const result = await wmsSyncSvc.resyncOrderItems(wmsOrderId);
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Force release an order by order number (admin use only)
  app.post("/api/diagnostics/force-release-by-number/:orderNumber", async (req, res) => {
    try {
      const { orderNumber } = req.params;
      const { resetProgress = false } = req.body;
      const storage = (req.app.locals as any).services?.ordersStorage
        || (await import("../modules/orders")).ordersStorage;
      // Find by order number
      const result = await db.execute(sql`
        SELECT id FROM wms.orders WHERE order_number = ${orderNumber} LIMIT 1
      `);
      if (!result.rows.length) return res.status(404).json({ error: "Order not found: " + orderNumber });
      const orderId = result.rows[0].id as number;
      const order = await storage.forceReleaseOrder(orderId, Boolean(resetProgress));
      res.json({ success: true, orderId, order });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });
}