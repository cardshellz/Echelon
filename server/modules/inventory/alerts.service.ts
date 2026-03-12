import { eq, sql, and, lt } from "drizzle-orm";
import {
  inventoryLevels,
  productVariants,
  warehouseLocations,
} from "@shared/schema";

type DrizzleDb = {
  select: (...args: any[]) => any;
  insert: (...args: any[]) => any;
  update: (...args: any[]) => any;
  delete: (...args: any[]) => any;
  execute: <T = any>(query: any) => Promise<{ rows: T[] }>;
};

export interface InventoryAlert {
  severity: "critical" | "warning" | "info";
  category: string;
  message: string;
  details: Record<string, any>;
}

/**
 * Inventory alerts service — detects anomalies and out-of-bounds conditions.
 *
 * Checks for:
 * - Negative inventory quantities (should never happen)
 * - Orphaned picked/packed stock (pickedQty > 0 with no active order)
 * - Reserved qty exceeding on-hand
 * - Stale picked inventory (picked but not shipped for too long)
 */
class InventoryAlertService {
  constructor(private readonly db: DrizzleDb) {}

  async checkAll(): Promise<InventoryAlert[]> {
    const alerts: InventoryAlert[] = [];

    const [negatives, overReserved, stalePickedRows, orphanedPicked] =
      await Promise.all([
        this.checkNegativeInventory(),
        this.checkOverReserved(),
        this.checkStalePicked(),
        this.checkOrphanedPicked(),
      ]);

    alerts.push(...negatives, ...overReserved, ...stalePickedRows, ...orphanedPicked);
    return alerts;
  }

  /** Any inventory_level bucket with a negative value */
  private async checkNegativeInventory(): Promise<InventoryAlert[]> {
    const rows = await this.db.execute<{
      id: number;
      sku: string;
      location_code: string;
      variant_qty: number;
      reserved_qty: number;
      picked_qty: number;
      packed_qty: number;
    }>(sql`
      SELECT il.id, pv.sku, wl.code AS location_code,
             il.variant_qty, il.reserved_qty, il.picked_qty, il.packed_qty
      FROM inventory_levels il
      JOIN product_variants pv ON pv.id = il.product_variant_id
      JOIN warehouse_locations wl ON wl.id = il.warehouse_location_id
      WHERE il.variant_qty < 0
         OR il.reserved_qty < 0
         OR il.picked_qty < 0
         OR il.packed_qty < 0
    `);

    return rows.rows.map((r) => {
      const negBuckets: string[] = [];
      if (r.variant_qty < 0) negBuckets.push(`variantQty=${r.variant_qty}`);
      if (r.reserved_qty < 0) negBuckets.push(`reservedQty=${r.reserved_qty}`);
      if (r.picked_qty < 0) negBuckets.push(`pickedQty=${r.picked_qty}`);
      if (r.packed_qty < 0) negBuckets.push(`packedQty=${r.packed_qty}`);
      return {
        severity: "critical" as const,
        category: "negative_inventory",
        message: `Negative inventory for ${r.sku} at ${r.location_code}: ${negBuckets.join(", ")}`,
        details: { levelId: r.id, sku: r.sku, location: r.location_code },
      };
    });
  }

  /** reservedQty > variantQty (over-committed) */
  private async checkOverReserved(): Promise<InventoryAlert[]> {
    const rows = await this.db.execute<{
      id: number;
      sku: string;
      location_code: string;
      variant_qty: number;
      reserved_qty: number;
    }>(sql`
      SELECT il.id, pv.sku, wl.code AS location_code,
             il.variant_qty, il.reserved_qty
      FROM inventory_levels il
      JOIN product_variants pv ON pv.id = il.product_variant_id
      JOIN warehouse_locations wl ON wl.id = il.warehouse_location_id
      WHERE il.reserved_qty > il.variant_qty
        AND il.reserved_qty > 0
    `);

    return rows.rows.map((r) => ({
      severity: "warning" as const,
      category: "over_reserved",
      message: `Over-reserved: ${r.sku} at ${r.location_code} — reserved ${r.reserved_qty} > on-hand ${r.variant_qty}`,
      details: { levelId: r.id, sku: r.sku, location: r.location_code, reserved: r.reserved_qty, onHand: r.variant_qty },
    }));
  }

  /** pickedQty > 0 for more than 48 hours (stale picks) */
  private async checkStalePicked(): Promise<InventoryAlert[]> {
    const rows = await this.db.execute<{
      id: number;
      sku: string;
      location_code: string;
      picked_qty: number;
      updated_at: string;
    }>(sql`
      SELECT il.id, pv.sku, wl.code AS location_code,
             il.picked_qty, il.updated_at
      FROM inventory_levels il
      JOIN product_variants pv ON pv.id = il.product_variant_id
      JOIN warehouse_locations wl ON wl.id = il.warehouse_location_id
      WHERE il.picked_qty > 0
        AND il.updated_at < NOW() - INTERVAL '48 hours'
    `);

    return rows.rows.map((r) => ({
      severity: "warning" as const,
      category: "stale_picked",
      message: `Stale picked inventory: ${r.picked_qty} units of ${r.sku} at ${r.location_code} picked > 48h ago`,
      details: { levelId: r.id, sku: r.sku, location: r.location_code, pickedQty: r.picked_qty, lastUpdated: r.updated_at },
    }));
  }

  /** pickedQty > 0 but no open orders reference this variant */
  private async checkOrphanedPicked(): Promise<InventoryAlert[]> {
    const rows = await this.db.execute<{
      id: number;
      sku: string;
      location_code: string;
      picked_qty: number;
    }>(sql`
      SELECT il.id, pv.sku, wl.code AS location_code, il.picked_qty
      FROM inventory_levels il
      JOIN product_variants pv ON pv.id = il.product_variant_id
      JOIN warehouse_locations wl ON wl.id = il.warehouse_location_id
      WHERE il.picked_qty > 0
        AND NOT EXISTS (
          SELECT 1 FROM order_items oi
          JOIN orders o ON o.id = oi.order_id
          WHERE oi.sku = pv.sku
            AND o.warehouse_status IN ('ready', 'in_progress', 'packed')
        )
    `);

    return rows.rows.map((r) => ({
      severity: "warning" as const,
      category: "orphaned_picked",
      message: `Orphaned picked stock: ${r.picked_qty} units of ${r.sku} at ${r.location_code} with no open order`,
      details: { levelId: r.id, sku: r.sku, location: r.location_code, pickedQty: r.picked_qty },
    }));
  }
}

export function createInventoryAlertService(db: any) {
  return new InventoryAlertService(db);
}
