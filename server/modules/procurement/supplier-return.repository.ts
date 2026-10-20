import { sql } from "drizzle-orm";
import { z } from "zod";
import { supplierReturnStockPreviewLineSchema, type SupplierReturnRecordInput, type SupplierReturnStockPreview } from "@shared/procurement/supplier-return";
import { canonicalJson } from "@shared/utils/canonical-json";
import { SupplierReturnError } from "./supplier-return.errors";
import type { db } from "../../db";

export type SupplierReturnTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
const id = z.coerce.number().int().positive().safe();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const headerSchema = z.object({
  id, vendor_id: id, vendor_name: z.string(), supplier_reference: z.string().nullable(), return_calendar_date: z.string(),
  evidence_reference: z.string().min(1), reason: z.string().min(3), source_fingerprint: hash, request_fingerprint: hash,
  command_key: z.string().min(1), recorded_by: z.string().min(1), recorded_at: z.coerce.date(),
});
const lineSchema = z.object({
  id, supplier_return_id: id, inventory_lot_id: id, inventory_level_id: id, warehouse_location_id: id, warehouse_id: id,
  product_id: id, product_variant_id: id, purchase_order_id: id, purchase_order_line_id: id,
  receiving_order_id: id, receiving_line_id: id, origin_lot_id: id,
  quantity: id, units_per_variant: id, base_pieces: id, source_snapshot: supplierReturnStockPreviewLineSchema,
}).superRefine((row, context) => {
  const source = row.source_snapshot;
  const origin = source.sourceProof.origin;
  const identities = [
    [row.inventory_lot_id, source.inventoryLotId], [row.inventory_level_id, source.inventoryLevelId],
    [row.warehouse_location_id, source.warehouseLocationId], [row.warehouse_id, source.warehouseId],
    [row.product_id, source.productId], [row.product_variant_id, source.productVariantId],
    [row.purchase_order_id, origin.purchaseOrderId], [row.purchase_order_line_id, origin.purchaseOrderLineId],
    [row.receiving_order_id, origin.receivingOrderId], [row.receiving_line_id, origin.receivingLineId],
    [row.origin_lot_id, origin.inventoryLotId], [row.quantity, source.quantity],
    [row.units_per_variant, source.unitsPerVariant], [row.base_pieces, source.basePieces],
  ];
  if (identities.some(([saved, frozen]) => saved !== frozen)) {
    context.addIssue({ code: "custom", message: "Recorded return line differs from its immutable reviewed source." });
  }
});
const reportSchema = z.object({ supplier_return_id: id, contract_version: z.number().int(), payload: z.unknown() });
export type SupplierReturnReportRow = z.infer<typeof reportSchema>;
export type SupplierReturnHeader = z.infer<typeof headerSchema>;
export type SupplierReturnLine = z.infer<typeof lineSchema>;

/** Called only by the inventory owner after its current-source locks and proof.
 * The document, physical outflow, value ledger and outer audit share one TX. */
export async function insertSupplierReturnDocument(tx: SupplierReturnTransaction, input: {
  request: SupplierReturnRecordInput; preview: SupplierReturnStockPreview;
  actorId: string; at: Date; commandKey: string; requestFingerprint: string;
}) {
  const { request, preview } = input;
  if (preview.vendorId !== request.vendorId || preview.sourceFingerprint !== request.expectedSourceFingerprint) {
    throw new SupplierReturnError("SUPPLIER_RETURN_STALE", "The current source differs from the reviewed return. Review it again.");
  }
  const header = await tx.execute(sql`INSERT INTO procurement.supplier_returns
    (vendor_id,supplier_reference,return_calendar_date,evidence_reference,reason,source_fingerprint,request_fingerprint,command_key,recorded_by,recorded_at)
    VALUES(${request.vendorId},${request.supplierReference ?? null},${request.returnCalendarDate}::date,${request.evidenceReference},${request.reason},
      ${preview.sourceFingerprint},${input.requestFingerprint},${input.commandKey},${input.actorId},${input.at}) RETURNING id`);
  const returnId = id.parse(header.rows[0]?.id);
  const values = preview.lines.map(source => {
    const origin = source.sourceProof.origin;
    return sql`(${returnId},${source.inventoryLotId},${source.inventoryLevelId},${source.warehouseLocationId},${source.warehouseId},
      ${source.productId},${source.productVariantId},${origin.purchaseOrderId},${origin.purchaseOrderLineId},${origin.receivingOrderId},
      ${origin.receivingLineId},${origin.inventoryLotId},${source.quantity},${source.unitsPerVariant},${source.basePieces},${canonicalJson(source)}::jsonb)`;
  });
  const lines = await tx.execute(sql`INSERT INTO procurement.supplier_return_lines
    (supplier_return_id,inventory_lot_id,inventory_level_id,warehouse_location_id,warehouse_id,product_id,product_variant_id,
      purchase_order_id,purchase_order_line_id,receiving_order_id,receiving_line_id,origin_lot_id,quantity,units_per_variant,base_pieces,source_snapshot)
    VALUES ${sql.join(values, sql`, `)} RETURNING id,inventory_lot_id,quantity`);
  return { returnId, returnLines: lines.rows.map(row => ({ id: id.parse(row.id), inventoryLotId: id.parse(row.inventory_lot_id), quantity: id.parse(row.quantity) })) };
}

export async function readSupplierReturnRecords(tx: SupplierReturnTransaction, rawIds: readonly number[]) {
  const ids = [...new Set(rawIds.map(value => id.parse(value)))].sort((a, b) => a - b);
  if (ids.length > 100) throw new SupplierReturnError("SUPPLIER_RETURN_READ_LIMIT", "Filter the return list to at most 100 documents.");
  if (ids.length === 0) return { headers: [] as SupplierReturnHeader[], lines: [] as SupplierReturnLine[], reports: [] as SupplierReturnReportRow[] };
  const headers = (await tx.execute(sql`SELECT document.*,vendor.name AS vendor_name FROM procurement.supplier_returns document
    JOIN procurement.vendors vendor ON vendor.id=document.vendor_id WHERE document.id=ANY(${sql.param(ids)}::int[]) ORDER BY document.id DESC`)).rows.map(row => headerSchema.parse(row));
  if (headers.length !== ids.length) throw new SupplierReturnError("SUPPLIER_RETURN_NOT_FOUND", "One or more supplier returns are unavailable.", 404);
  const rawLines = (await tx.execute(sql`SELECT * FROM procurement.supplier_return_lines
    WHERE supplier_return_id=ANY(${sql.param(ids)}::int[]) ORDER BY supplier_return_id,id LIMIT 10001`)).rows;
  if (rawLines.length > 10000) throw new SupplierReturnError("SUPPLIER_RETURN_READ_LIMIT", "Filter the return list to reduce its line count.");
  const lines = rawLines.map(row => lineSchema.parse(row));
  if (headers.some(header => !lines.some(line => line.supplier_return_id === header.id))) throw new Error("Recorded supplier return has no immutable source lines");
  const reports = (await tx.execute(sql`SELECT supplier_return_id,contract_version,payload FROM procurement.supplier_return_reporting_events
    WHERE supplier_return_id=ANY(${sql.param(ids)}::int[]) ORDER BY supplier_return_id`)).rows.map(row => reportSchema.parse(row));
  return { headers, lines, reports };
}

export async function listSupplierReturnIds(tx: SupplierReturnTransaction, query: {
  vendorId?: number; purchaseOrderId?: number; receivingOrderId?: number; afterId?: number; limit: number;
}) {
  const conditions = [sql`true`];
  if (query.vendorId !== undefined) conditions.push(sql`document.vendor_id=${query.vendorId}`);
  if (query.afterId !== undefined) conditions.push(sql`document.id<${query.afterId}`);
  if (query.purchaseOrderId !== undefined) conditions.push(sql`EXISTS(SELECT 1 FROM procurement.supplier_return_lines line
    WHERE line.supplier_return_id=document.id AND line.purchase_order_id=${query.purchaseOrderId})`);
  if (query.receivingOrderId !== undefined) conditions.push(sql`EXISTS(SELECT 1 FROM procurement.supplier_return_lines line
    WHERE line.supplier_return_id=document.id AND line.receiving_order_id=${query.receivingOrderId})`);
  const rows = (await tx.execute(sql`SELECT document.id FROM procurement.supplier_returns document
    WHERE ${sql.join(conditions, sql` AND `)} ORDER BY document.id DESC LIMIT ${query.limit + 1}`)).rows;
  const ids = rows.slice(0, query.limit).map(row => id.parse(row.id));
  return { ids, nextAfterId: rows.length > query.limit ? ids.at(-1)! : null };
}
