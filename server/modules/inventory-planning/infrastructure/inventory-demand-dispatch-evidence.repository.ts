import { sql, type SQL } from "drizzle-orm";
import { sqlIntegerArray } from "../../../infrastructure/postgres-array";
import { InventoryAvailabilityMasterDataError } from "../domain/inventory-availability-master-data.contracts";

/** Read-only database boundary, usable inside the existing repeatable-read refresh. */
export interface DemandEvidenceExecutor { execute(query: SQL): Promise<unknown> }
export interface CanonicalDemandPhysicalIdentity {
  transactionId: string;
  productVariantId: number;
  warehouseId: number;
}

/** Canonical ship rows intentionally have no physical on-hand delta. Validate
 * their immutable quantity authority before either physical or ledger demand
 * can consume them. Corruption aborts the refresh; it never manufactures units. */
export async function assertCanonicalDemandDispatchEvidence(
  tx: DemandEvidenceExecutor, productVariantIds: number[], windowStartedAt: Date, windowEndedAt: Date,
): Promise<ReadonlyMap<string, CanonicalDemandPhysicalIdentity>> {
  const result = await tx.execute(sql`
    SELECT inventory_tx.id AS transaction_id,
      inventory_tx.transaction_type,
      inventory_tx.product_variant_id, inventory_tx.order_id, inventory_tx.order_item_id,
      inventory_tx.shipment_id, inventory_tx.shipment_item_id, inventory_tx.from_location_id,
      inventory_tx.variant_qty_delta, inventory_tx.reserved_qty_delta,
      inventory_tx.source_state, inventory_tx.target_state, inventory_tx.reference_type,
      inventory_tx.voided_at,
      jsonb_build_object(
        'id', receipt.id::text, 'quantity', receipt.quantity::text,
        'orderId', receipt.order_id, 'orderItemId', receipt.order_item_id,
        'warehouseId', receipt.warehouse_id, 'locationId', receipt.warehouse_location_id,
        'variantId', receipt.product_variant_id, 'shipmentId', receipt.outbound_shipment_id,
        'sourceItemId', receipt.source_shipment_item_id,
        'physicalId', receipt.physical_shipment_id::text,
        'physicalItemId', receipt.physical_shipment_item_id::text
      ) AS receipt,
      jsonb_build_object(
        'id', source.id, 'shipmentId', source.shipment_id, 'orderItemId', source.order_item_id,
        'variantId', source.product_variant_id, 'locationId', source.from_location_id,
        'quantity', source.qty::text, 'purpose', source.shipment_item_purpose,
        'replacementId', source.replacement_for_order_item_id,
        'correctionId', source.correction_for_shipment_item_id
      ) AS source,
      header.order_id AS source_order_id, order_item.order_id AS item_order_id,
      location.warehouse_id AS location_warehouse_id,
      physical.items AS physical_items
    FROM inventory.inventory_transactions AS inventory_tx
    LEFT JOIN inventory.availability_claim_dispatch_receipts AS receipt
      ON receipt.inventory_transaction_id = inventory_tx.id
    LEFT JOIN wms.outbound_shipment_items AS source
      ON source.id = COALESCE(receipt.source_shipment_item_id, inventory_tx.shipment_item_id)
    LEFT JOIN wms.outbound_shipments AS header ON header.id = source.shipment_id
    LEFT JOIN wms.order_items AS order_item ON order_item.id = source.order_item_id
    LEFT JOIN warehouse.warehouse_locations AS location ON location.id = source.from_location_id
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object(
        'id', item.id::text, 'physicalId', item.physical_shipment_id::text,
        'sourceItemId', item.legacy_wms_shipment_item_id, 'orderItemId', item.wms_order_item_id,
        'variantId', item.product_variant_id, 'quantity', item.quantity_shipped::text,
        'purpose', item.shipment_item_purpose, 'status', package.status,
        'corrected', EXISTS (SELECT 1 FROM wms.physical_shipment_item_quantity_adjustments adjustment
          WHERE adjustment.physical_shipment_item_id = item.id)
      ) ORDER BY item.id) AS items,
      bool_or(COALESCE(package.ship_date, package.created_at) >= ${windowStartedAt}
        AND COALESCE(package.ship_date, package.created_at) < ${windowEndedAt}) AS in_window,
      bool_or(item.product_variant_id = ANY(${sqlIntegerArray(productVariantIds)})) AS matches_requested_variant
      FROM (
        SELECT candidate.* FROM wms.physical_shipment_items candidate
        WHERE candidate.legacy_wms_shipment_item_id = source.id
           OR candidate.id = receipt.physical_shipment_item_id
        ORDER BY candidate.id LIMIT 2
      ) item
      LEFT JOIN wms.physical_shipments package ON package.id = item.physical_shipment_id
    ) AS physical ON true
    WHERE (receipt.id IS NOT NULL OR inventory_tx.reference_type = 'availability_claim_dispatch')
      AND ((inventory_tx.created_at >= ${windowStartedAt} AND inventory_tx.created_at < ${windowEndedAt})
        OR physical.in_window = true)
      AND (inventory_tx.product_variant_id = ANY(${sqlIntegerArray(productVariantIds)})
        OR receipt.product_variant_id = ANY(${sqlIntegerArray(productVariantIds)})
        OR source.product_variant_id = ANY(${sqlIntegerArray(productVariantIds)})
        OR physical.matches_requested_variant = true
        OR COALESCE(inventory_tx.product_variant_id, receipt.product_variant_id, source.product_variant_id) IS NULL)
    ORDER BY inventory_tx.id
  `);
  const evidence = Array.isArray(result) ? result : (result as { rows: unknown[] }).rows;
  const verifiedPhysicalIds = new Map<string, CanonicalDemandPhysicalIdentity>();
  const seenTransactions = new Set<string>();
  for (const unknownRow of evidence) {
    const row = object(unknownRow);
    const transactionId = String(row.transaction_id);
    const invalid = (reason: string): never => canonicalDemandDispatchInvalid(transactionId, reason);
    if (seenTransactions.has(transactionId)) invalid("duplicate dispatch evidence");
    seenTransactions.add(transactionId);
    const receipt = object(row.receipt);
    const source = object(row.source);
    if (!positiveDecimal(receipt.id) || !positiveDecimal(receipt.quantity)) invalid("missing or invalid dispatch receipt quantity");
    if (row.transaction_type !== "ship" || row.reference_type !== "availability_claim_dispatch" || row.variant_qty_delta !== 0
      || row.reserved_qty_delta !== 0 || row.source_state !== "picked" || row.target_state !== "shipped"
      || row.voided_at != null) invalid("ship ledger custody or void state disagrees with dispatch");
    const matches = (left: unknown, right: unknown) => left != null && right != null && String(left) === String(right);
    if (!matches(row.order_id, receipt.orderId) || !matches(row.order_item_id, receipt.orderItemId)
      || !matches(row.product_variant_id, receipt.variantId) || !matches(row.shipment_id, receipt.shipmentId)
      || !matches(row.shipment_item_id, receipt.sourceItemId) || !matches(row.from_location_id, receipt.locationId)) {
      invalid("ship ledger identity disagrees with dispatch receipt");
    }
    if (!matches(source.id, receipt.sourceItemId) || !matches(source.shipmentId, receipt.shipmentId)
      || !matches(source.orderItemId, receipt.orderItemId) || !matches(source.variantId, receipt.variantId)
      || !matches(source.locationId, receipt.locationId) || !matches(source.quantity, receipt.quantity)
      || !matches(row.source_order_id, receipt.orderId) || !matches(row.item_order_id, receipt.orderId)
      || !matches(row.location_warehouse_id, receipt.warehouseId)) {
      invalid("current source ownership or quantity disagrees with dispatch receipt");
    }
    if (source.purpose !== "customer_fulfillment" || source.replacementId != null || source.correctionId != null) {
      invalid("dispatch source purpose changed");
    }
    if ((receipt.physicalId === null) !== (receipt.physicalItemId === null)) invalid("incomplete physical identity pair");
    const rawPhysical = row.physical_items == null ? [] : row.physical_items;
    const physical: unknown[] = Array.isArray(rawPhysical) ? rawPhysical : invalid("invalid physical source evidence");
    if (physical.length > 1) invalid("ambiguous physical source identity");
    if (physical.length === 0 && receipt.physicalItemId !== null) invalid("dispatch physical item is missing");
    for (const unknownItem of physical) {
      const item = object(unknownItem);
      if ((receipt.physicalItemId !== null && (!matches(item.id, receipt.physicalItemId)
        || !matches(item.physicalId, receipt.physicalId)))
        || !matches(item.sourceItemId, receipt.sourceItemId) || !matches(item.orderItemId, receipt.orderItemId)
        || !matches(item.variantId, receipt.variantId) || !matches(item.quantity, receipt.quantity)
        || item.purpose !== "customer_fulfillment" || !["shipped", "returned", "review"].includes(String(item.status))
        || item.corrected !== false) invalid("physical source identity or quantity requires review");
      const physicalId = String(item.id);
      if (verifiedPhysicalIds.has(physicalId)) invalid("physical item is linked to multiple dispatch receipts");
      verifiedPhysicalIds.set(physicalId, { transactionId,
        productVariantId: Number(receipt.variantId), warehouseId: Number(receipt.warehouseId) });
    }
  }
  return verifiedPhysicalIds;
}

export function canonicalDemandDispatchInvalid(transactionId: string, reason: string): never {
  throw new InventoryAvailabilityMasterDataError(409,
    "INVENTORY_DEMAND_CANONICAL_DISPATCH_EVIDENCE_INVALID",
    `Demand refresh cannot verify canonical ship transaction ${transactionId}: ${reason}.`,
    [`inventoryTransactionId=${transactionId}`, `reason=${reason}`]);
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}
function positiveDecimal(value: unknown): boolean {
  return typeof value === "string" && /^[1-9][0-9]*$/.test(value)
    && BigInt(value) <= BigInt("9223372036854775807");
}
