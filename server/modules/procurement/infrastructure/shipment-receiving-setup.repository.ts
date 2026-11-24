import { sql } from "drizzle-orm";
import type { PurchaseOrderLine } from "@shared/schema";
import { shipmentLineResourceIdSchema } from "@shared/procurement/shipment-line-command";
import { MAX_SHIPMENT_RECEIVING_SETUP_LINES } from "@shared/procurement/shipment-receiving-setup";

export type ShipmentReceivingSource = Pick<PurchaseOrderLine, "id" | "purchaseOrderId" | "productId" | "productVariantId"
  | "expectedReceiveVariantId" | "expectedReceiveUnitsPerVariant" | "lineType" | "productName" | "sku">;

/** One bounded source read, independent of shipment line count. Write callers
 * acquire these share locks after the graph/shipment locks and before catalog. */
export async function readShipmentReceivingSources(executor: any, sourceIds: readonly number[], lock: boolean): Promise<Map<number, ShipmentReceivingSource>> {
  if (sourceIds.length > MAX_SHIPMENT_RECEIVING_SETUP_LINES) throw new Error("Shipment source review exceeds the line limit");
  const ids = [...new Set(sourceIds.map(id => shipmentLineResourceIdSchema.parse(id)))].sort((left, right) => left - right);
  if (!ids.length) return new Map();
  const result = await executor.execute(sql`SELECT id, purchase_order_id AS "purchaseOrderId", product_id AS "productId",
    product_variant_id AS "productVariantId", expected_receive_variant_id AS "expectedReceiveVariantId",
    expected_receive_units_per_variant AS "expectedReceiveUnitsPerVariant", line_type AS "lineType", product_name AS "productName", sku
    FROM procurement.purchase_order_lines WHERE id = ANY(ARRAY[${sql.join(ids.map(id => sql`${id}`), sql`, `)}]::integer[])
    ORDER BY id ${lock ? sql`FOR SHARE` : sql``}`);
  if (!Array.isArray(result.rows) || result.rows.length > ids.length) throw new Error("Shipment source lookup returned invalid evidence");
  const returnedIds = new Set<number>();
  for (const row of result.rows) {
    if (!ids.includes(row.id) || returnedIds.has(row.id)) throw new Error("Shipment source identities do not match the requested lines");
    returnedIds.add(row.id);
  }
  return new Map((result.rows as ShipmentReceivingSource[]).map(row => [row.id, row]));
}
