import type { Express } from "express";
import { db } from "../db";
import { sql } from "drizzle-orm";

export function registerDiagnosticsRoutes(app: Express) {
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
