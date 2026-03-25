import type { Express } from "express";
import { db } from "../db";
import { sql } from "drizzle-orm";

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
      const itemsResult = await db.execute(sql`
        DELETE FROM order_items 
        WHERE order_id IN (
          SELECT id FROM (
            SELECT 
              id,
              REPLACE(COALESCE(shopify_order_id, ''), 'gid://shopify/Order/', '') as normalized_id,
              ROW_NUMBER() OVER (
                PARTITION BY REPLACE(COALESCE(shopify_order_id, ''), 'gid://shopify/Order/', '')
                ORDER BY created_at ASC
              ) as rn
            FROM orders
            WHERE source = 'shopify' AND shopify_order_id IS NOT NULL
          ) t
          WHERE rn > 1 AND normalized_id != ''
        )
        RETURNING id
      `);

      const ordersResult = await db.execute(sql`
        DELETE FROM orders 
        WHERE id IN (
          SELECT id FROM (
            SELECT 
              id,
              REPLACE(COALESCE(shopify_order_id, ''), 'gid://shopify/Order/', '') as normalized_id,
              ROW_NUMBER() OVER (
                PARTITION BY REPLACE(COALESCE(shopify_order_id, ''), 'gid://shopify/Order/', '')
                ORDER BY created_at ASC
              ) as rn
            FROM orders
            WHERE source = 'shopify' AND shopify_order_id IS NOT NULL
          ) t
          WHERE rn > 1 AND normalized_id != ''
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
        DELETE FROM order_items 
        WHERE order_id IN (
          SELECT id FROM (
            SELECT id, 
              ROW_NUMBER() OVER (PARTITION BY shopify_order_id ORDER BY created_at ASC) as rn
            FROM orders
            WHERE source = 'shopify' AND shopify_order_id IS NOT NULL
          ) t
          WHERE rn > 1
        )
        RETURNING id
      `);

      // Delete duplicate orders (keep earliest)
      const ordersResult = await db.execute(sql`
        DELETE FROM orders 
        WHERE id IN (
          SELECT id FROM (
            SELECT id, 
              ROW_NUMBER() OVER (PARTITION BY shopify_order_id ORDER BY created_at ASC) as rn
            FROM orders
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
        FROM orders 
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
        FROM orders
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
}
