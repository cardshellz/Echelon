import { sql } from "drizzle-orm";
import { sqlIntegerArray } from "../../infrastructure/postgres-array";
import { WmsFulfillmentProjectionError } from "./channel-fulfillment-projection.repository";

interface ReconciliationSourceQuantity {
  sourceItemId: number;
  sourceQuantity: number;
  finalQuantity: number;
}

interface LegacySourceItem {
  id: number;
  shipment_id: number;
  shipment_item_purpose: string;
}

/** Reconciliation-specific compatibility projection. The application owner calls
 * this explicitly in the same transaction as its WMS/OMS package projection.
 * Ordinary package projection does not depend on reconciliation receipts.
 * Original quantities and provider observations remain immutable. */
export async function projectReconciledLegacyHeaders(
  transaction: any,
  physicalShipmentId: number,
  now: Date,
): Promise<void> {
  if (!Number.isSafeInteger(physicalShipmentId) || physicalShipmentId <= 0
    || typeof transaction?.execute !== "function" || !(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new WmsFulfillmentProjectionError("INVALID_INPUT", "Reconciliation projection requires a transaction, package identity and valid clock");
  }

  const receipt = await transaction.execute(sql`
    SELECT command.plan
    FROM wms.ebay_label_replacement_work work
    JOIN oms.package_reconciliation_commands command ON command.id = work.package_reconciliation_command_id
    WHERE work.physical_shipment_id = ${physicalShipmentId}
      AND work.state = 'applied' AND command.state IN ('applied', 'complete')
  `);
  if (receipt.rows.length === 0) return;
  if (receipt.rows.length !== 1) {
    throw new WmsFulfillmentProjectionError("RECONCILIATION_RECEIPT_CONFLICT", "A physical package has conflicting reconciliation provenance");
  }

  const quantities = new Map<number, ReconciliationSourceQuantity>(receipt.rows[0].plan.sourceQuantities
    .map((item: ReconciliationSourceQuantity) => [item.sourceItemId, item]));
  const sourceRows = await transaction.execute(sql`
    SELECT item.id, item.shipment_id, item.shipment_item_purpose
    FROM wms.outbound_shipment_items item
    WHERE item.shipment_id IN (
      SELECT source.shipment_id FROM wms.outbound_shipment_items source
      WHERE source.id = ANY(${sqlIntegerArray([...quantities.keys()])})
    ) ORDER BY item.shipment_id, item.id
  `);
  const headers = new Map<number, LegacySourceItem[]>();
  for (const row of sourceRows.rows as LegacySourceItem[]) {
    const items = headers.get(row.shipment_id) ?? [];
    items.push(row);
    headers.set(row.shipment_id, items);
  }

  for (const [headerId, items] of headers) {
    if (items.some(item => {
      const quantity = quantities.get(item.id);
      return item.shipment_item_purpose !== "customer_fulfillment" || !quantity
        || quantity.finalQuantity !== quantity.sourceQuantity;
    })) continue;

    const packages = await transaction.execute(sql`
      SELECT DISTINCT package.id, package.provider, package.provider_physical_shipment_id,
        package.tracking_number, package.carrier, package.ship_date,
        (SELECT COUNT(DISTINCT original.shipment_id) = 1 AND COUNT(original.id) = COUNT(*)
         FROM wms.effective_physical_shipment_items member
         LEFT JOIN wms.package_allocation_entries allocation ON allocation.id = member.package_allocation_entry_id
         LEFT JOIN wms.package_allocation_source_lines allocation_source ON allocation_source.id = allocation.package_allocation_source_line_id
         LEFT JOIN wms.outbound_shipment_items original ON original.id = COALESCE(member.legacy_wms_shipment_item_id,
           member.label_replacement_source_item_id, allocation_source.source_wms_shipment_item_id)
         WHERE member.physical_shipment_id = package.id) AS exclusive_header
      FROM wms.effective_physical_shipment_items item
      JOIN wms.physical_shipments package ON package.id = item.physical_shipment_id
      LEFT JOIN wms.package_allocation_entries entry ON entry.id = item.package_allocation_entry_id
      LEFT JOIN wms.package_allocation_source_lines source ON source.id = entry.package_allocation_source_line_id
      WHERE COALESCE(item.legacy_wms_shipment_item_id, item.label_replacement_source_item_id, source.source_wms_shipment_item_id)
        = ANY(${sqlIntegerArray(items.map(item => item.id))})
      ORDER BY package.ship_date, package.id
    `);
    if (packages.rows.length === 0) {
      throw new WmsFulfillmentProjectionError("RECONCILIATION_COVERAGE_MISSING", "A fully reconciled source has no current physical package", { headerId });
    }
    const first = packages.rows[0];
    const single = packages.rows.length === 1;
    const carriers = new Set(packages.rows.map((item: { carrier: string }) => item.carrier));
    // This field is unique across legacy headers. A shared combined parcel
    // keeps its identity in canonical storage, while both headers show tracking.
    const externalFulfillmentId = single && first.exclusive_header
      ? `provider_physical:v1:${first.provider}:${first.provider_physical_shipment_id}` : null;
    await transaction.execute(sql`
      UPDATE wms.outbound_shipments SET status = 'shipped',
        tracking_number = ${single ? first.tracking_number : null},
        carrier = ${carriers.size === 1 ? first.carrier : null},
        external_fulfillment_id = ${externalFulfillmentId}, shipped_at = ${first.ship_date}, updated_at = ${now}
      WHERE id = ${headerId}
    `);
  }
}
