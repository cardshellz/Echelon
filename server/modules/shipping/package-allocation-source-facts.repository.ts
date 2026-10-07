import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { sqlIntegerArray } from "../../infrastructure/postgres-array";
import {
  PackageAllocationSourceIdentityError,
  packageAllocationSourceFactsSchema,
  resolvePackageAllocationSourceQuantity,
  type PackageAllocationSourceFacts,
} from "./package-allocation-source-identity.domain";

const sourceIdsSchema = z.array(packageAllocationSourceFactsSchema.shape.sourceWmsShipmentItemId);
const queryResultSchema = z.object({ rows: z.array(z.record(z.unknown())) }).passthrough();

function validatedSourceIds(rawIds: readonly number[]): number[] {
  const parsed = sourceIdsSchema.safeParse(rawIds);
  if (!parsed.success) throw new PackageAllocationSourceIdentityError(
    "INVALID_SOURCE_FACTS", "Invalid WMS source identities", { issues: parsed.error.issues },
  );
  return [...new Set(parsed.data)].sort((left, right) => left - right);
}

/** One WMS-owned source reader for bootstrap and split/relabel admission.
 * Aggregate compatibility partitions as evidence; the domain resolves capacity.
 * Registration, requests, physical work and stock are never changed here. */
export function packageAllocationSourceFactsQuery(rawIds: readonly number[], lockRows: boolean): SQL {
  const ids = validatedSourceIds(rawIds);
  return sql`
    SELECT shipment_item.id AS source_wms_shipment_item_id,
      request_item.id::text AS shipment_request_item_id,
      registered.source_quantity AS registered_quantity,
      NOT EXISTS (
        SELECT 1 FROM wms.outbound_shipment_items AS split_item
        LEFT JOIN wms.outbound_shipments AS split_shipment ON split_shipment.id = split_item.shipment_id
        WHERE split_item.split_root_shipment_item_id = shipment_item.id AND split_item.id <> shipment_item.id
          AND (split_shipment.id IS NULL OR split_item.qty < 0
            OR split_item.order_item_id IS DISTINCT FROM shipment_item.order_item_id
            OR split_item.replacement_for_order_item_id IS DISTINCT FROM shipment_item.replacement_for_order_item_id
            OR split_item.correction_for_shipment_item_id IS DISTINCT FROM shipment_item.correction_for_shipment_item_id
            OR split_item.shipment_item_purpose IS DISTINCT FROM shipment_item.shipment_item_purpose
            OR split_item.product_variant_id IS DISTINCT FROM shipment_item.product_variant_id
            OR split_shipment.order_id IS DISTINCT FROM (
              SELECT parent.order_id FROM wms.outbound_shipments AS parent WHERE parent.id = shipment_item.shipment_id
            ))
      ) AS partition_lineage_valid,
      shipment_item.qty::bigint + COALESCE((
        SELECT SUM(split_item.qty)::bigint FROM wms.outbound_shipment_items AS split_item
        WHERE split_item.split_root_shipment_item_id = shipment_item.id
          AND split_item.id <> shipment_item.id
      ), 0::bigint) AS partitioned_quantity,
      CASE WHEN shipment_item.commercial_requested_qty IS NOT NULL OR EXISTS (
        SELECT 1 FROM wms.outbound_shipment_items AS split_item
        WHERE split_item.split_root_shipment_item_id = shipment_item.id
          AND split_item.id <> shipment_item.id AND split_item.commercial_requested_qty IS NOT NULL
      ) THEN COALESCE(shipment_item.commercial_requested_qty, shipment_item.qty)::bigint + COALESCE((
        SELECT SUM(COALESCE(split_item.commercial_requested_qty, split_item.qty))::bigint
        FROM wms.outbound_shipment_items AS split_item
        WHERE split_item.split_root_shipment_item_id = shipment_item.id AND split_item.id <> shipment_item.id
      ), 0::bigint) ELSE NULL END AS commercial_requested_quantity,
      shipment_item.shipment_item_purpose, shipment_item.order_item_id,
      shipment_item.replacement_for_order_item_id, shipment_item.correction_for_shipment_item_id,
      shipment_item.product_variant_id, order_item.sku AS order_item_sku,
      replacement_item.sku AS replacement_order_item_sku, variant.sku AS product_variant_sku
    FROM wms.outbound_shipment_items AS shipment_item
    LEFT JOIN wms.package_allocation_source_lines AS registered
      ON registered.source_wms_shipment_item_id = shipment_item.id
    LEFT JOIN wms.shipment_request_items AS request_item ON request_item.legacy_wms_shipment_item_id = shipment_item.id
    LEFT JOIN wms.order_items AS order_item ON order_item.id = shipment_item.order_item_id
    LEFT JOIN wms.order_items AS replacement_item ON replacement_item.id = shipment_item.replacement_for_order_item_id
    LEFT JOIN catalog.product_variants AS variant ON variant.id = shipment_item.product_variant_id
    WHERE shipment_item.id = ANY(${sqlIntegerArray(ids)})
    ORDER BY shipment_item.id ${lockRows ? sql`FOR UPDATE OF shipment_item` : sql``}`;
}

export function parsePackageAllocationSourceFactsRows(rawRows: readonly Record<string, unknown>[]): readonly PackageAllocationSourceFacts[] {
  return Object.freeze(rawRows.map(row => {
    const sourceId = Number(row.source_wms_shipment_item_id);
    if (row.partition_lineage_valid !== true) throw new PackageAllocationSourceIdentityError(
      "SOURCE_LINEAGE_INVALID", "Compatibility portions do not belong to the exact source line", { sourceWmsShipmentItemId: sourceId },
    );
    const parsed = packageAllocationSourceFactsSchema.safeParse({
      sourceWmsShipmentItemId: sourceId,
      shipmentRequestItemId: row.shipment_request_item_id == null ? null : String(row.shipment_request_item_id),
      sourceQuantity: resolvePackageAllocationSourceQuantity({
        sourceWmsShipmentItemId: sourceId,
        partitionedQuantity: Number(row.partitioned_quantity),
        registeredQuantity: row.registered_quantity == null ? null : Number(row.registered_quantity),
      }),
      ...(row.commercial_requested_quantity == null ? {} : { commercialRequestedQuantity: Number(row.commercial_requested_quantity) }),
      shipmentItemPurpose: row.shipment_item_purpose,
      orderItemId: row.order_item_id,
      replacementForOrderItemId: row.replacement_for_order_item_id,
      correctionForShipmentItemId: row.correction_for_shipment_item_id,
      productVariantId: row.product_variant_id,
      orderItemSku: row.order_item_sku,
      replacementOrderItemSku: row.replacement_order_item_sku,
      productVariantSku: row.product_variant_sku,
    });
    if (!parsed.success) throw new PackageAllocationSourceIdentityError(
      "INVALID_SOURCE_FACTS", "Persisted source facts are invalid", { sourceWmsShipmentItemId: sourceId, issues: parsed.error.issues },
    );
    return Object.freeze(parsed.data);
  }));
}

export async function readPackageAllocationSourceFacts(
  tx: { execute(query: SQL): Promise<unknown> }, sourceIds: readonly number[],
): Promise<readonly PackageAllocationSourceFacts[]> {
  const ids = validatedSourceIds(sourceIds);
  if (ids.length === 0) return Object.freeze([]);
  const result = queryResultSchema.safeParse(await tx.execute(packageAllocationSourceFactsQuery(ids, false)));
  if (!result.success) throw new PackageAllocationSourceIdentityError(
    "INVALID_SOURCE_FACTS", "Source query returned invalid evidence", { sourceIds: ids, issues: result.error.issues },
  );
  const rawRows = result.data.rows;
  const expectedIds = new Set(ids);
  if (rawRows.length !== expectedIds.size
    || new Set(rawRows.map(row => Number(row.source_wms_shipment_item_id))).size !== expectedIds.size
    || rawRows.some(row => !expectedIds.has(Number(row.source_wms_shipment_item_id)))) {
    throw new PackageAllocationSourceIdentityError("INVALID_SOURCE_FACTS", "Source evidence is missing or ambiguous", { sourceIds });
  }
  return parsePackageAllocationSourceFactsRows(rawRows);
}
