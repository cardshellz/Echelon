/**
 * Shared warehouse-settings resolver.
 *
 * Every service that reads `inventory.warehouse_settings` should go through
 * this module so the fallback hierarchy is applied consistently:
 *
 *   1. Look up the row for the given warehouseId (via FK warehouseId).
 *   2. If none, look up by the warehouse's `code` field (legacy rows were
 *      linked by code, not FK).
 *   3. Fall back to the DEFAULT row (warehouseCode = 'DEFAULT').
 *   4. If none of those exist, return null.
 *
 * Use `getSettingsForWarehouse(warehouseId?)` to get the full merged row,
 * or `getSettingForWarehouse(warehouseId?, key)` to pick a single field
 * (useful for one-off reads).
 *
 * DO NOT use `SELECT ... FROM warehouse_settings LIMIT 1` anywhere else
 * in the codebase \u2014 that was the old anti-pattern that picks whatever
 * row Postgres hands back first. This resolver replaces it.
 */

import { eq } from "drizzle-orm";
import { db as defaultDb } from "../../db";
import { warehouseSettings, warehouses } from "@shared/schema";
import type { WarehouseSettings } from "@shared/schema";

type DbLike = typeof defaultDb;

export async function getSettingsForWarehouse(
  warehouseId?: number | null,
  tx: DbLike = defaultDb,
): Promise<WarehouseSettings | null> {
  if (warehouseId != null) {
    // (1) Direct FK match
    const [specific] = await tx
      .select()
      .from(warehouseSettings)
      .where(eq(warehouseSettings.warehouseId, warehouseId))
      .limit(1);
    if (specific) return specific as WarehouseSettings;

    // (2) Legacy code match
    const [wh] = await tx
      .select()
      .from(warehouses)
      .where(eq(warehouses.id, warehouseId))
      .limit(1);
    if (wh) {
      const [byCode] = await tx
        .select()
        .from(warehouseSettings)
        .where(eq(warehouseSettings.warehouseCode, (wh as any).code))
        .limit(1);
      if (byCode) return byCode as WarehouseSettings;
    }
  }

  // (3) DEFAULT row fallback
  const [defaultRow] = await tx
    .select()
    .from(warehouseSettings)
    .where(eq(warehouseSettings.warehouseCode, "DEFAULT"))
    .limit(1);
  return (defaultRow as WarehouseSettings) ?? null;
}

/**
 * SLA cutoff config for a warehouse. Used by the pick-priority / SLA layer
 * (sort-rank.ts) to bucket an order into its fulfillment day in the warehouse's
 * own timezone. Both the timezone and the cutoff live on the WAREHOUSE row
 * (warehouse.warehouses) — they describe one building's fulfillment clock.
 *
 * Resolution:
 *   - warehouseId given → that warehouse's timezone + order_cutoff_local.
 *   - warehouseId null (order not yet routed) → the DEFAULT warehouse, so new
 *     orders bucket by the default building's clock until assignment.
 * Either field may be null:
 *   timezone null   → caller falls back to global default_timezone.
 *   cutoffLocal null → no cutoff (SLA from the raw placed day).
 */
export interface SlaCutoffConfig {
  timezone: string | null;
  cutoffLocal: string | null;
}

export async function getSlaCutoffConfig(
  warehouseId?: number | null,
  tx: DbLike = defaultDb,
): Promise<SlaCutoffConfig> {
  let wh: { timezone: string | null; orderCutoffLocal: string | null } | undefined;

  if (warehouseId != null) {
    [wh] = await tx
      .select({ timezone: warehouses.timezone, orderCutoffLocal: warehouses.orderCutoffLocal })
      .from(warehouses)
      .where(eq(warehouses.id, warehouseId))
      .limit(1);
  }
  if (!wh) {
    // Unassigned order → default warehouse (the building new orders flow to).
    [wh] = await tx
      .select({ timezone: warehouses.timezone, orderCutoffLocal: warehouses.orderCutoffLocal })
      .from(warehouses)
      .where(eq(warehouses.isDefault, 1))
      .limit(1);
  }

  return {
    timezone: (wh?.timezone ?? null) as string | null,
    cutoffLocal: (wh?.orderCutoffLocal ?? null) as string | null,
  };
}

/**
 * Single-field lookup with the same fallback hierarchy. Returns the field
 * value from whichever row wins, or `fallback` if no row or field is null.
 *
 * Example:
 *   const enabled = await getSettingForWarehouse(warehouseId, "enableOrderCombining", 1);
 */
export async function getSettingForWarehouse<
  K extends keyof WarehouseSettings,
>(
  warehouseId: number | null | undefined,
  key: K,
  fallback: WarehouseSettings[K],
  tx: DbLike = defaultDb,
): Promise<WarehouseSettings[K]> {
  const row = await getSettingsForWarehouse(warehouseId, tx);
  if (!row) return fallback;
  const value = row[key];
  return (value ?? fallback) as WarehouseSettings[K];
}
