import type { PoolClient } from "pg";
import { z } from "zod";

const sourceSchema = z.object({
  id: z.number().int().positive(), orderItemId: z.number().int().positive(),
  sku: z.string().trim().min(1).max(100), quantity: z.number().int().positive(),
  shipmentStatus: z.string().min(1),
}).strict();
export type PackingSource = z.infer<typeof sourceSchema>;

/** Read owner provenance only. Caller supplies a repeatable-read, read-only client. */
export async function readOrderPackingSources(client: PoolClient, orderId: number, warehouseId: number): Promise<PackingSource[]> {
  z.number().int().positive().max(2_147_483_647).parse(orderId);
  z.number().int().positive().max(2_147_483_647).parse(warehouseId);
  const rows = await client.query(`SELECT source.id, item.id AS "orderItemId", item.sku,
    source.qty AS quantity, shipment.status AS "shipmentStatus"
    FROM wms.outbound_shipment_items source
    JOIN wms.outbound_shipments shipment ON shipment.id=source.shipment_id
    JOIN wms.order_items item ON item.id=source.order_item_id
    JOIN wms.orders parent ON parent.id=item.order_id
    WHERE parent.id=$1 AND parent.warehouse_id=$2 AND shipment.order_id=parent.id
      AND source.shipment_item_purpose='customer_fulfillment' AND source.qty>0
    ORDER BY source.id LIMIT 501`, [orderId, warehouseId]);
  return z.array(sourceSchema).max(500).parse(rows.rows);
}
