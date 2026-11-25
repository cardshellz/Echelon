import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { assertReceivingLocations, resolveReceivingSources, type ReceivingSourceLine } from "../domain/receiving-close-integrity.domain";

export interface ReceivingIntegrityTransaction { execute(query: SQL): Promise<{ rows: unknown[] }> }
const id = z.number().int().positive();
const quantity = z.number().int().nonnegative();
const purchaseLine = z.object({ id, purchaseOrderId: id, productId: id.nullable(), lineType: z.string(), status: z.string(),
  orderQty: quantity, receivedQty: quantity, cancelledQty: quantity });
const shipmentLine = z.object({ id, inboundShipmentId: id, purchaseOrderId: id.nullable(), purchaseOrderLineId: id.nullable() });

/** Caller owns cost graph, receipt and ordered PO locks. Resolve before physical
 * writes; SHARE locks pin shipment ownership through the same commit. */
export async function readReceivingSourceResolution(tx: ReceivingIntegrityTransaction, input: {
  receivingOrderId: number; purchaseOrderId: number | null; inboundShipmentId: number | null; lines: readonly ReceivingSourceLine[];
}) {
  const po = input.purchaseOrderId ? (await tx.execute(sql`SELECT status FROM procurement.purchase_orders WHERE id=${input.purchaseOrderId} FOR SHARE`)).rows : [];
  const purchaseLines = input.purchaseOrderId ? z.array(purchaseLine).parse((await tx.execute(sql`
    SELECT id,purchase_order_id AS "purchaseOrderId",product_id AS "productId",line_type AS "lineType",status,
      order_qty AS "orderQty",received_qty AS "receivedQty",cancelled_qty AS "cancelledQty"
    FROM procurement.purchase_order_lines WHERE purchase_order_id=${input.purchaseOrderId} ORDER BY id FOR SHARE`)).rows) : [];
  const shipment = input.inboundShipmentId ? (await tx.execute(sql`SELECT status FROM procurement.inbound_shipments WHERE id=${input.inboundShipmentId} FOR SHARE`)).rows : [];
  const shipmentLines = input.inboundShipmentId ? z.array(shipmentLine).parse((await tx.execute(sql`
    SELECT id,inbound_shipment_id AS "inboundShipmentId",purchase_order_id AS "purchaseOrderId",purchase_order_line_id AS "purchaseOrderLineId"
    FROM procurement.inbound_shipment_lines WHERE inbound_shipment_id=${input.inboundShipmentId} ORDER BY id FOR SHARE`)).rows) : [];
  const status = z.array(z.object({ status: z.string() })).max(1);
  return resolveReceivingSources({ ...input, purchaseStatus: status.parse(po)[0]?.status ?? null,
    shipmentStatus: status.parse(shipment)[0]?.status ?? null, purchaseLines, shipmentLines });
}

export async function validateReceivingLocations(tx: ReceivingIntegrityTransaction, input: {
  receivingOrderId: number; warehouseId: number | null;
  references: readonly { receivingLineId?: number; locationId: number }[];
  allowQuarantine?: boolean;
}): Promise<void> {
  const warehouses = input.warehouseId ? z.array(z.object({ isActive: z.number().int() })).max(1).parse((await tx.execute(sql`
    SELECT is_active AS "isActive" FROM warehouse.warehouses WHERE id=${input.warehouseId} FOR SHARE`)).rows) : [];
  const ids = [...new Set(input.references.map((reference) => reference.locationId))].sort((a, b) => a-b);
  const locations = ids.length ? z.array(z.object({
    id,
    warehouseId: id,
    isActive: z.number().int(),
    locationType: z.string().nullable().optional(),
  })).parse((await tx.execute(sql`
    SELECT id,warehouse_id AS "warehouseId",is_active AS "isActive",location_type AS "locationType" FROM warehouse.warehouse_locations
    WHERE id IN (${sql.join(ids.map((value) => sql`${value}`), sql`,`)}) ORDER BY id FOR SHARE`)).rows) : [];
  assertReceivingLocations({ ...input, warehouseActive: warehouses[0]?.isActive ?? null, locations });
}

export async function readDefaultWarehouseReceivingDock(
  tx: ReceivingIntegrityTransaction,
  warehouseId: number | null | undefined,
  lock = false,
): Promise<number | null> {
  if (!warehouseId) return null;
  const query = lock
    ? sql`
        SELECT id
        FROM warehouse.warehouse_locations
        WHERE warehouse_id = ${warehouseId}
          AND is_active = 1
          AND location_type = 'receiving'
        ORDER BY
          CASE
            WHEN UPPER(code) = 'RCV-DOCK' THEN 0
            WHEN UPPER(code) LIKE 'RCV%' OR UPPER(code) LIKE 'DOCK%' THEN 1
            ELSE 2
          END,
          id ASC
        LIMIT 1
        FOR SHARE
      `
    : sql`
        SELECT id
        FROM warehouse.warehouse_locations
        WHERE warehouse_id = ${warehouseId}
          AND is_active = 1
          AND location_type = 'receiving'
        ORDER BY
          CASE
            WHEN UPPER(code) = 'RCV-DOCK' THEN 0
            WHEN UPPER(code) LIKE 'RCV%' OR UPPER(code) LIKE 'DOCK%' THEN 1
            ELSE 2
          END,
          id ASC
        LIMIT 1
      `;
  const result = await tx.execute(query);
  const first = result.rows?.[0] as { id?: unknown } | undefined;
  const parsed = Number(first?.id);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export async function readReceivingLocationTypes(
  tx: ReceivingIntegrityTransaction,
  locationIds: readonly number[],
): Promise<Map<number, string | null>> {
  const ids = [...new Set(locationIds.filter((val) => Number.isInteger(val) && val > 0))].sort((a, b) => a - b);
  if (ids.length === 0) return new Map();
  const result = await tx.execute(sql`
    SELECT id, location_type AS "locationType"
    FROM warehouse.warehouse_locations
    WHERE id IN (${sql.join(ids.map((val) => sql`${val}`), sql`,`)})
  `);
  const map = new Map<number, string | null>();
  for (const row of result.rows ?? []) {
    const typed = row as { id?: unknown; locationType?: unknown };
    const locId = Number(typed.id);
    if (Number.isInteger(locId) && locId > 0) {
      map.set(locId, typeof typed.locationType === "string" ? typed.locationType : null);
    }
  }
  return map;
}

/** Location defaults are advisory, but their variant and destination must be
 * pinned to the same receipt-creation transaction. Select a stable primary when
 * legacy data contains multiple primary slots in the requested warehouse. */
export async function readPrimaryReceivingLocations(tx: ReceivingIntegrityTransaction,
  warehouseId: number | null | undefined, variantIds: readonly number[]): Promise<Map<number, number>> {
  const ids = [...new Set(variantIds)].sort((a,b) => a-b);
  if (!warehouseId || ids.length === 0) return new Map();
  const rows = z.array(z.object({ productVariantId: id, warehouseLocationId: id })).parse((await tx.execute(sql`
    SELECT assignment.product_variant_id AS "productVariantId",location.id AS "warehouseLocationId"
    FROM warehouse.product_locations assignment
    JOIN warehouse.warehouse_locations location ON location.id=assignment.warehouse_location_id
    JOIN warehouse.warehouses warehouse ON warehouse.id=location.warehouse_id
    WHERE assignment.product_variant_id IN (${sql.join(ids.map((value) => sql`${value}`), sql`,`)})
      AND assignment.status='active' AND assignment.is_primary=1
      AND location.warehouse_id=${warehouseId} AND location.is_active=1 AND warehouse.is_active=1
    ORDER BY assignment.product_variant_id,location.id,assignment.id FOR SHARE OF assignment,location,warehouse`)).rows);
  const result = new Map<number, number>();
  for (const row of rows) if (!result.has(row.productVariantId)) result.set(row.productVariantId, row.warehouseLocationId);
  return result;
}
