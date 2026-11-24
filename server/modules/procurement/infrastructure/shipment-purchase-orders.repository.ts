import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { shipmentPurchaseOrderReferenceSchema, type ShipmentPurchaseOrderReference } from "@shared/procurement/shipment-purchase-orders";

export interface ShipmentPurchaseOrdersExecutor {
  execute(query: SQL): Promise<{ rows: unknown[] }>;
}

const shipmentIdSchema = z.number().int().positive().max(2_147_483_647);
const rowSchema = shipmentPurchaseOrderReferenceSchema.extend({ shipmentId: shipmentIdSchema });

/** Read only the selected shipment page, without joining lines into its pagination. */
export async function readShipmentPurchaseOrders(
  executor: ShipmentPurchaseOrdersExecutor,
  shipmentIds: readonly number[],
): Promise<Map<number, ShipmentPurchaseOrderReference[]>> {
  const ids = [...new Set(z.array(shipmentIdSchema).parse(shipmentIds))];
  const references = new Map<number, ShipmentPurchaseOrderReference[]>(ids.map((id) => [id, []]));
  if (ids.length === 0) return references;

  const idParameters = sql.join(ids.map((id) => sql`${id}`), sql`, `);
  // Both associations are persisted on shipment lines. UNION preserves either
  // source, including old lines with only a PO-line link, and deduplicates a PO
  // repeated across many lines. There is no purchase-order FK on shipment headers.
  const result = await executor.execute(sql`
    WITH shipment_purchase_orders AS (
      SELECT sl.inbound_shipment_id, sl.purchase_order_id
      FROM procurement.inbound_shipment_lines sl
      WHERE sl.inbound_shipment_id IN (${idParameters}) AND sl.purchase_order_id IS NOT NULL
      UNION
      SELECT sl.inbound_shipment_id, pol.purchase_order_id
      FROM procurement.inbound_shipment_lines sl
      JOIN procurement.purchase_order_lines pol ON pol.id = sl.purchase_order_line_id
      WHERE sl.inbound_shipment_id IN (${idParameters})
    )
    SELECT links.inbound_shipment_id AS "shipmentId", po.id, po.po_number AS "poNumber"
    FROM shipment_purchase_orders links
    JOIN procurement.purchase_orders po ON po.id = links.purchase_order_id
    ORDER BY links.inbound_shipment_id, po.id
  `);

  for (const row of z.array(rowSchema).parse(result.rows)) {
    const shipmentReferences = references.get(row.shipmentId);
    if (!shipmentReferences) throw new Error("Shipment purchase-order projection returned an unrequested shipment");
    shipmentReferences.push({ id: row.id, poNumber: row.poNumber });
  }
  return references;
}
