import { salesStatusEntrySchema, type SalesStatusEntry } from "@shared/types/inventory-sales-status";

import type { InventoryAvailabilityTransactionQueryClient } from "../application/inventory-availability-transaction-query.port";
import { SalesStatusError, salesStatusScopeKey } from "../domain/inventory-sales-status";

/**
 * Reads the sales status settings of one product (inventory.sales_statuses).
 * A leaf module on purpose: the publication target loader, the admin stock
 * preview and the sales status command all read through it, and it imports
 * nothing that plans or publishes, so no import cycle can form.
 *
 * A SKU setting stores only the SKU, so it is found through the SKU's current
 * product. Each branch of the UNION uses one of the scope unique indexes.
 */
export const SALES_STATUS_PRODUCT_ENTRIES_SQL = `
  SELECT setting.id, setting.channel_id, setting.product_id AS item_product_id, setting.product_variant_id,
         setting.status, setting.note, setting.revision::text AS revision, setting.updated_by, setting.updated_at
  FROM inventory.sales_statuses AS setting
  WHERE setting.product_id = $1
  UNION ALL
  SELECT setting.id, setting.channel_id, variant.product_id AS item_product_id, setting.product_variant_id,
         setting.status, setting.note, setting.revision::text AS revision, setting.updated_by, setting.updated_at
  FROM inventory.sales_statuses AS setting
  JOIN catalog.product_variants AS variant ON variant.id = setting.product_variant_id
  WHERE variant.product_id = $1
  ORDER BY id`;

export interface SalesStatusRow {
  id: unknown;
  channel_id: unknown;
  item_product_id: unknown;
  product_variant_id: unknown;
  status: unknown;
  note: unknown;
  revision: unknown;
  updated_by: unknown;
  updated_at: unknown;
}

type QueryClient = Pick<InventoryAvailabilityTransactionQueryClient, "query">;

/** Every explicit setting for the product and its SKUs, in id order, validated. */
export async function loadSalesStatusEntriesForProduct(
  client: QueryClient,
  productId: number,
): Promise<SalesStatusEntry[]> {
  const result = await client.query<SalesStatusRow>(SALES_STATUS_PRODUCT_ENTRIES_SQL, [productId]);
  return result.rows.map(salesStatusEntryFromRow);
}

/**
 * One stored row as a contract entry. The table's constraints make a bad row
 * impossible; if one appears anyway it is corrupt evidence, and the caller's
 * plan must fail closed rather than guess a status.
 */
export function salesStatusEntryFromRow(row: SalesStatusRow): SalesStatusEntry {
  const updatedAt = row.updated_at instanceof Date ? row.updated_at : new Date(String(row.updated_at));
  const productVariantId = row.product_variant_id == null ? null : Number(row.product_variant_id);
  const scope = {
    channelId: row.channel_id == null ? null : Number(row.channel_id),
    productId: Number(row.item_product_id),
    productVariantId,
  };
  const parsed = salesStatusEntrySchema.safeParse({
    scopeKey: salesStatusScopeKey(scope),
    scope,
    status: row.status,
    note: row.note ?? null,
    revision: String(row.revision),
    updatedBy: row.updated_by,
    updatedAt: Number.isFinite(updatedAt.getTime()) ? updatedAt.toISOString() : String(row.updated_at),
  });
  if (!parsed.success) {
    throw new SalesStatusError(500, "SALES_STATUS_EVIDENCE_INVALID",
      "A stored sales status is malformed. Nothing was planned from it.", "permanent", { salesStatusId: String(row.id) });
  }
  return parsed.data;
}
