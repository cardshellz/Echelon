import { sql, type SQL } from "drizzle-orm";
import { shipmentCancellationEvidenceSchema, type ShipmentCancellationEvidence } from "./domain/shipment-cancellation";

export interface ShipmentCancellationReader {
  execute(query: SQL): Promise<{ rows: unknown[] }>;
}

/** Caller holds the cost graph and shipment row locks. Receipt preparation,
 * receipt posting and AP shipment invoice creation share this lock boundary.
 * Legacy charge invoice markers also require review when their FK is absent.
 * Read all evidence after waiting; never decide from a previously loaded header. */
export async function readShipmentCancellationEvidence(
  tx: ShipmentCancellationReader,
  shipmentId: number,
): Promise<ShipmentCancellationEvidence> {
  const result = await tx.execute(sql`
    SELECT
      (EXISTS (SELECT 1 FROM procurement.receiving_orders WHERE inbound_shipment_id = ${shipmentId})
       OR EXISTS (SELECT 1 FROM procurement.receiving_lines receipt_line
         JOIN procurement.inbound_shipment_lines shipment_line ON shipment_line.id = receipt_line.inbound_shipment_line_id
         WHERE shipment_line.inbound_shipment_id = ${shipmentId})) AS "receivingHistory",
      (EXISTS (SELECT 1 FROM inventory.inventory_lots WHERE inbound_shipment_id = ${shipmentId})
       OR EXISTS (SELECT 1 FROM inventory.lot_cost_origins origin
         JOIN procurement.inbound_shipment_lines line ON line.id = origin.inbound_shipment_line_id
         WHERE line.inbound_shipment_id = ${shipmentId})) AS "inventoryHistory",
      (EXISTS (SELECT 1 FROM procurement.landed_cost_snapshots snapshot
         JOIN procurement.inbound_shipment_lines line ON line.id = snapshot.inbound_shipment_line_id
         WHERE line.inbound_shipment_id = ${shipmentId})
       OR EXISTS (SELECT 1 FROM procurement.landed_cost_adjustments adjustment
         JOIN procurement.inbound_shipment_lines line ON line.id = adjustment.inbound_shipment_line_id
         WHERE line.inbound_shipment_id = ${shipmentId})
       OR EXISTS (SELECT 1 FROM procurement.cost_source_revisions revision
         JOIN procurement.inbound_shipment_lines line ON line.id = revision.inbound_shipment_line_id
         WHERE line.inbound_shipment_id = ${shipmentId})
       OR EXISTS (SELECT 1 FROM procurement.inbound_freight_costs cost
         WHERE cost.inbound_shipment_id = ${shipmentId}
           AND (cost.actual_cents IS NOT NULL OR cost.paid_date IS NOT NULL
             OR cost.cost_status IS DISTINCT FROM 'estimated'))) AS "finalizedCostHistory",
      (EXISTS (SELECT 1 FROM procurement.vendor_invoices WHERE inbound_shipment_id = ${shipmentId})
       OR EXISTS (SELECT 1 FROM procurement.inbound_freight_costs cost
         WHERE cost.inbound_shipment_id = ${shipmentId}
           AND (cost.vendor_invoice_id IS NOT NULL OR cost.invoice_number IS NOT NULL
             OR cost.invoice_date IS NOT NULL OR cost.due_date IS NOT NULL))
       OR EXISTS (SELECT 1 FROM procurement.vendor_invoice_lines invoice_line
         JOIN procurement.inbound_freight_costs cost ON cost.id = invoice_line.freight_cost_id
         WHERE cost.inbound_shipment_id = ${shipmentId})) AS "invoiceHistory"
  `);
  // A missing/malformed row is an unavailable proof, never permission to cancel.
  return shipmentCancellationEvidenceSchema.array().length(1).parse(result.rows)[0];
}
