import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { PackageAllocationSourceIdentityError } from "./package-allocation-source-identity.domain";

const id = z.number().int().positive().safe();
const quantity = z.number().int().nonnegative().max(2_147_483_647);
const rootInputSchema = z.object({
  legacyWmsShipmentItemId: id, wmsOrderItemId: id, wmsOrderId: id,
}).strict();
const physicalInputSchema = z.object({
  legacyWmsShipmentItemId: id, wmsOrderItemId: id, fulfillmentPlanLineId: id.nullable(),
}).strict();
const physicalSchema = z.object({
  physicalShipmentItemId: id, allocationSourceShipmentItemId: id.nullable(),
  shipmentRequestItemId: id, fulfillmentPlanLineId: id,
  legacyWmsShipmentItemId: id.nullable(), labelReplacementSourceItemId: id.nullable(),
  shippingProvider: z.string().min(1), providerPhysicalShipmentId: z.string().min(1),
  quantityShipped: quantity, effectiveQuantityShipped: quantity,
}).strict();
export type PhysicalShipmentAllocationEvidence = Readonly<z.infer<typeof physicalSchema>>;
type QueryExecutor = { execute(query: SQL): Promise<unknown> };
const rowsSchema = z.object({ rows: z.array(z.record(z.unknown())) }).passthrough();

function rows(result: unknown): Record<string, unknown>[] {
  const parsed = rowsSchema.safeParse(result);
  if (!parsed.success) throw new PackageAllocationSourceIdentityError(
    "INVALID_SOURCE_FACTS", "Physical allocation query returned invalid evidence", { issues: parsed.error.issues },
  );
  return parsed.data.rows;
}

/** WMS owns split ancestry. Resolve the exact source without modifying a
 * compatibility row, package, request or inventory quantity. */
export async function readShipmentItemAllocationSource(
  tx: QueryExecutor, rawInput: z.input<typeof rootInputSchema>,
): Promise<number> {
  const parsed = rootInputSchema.safeParse(rawInput);
  if (!parsed.success) throw new PackageAllocationSourceIdentityError(
    "INVALID_SOURCE_FACTS", "Invalid allocation source lookup", { issues: parsed.error.issues },
  );
  const input = parsed.data;
  const sourceRows = rows(await tx.execute(sql`
    SELECT root.id AS source_id
    FROM wms.outbound_shipment_items AS child
    JOIN wms.outbound_shipment_items AS root ON root.id = COALESCE(child.split_root_shipment_item_id, child.id)
    JOIN wms.outbound_shipments AS child_shipment ON child_shipment.id = child.shipment_id
    JOIN wms.outbound_shipments AS root_shipment ON root_shipment.id = root.shipment_id
    WHERE child.id = ${input.legacyWmsShipmentItemId}
      AND child.order_item_id = ${input.wmsOrderItemId}
      AND root.order_item_id = child.order_item_id
      AND child_shipment.order_id = ${input.wmsOrderId} AND root_shipment.order_id = child_shipment.order_id
      AND root.product_variant_id IS NOT DISTINCT FROM child.product_variant_id
      AND root.shipment_item_purpose = child.shipment_item_purpose
      AND root.replacement_for_order_item_id IS NOT DISTINCT FROM child.replacement_for_order_item_id
      AND root.correction_for_shipment_item_id IS NOT DISTINCT FROM child.correction_for_shipment_item_id
      AND (root.split_root_shipment_item_id IS NULL OR root.split_root_shipment_item_id = root.id)
  `));
  const sourceId = sourceRows.length === 1 ? id.safeParse(Number(sourceRows[0].source_id)) : null;
  if (!sourceId?.success) throw new PackageAllocationSourceIdentityError(
    "SOURCE_LINEAGE_INVALID", "Package source lineage is missing or inconsistent", input,
  );
  return sourceId.data;
}

/** Published WMS physical evidence, read under the caller's owner lock or
 * read-only snapshot. OMS decides admission from these facts; it does not
 * reconstruct allocation provenance from WMS tables. */
export async function readPhysicalShipmentAllocationEvidence(
  tx: QueryExecutor, rawInput: z.input<typeof physicalInputSchema>,
): Promise<readonly PhysicalShipmentAllocationEvidence[]> {
  const parsed = physicalInputSchema.safeParse(rawInput);
  if (!parsed.success) throw new PackageAllocationSourceIdentityError(
    "INVALID_SOURCE_FACTS", "Invalid physical allocation lookup", { issues: parsed.error.issues },
  );
  const input = parsed.data;
  const rawRows = rows(await tx.execute(sql`
    SELECT item.id, source.source_wms_shipment_item_id AS allocation_source_id,
      item.shipment_request_item_id, item.fulfillment_plan_line_id, item.legacy_wms_shipment_item_id,
      item.label_replacement_source_item_id,
      package.provider, package.provider_physical_shipment_id, item.quantity_shipped,
      item.quantity_shipped + COALESCE(adjustment.quantity_delta, 0) AS effective_quantity
    FROM wms.physical_shipment_items AS item
    JOIN wms.physical_shipments AS package ON package.id = item.physical_shipment_id
    LEFT JOIN wms.package_allocation_entries AS entry ON entry.id = item.package_allocation_entry_id
    LEFT JOIN wms.package_allocation_source_lines AS source ON source.id = entry.package_allocation_source_line_id
      AND source.order_item_id = ${input.wmsOrderItemId}
    LEFT JOIN wms.physical_shipment_item_quantity_adjustments AS adjustment ON adjustment.physical_shipment_item_id = item.id
    WHERE adjustment.adjustment_kind IS DISTINCT FROM 'provider_label_replacement'
      AND item.shipment_item_purpose = 'customer_fulfillment'
      AND (item.fulfillment_plan_line_id = ${input.fulfillmentPlanLineId}::bigint
        OR item.legacy_wms_shipment_item_id = ${input.legacyWmsShipmentItemId})
    ORDER BY item.id
  `));
  const evidence = z.array(physicalSchema).safeParse(rawRows.map(row => ({
    physicalShipmentItemId: Number(row.id),
    allocationSourceShipmentItemId: row.allocation_source_id == null ? null : Number(row.allocation_source_id),
    shipmentRequestItemId: Number(row.shipment_request_item_id), fulfillmentPlanLineId: Number(row.fulfillment_plan_line_id),
    legacyWmsShipmentItemId: row.legacy_wms_shipment_item_id == null ? null : Number(row.legacy_wms_shipment_item_id),
    labelReplacementSourceItemId: row.label_replacement_source_item_id == null ? null : Number(row.label_replacement_source_item_id),
    shippingProvider: row.provider, providerPhysicalShipmentId: row.provider_physical_shipment_id,
    quantityShipped: Number(row.quantity_shipped), effectiveQuantityShipped: Number(row.effective_quantity),
  })));
  if (!evidence.success) throw new PackageAllocationSourceIdentityError(
    "INVALID_SOURCE_FACTS", "Persisted physical allocation evidence is invalid", { issues: evidence.error.issues },
  );
  if (new Set(evidence.data.map(item => item.physicalShipmentItemId)).size !== evidence.data.length) {
    throw new PackageAllocationSourceIdentityError("INVALID_SOURCE_FACTS", "Physical allocation evidence is ambiguous", input);
  }
  return Object.freeze(evidence.data.map(item => Object.freeze(item)));
}
