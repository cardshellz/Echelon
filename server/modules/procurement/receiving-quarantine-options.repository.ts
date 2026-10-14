import { sql } from "drizzle-orm";
import { z } from "zod";
import { receivingQuarantineAcceptanceOptionsSchema } from "@shared/procurement/receiving-quarantine";
import { readCommandAuthorityActor } from "../identity/infrastructure/command-authority.repository";
import { canResolveCustody, readCustodyReceipt, type CustodyTransaction } from "./receiving-quarantine.repository";
import { ReceivingQuarantineError } from "./domain/receiving-quarantine";
import { receivingQuarantineSourceVersion } from "./receiving-quarantine-receiving.port";

export const custodyOptionsQuerySchema = z.object({
  q: z.string().trim().max(100).default(""),
  cursor: z.coerce.number().int().positive().max(2_147_483_647).optional(),
}).strict();
const id = z.number().int().positive();
const rowSchema = z.object({
  id, receivingOrderId: id, receiptNumber: z.string(), productId: id, productVariantId: id,
  sku: z.string().nullable(), productName: z.string().nullable(), unitsPerVariantSnapshot: id,
  purchaseOrderLineId: id.nullable(), inboundShipmentLineId: id.nullable(), putawayLocationId: id.nullable(),
  expectedQty: z.number().int().nonnegative(), receivedQty: z.number().int().nonnegative(), damagedQty: z.number().int().nonnegative(),
  updatedAt: z.union([z.date(), z.string()]).transform(value => new Date(value)).pipe(z.date()),
  unitCost: z.coerce.number().int().nonnegative().safe().nullable(),
  unitCostMills: z.coerce.number().int().nonnegative().safe().nullable(),
  costSourceKind: z.string().nullable(), costSourceEvidence: z.unknown(),
});
const PAGE_SIZE = 50;
/** Choose an existing receiving source, never fabricate cost or ownership from
 * a catalog search. The command pins this exact line and its unit revision. */
export async function readQuarantineAcceptanceOptions(tx: CustodyTransaction, receiptId: number, actorId: string, rawQuery: unknown) {
  const query = custodyOptionsQuerySchema.parse(rawQuery);
  if (!canResolveCustody(await readCommandAuthorityActor(tx, actorId))) throw new ReceivingQuarantineError(
    "RECEIVING_CUSTODY_FORBIDDEN", "A purchasing approver is required to prepare acceptance.", 403);
  const receipt = await readCustodyReceipt(tx, receiptId);
  if (!receipt.warehouseId) return receivingQuarantineAcceptanceOptionsSchema.parse({ items: [], nextCursor: null });
  // Escape SQL LIKE metacharacters: the operator's search is literal text.
  const search = "%" + query.q.replace(/[\\%_]/g, match => "\\" + match) + "%";
  // Drizzle decodes timestamp-without-zone as UTC. Make that convention
  // explicit in this raw query so the source hash is independent of host TZ.
  const rows = z.array(rowSchema).parse((await tx.execute(sql`
    SELECT l.id,l.receiving_order_id AS "receivingOrderId",r.receipt_number AS "receiptNumber",l.product_id AS "productId",
      l.product_variant_id AS "productVariantId",l.sku,l.product_name AS "productName",l.units_per_variant_snapshot AS "unitsPerVariantSnapshot",
      l.purchase_order_line_id AS "purchaseOrderLineId",l.inbound_shipment_line_id AS "inboundShipmentLineId",l.putaway_location_id AS "putawayLocationId",
      l.expected_qty AS "expectedQty",l.received_qty AS "receivedQty",l.damaged_qty AS "damagedQty",l.updated_at AT TIME ZONE 'UTC' AS "updatedAt",
      l.unit_cost AS "unitCost",l.unit_cost_mills AS "unitCostMills",l.cost_source_kind AS "costSourceKind",l.cost_source_evidence AS "costSourceEvidence"
    FROM procurement.receiving_lines l JOIN procurement.receiving_orders r ON r.id=l.receiving_order_id
    WHERE r.warehouse_id=${receipt.warehouseId} AND r.status<>'cancelled'
      AND (r.id=${receiptId} OR r.status IN ('draft','open','receiving','verified'))
      AND l.product_id IS NOT NULL AND l.product_variant_id IS NOT NULL AND l.units_per_variant_snapshot>0
      AND l.id>${query.cursor ?? 0}
      AND (${query.q}='' OR l.sku ILIKE ${search} OR l.product_name ILIKE ${search} OR r.receipt_number ILIKE ${search})
      AND NOT EXISTS(SELECT 1 FROM procurement.receiving_quarantine_acceptances a WHERE a.receiving_line_id=l.id)
    ORDER BY l.id LIMIT ${PAGE_SIZE + 1}`)).rows);
  return receivingQuarantineAcceptanceOptionsSchema.parse({ items: rows.slice(0, PAGE_SIZE).map(row => ({
    receivingLineId: row.id, unitVersion: receivingQuarantineSourceVersion(row),
    targetReceivingOrderId: row.receivingOrderId === receiptId ? null : row.receivingOrderId,
    receiptNumber: row.receiptNumber, productId: row.productId, productVariantId: row.productVariantId,
    sku: row.sku, productName: row.productName || row.sku || `Product ${row.productId}`,
    unitsPerVariant: row.unitsPerVariantSnapshot, purchaseOrderLineId: row.purchaseOrderLineId,
    inboundShipmentLineId: row.inboundShipmentLineId, putawayLocationId: row.putawayLocationId,
  })), nextCursor: rows.length > PAGE_SIZE ? rows[PAGE_SIZE - 1].id : null });
}
