import type { PoolClient } from "pg";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { wmsOmsOrderIdSql } from "../../oms/oms-wms-order-link.sql";
import { OrderEditError } from "../domain/order-edit-error";

const integer = z.coerce.number().int().nonnegative().safe();
const itemSchema = z.object({
  id: integer.positive(),
  order_id: integer.positive(),
  oms_order_line_id: z.union([z.string(), integer]).nullable(),
  warehouse_channel_id: integer.nullable(),
  source_channel_id: integer.nullable(),
  product_id: integer.nullable(),
  catalog_product_id: integer.nullable(),
  sku: z.string().nullable(),
  product_variant_id: integer.nullable(),
  variant_product_id: integer.nullable(),
  variant_match_count: integer,
  source_variant_id: integer.nullable(),
  source_external_line_item_id: z.string().nullable(),
  quantity: integer,
  picked_quantity: integer,
  fulfilled_quantity: integer,
  status: z.string(),
  on_hold: z.boolean(),
});
export type OrderEditWarehouseItem = z.infer<typeof itemSchema>;

const binding = new PgDialect().sqlToQuery(
  wmsOmsOrderIdSql({
    source: sql.raw("wo.source"),
    omsFulfillmentOrderId: sql.raw("wo.oms_fulfillment_order_id"),
    legacySourceTableId: sql.raw("wo.source_table_id"),
  }),
).sql;

/** Read every item in the bound WMS partitions, including broken source links. */
export async function readOrderEditWarehouseItems(
  client: Pick<PoolClient, "query">,
  omsOrderId: number,
  lock = false,
): Promise<OrderEditWarehouseItem[]> {
  integer.positive().parse(omsOrderId);
  const result = await client.query(
    `SELECT oi.id,oi.order_id,oi.oms_order_line_id,oi.product_id,oi.catalog_product_id,oi.sku,
      wo.channel_id AS warehouse_channel_id,source.channel_id AS source_channel_id,
      variant.product_variant_id,variant.variant_product_id,variant.variant_match_count,
      ol.product_variant_id AS source_variant_id,ol.external_line_item_id AS source_external_line_item_id,
      oi.quantity,oi.picked_quantity,oi.fulfilled_quantity,oi.status,oi.on_hold
    FROM wms.order_items oi
    JOIN wms.orders wo ON wo.id=oi.order_id
    JOIN oms.oms_orders source ON source.id=$1
    LEFT JOIN oms.oms_order_lines ol ON ol.id=oi.oms_order_line_id AND ol.order_id=source.id
    LEFT JOIN LATERAL (
      SELECT count(*)::integer AS variant_match_count,min(pv.id) AS product_variant_id,
        min(pv.product_id) AS variant_product_id
      FROM catalog.product_variants pv WHERE pv.is_active=true
        AND ((oi.catalog_product_id IS NOT NULL AND pv.id=oi.product_id)
          OR (oi.catalog_product_id IS NULL AND upper(pv.sku)=upper(oi.sku)))
    ) variant ON true
    WHERE ${binding}=$1 ORDER BY oi.order_id,oi.id ${lock ? "FOR UPDATE OF oi" : ""}`,
    [omsOrderId],
  );
  return z.array(itemSchema).parse(result.rows);
}

export function assertOrderEditWarehouseItemIdentities(
  items: readonly OrderEditWarehouseItem[],
): void {
  // product_id stores the WMS variant for catalog-mapped rows. Legacy rows use
  // active SKU resolution, matching loadOrder in the canonical availability
  // claim repository. Never derive both sides from the OMS line itself.
  if (
    items.some(
      (item) =>
        item.status !== "cancelled" &&
        item.quantity > 0 &&
        (item.warehouse_channel_id !== item.source_channel_id ||
          item.variant_match_count !== 1 ||
          item.product_variant_id === null ||
          item.product_variant_id !== item.source_variant_id ||
          (item.catalog_product_id !== null &&
            item.catalog_product_id !== item.variant_product_id) ||
          (item.product_id !== null &&
            item.product_id !== item.product_variant_id &&
            (item.catalog_product_id !== null ||
              item.product_id !== item.variant_product_id))),
    )
  ) {
    throw new OrderEditError(
      "ORDER_EDIT_INVENTORY_PENDING",
      "Warehouse and source product identities do not match. The order remains held.",
    );
  }
}
