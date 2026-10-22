import { sql, type SQL } from "drizzle-orm";
import { relationshipSnapshotSchema, type RelationshipRoot, type RelationshipSnapshot } from "@shared/procurement/document-relationships";
import { costInteger } from "../inventory/infrastructure/cost-evidence-values";
import { readSupplierCreditCostRows } from "./supplier-credit-source.repository";
import { projectDocumentRelationshipCosts } from "./domain/document-relationship-costs";

type Row = Record<string, unknown>;
interface Reader { execute(query: SQL): Promise<{ rows: Row[] }> }
export interface RelationshipDatabase extends Reader {
  transaction<T>(read: (tx: Reader) => Promise<T>, options: { isolationLevel: "repeatable read"; accessMode: "read only" }): Promise<T>;
}
const MAX_ROWS = 10_000;
async function rows(tx: Reader, query: SQL): Promise<Row[]> {
  const result = await tx.execute(sql`${query} LIMIT ${MAX_ROWS + 1}`);
  if (result.rows.length > MAX_ROWS) throw new Error("Document relationship read exceeds its bounded scope");
  return result.rows;
}
const ids = (values: readonly number[]) => sql`IN (SELECT value::integer FROM jsonb_array_elements_text(${JSON.stringify(values)}::jsonb))`;

/** All joined quantities and costs come from one read-only snapshot. Load full
 * shipments for honest per-PO shares, never multiply totals through receipt joins. */
export function createDocumentRelationshipRepository(database: RelationshipDatabase) {
  return {
    async read(root: RelationshipRoot): Promise<RelationshipSnapshot | null> {
      return database.transaction(async tx => {
        const rootTable = root.kind === "purchase" ? sql`procurement.purchase_orders`
          : root.kind === "shipment" ? sql`procurement.inbound_shipments` : sql`procurement.receiving_orders`;
        if (!(await tx.execute(sql`SELECT id FROM ${rootTable} WHERE id=${root.id}`)).rows.length) return null;

        const shipments = await rows(tx, sql`
          SELECT s.id,s.shipment_number AS number,s.status FROM procurement.inbound_shipments s
          WHERE ${root.kind === "shipment" ? sql`s.id=${root.id}` : root.kind === "purchase" ? sql`
            EXISTS (SELECT 1 FROM procurement.inbound_shipment_lines sl
              LEFT JOIN procurement.purchase_order_lines pol ON pol.id=sl.purchase_order_line_id
              WHERE sl.inbound_shipment_id=s.id AND (sl.purchase_order_id=${root.id} OR pol.purchase_order_id=${root.id}))
            OR EXISTS (SELECT 1 FROM procurement.receiving_orders r WHERE r.inbound_shipment_id=s.id AND r.purchase_order_id=${root.id})
            OR EXISTS (SELECT 1 FROM procurement.receiving_lines rl
              JOIN procurement.receiving_orders r ON r.id=rl.receiving_order_id
              JOIN procurement.purchase_order_lines pol ON pol.id=rl.purchase_order_line_id
              LEFT JOIN procurement.inbound_shipment_lines sl ON sl.id=rl.inbound_shipment_line_id
              WHERE pol.purchase_order_id=${root.id} AND (r.inbound_shipment_id=s.id OR sl.inbound_shipment_id=s.id))`
            : sql`EXISTS (SELECT 1 FROM procurement.receiving_orders r WHERE r.id=${root.id} AND r.inbound_shipment_id=s.id)
              OR EXISTS (SELECT 1 FROM procurement.receiving_lines rl JOIN procurement.inbound_shipment_lines sl ON sl.id=rl.inbound_shipment_line_id
                WHERE rl.receiving_order_id=${root.id} AND sl.inbound_shipment_id=s.id)`}
          ORDER BY s.id`);
        const shipmentIds = shipments.map(row => costInteger(row.id, "shipmentId", 1));
        const shipmentLines = await rows(tx, sql`
          SELECT sl.id,sl.inbound_shipment_id AS "shipmentId",sl.purchase_order_id AS "purchaseId",
            sl.purchase_order_line_id AS "purchaseLineId",sl.sku,pol.product_name AS product,sl.qty_shipped AS "shippedPieces"
          FROM procurement.inbound_shipment_lines sl LEFT JOIN procurement.purchase_order_lines pol ON pol.id=sl.purchase_order_line_id
          WHERE sl.inbound_shipment_id ${ids(shipmentIds)} ORDER BY sl.id`);
        const receipts = await rows(tx, sql`
          SELECT r.id,r.receipt_number AS number,r.status,r.purchase_order_id AS "purchaseId",r.inbound_shipment_id AS "shipmentId"
          FROM procurement.receiving_orders r WHERE r.inbound_shipment_id ${ids(shipmentIds)}
            OR EXISTS (SELECT 1 FROM procurement.receiving_lines rl JOIN procurement.inbound_shipment_lines sl ON sl.id=rl.inbound_shipment_line_id
              WHERE rl.receiving_order_id=r.id AND sl.inbound_shipment_id ${ids(shipmentIds)})
            OR ${root.kind === "receipt" ? sql`r.id=${root.id}` : root.kind === "purchase" ? sql`r.purchase_order_id=${root.id}
              OR EXISTS (SELECT 1 FROM procurement.receiving_lines rl JOIN procurement.purchase_order_lines pol ON pol.id=rl.purchase_order_line_id
                WHERE rl.receiving_order_id=r.id AND pol.purchase_order_id=${root.id})` : sql`false`}
          ORDER BY r.id`);
        const receiptLines = await rows(tx, sql`
          SELECT rl.id,rl.receiving_order_id AS "receiptId",rl.purchase_order_line_id AS "purchaseLineId",
            rl.inbound_shipment_line_id AS "shipmentLineId",rl.sku,rl.received_qty AS "receivedUnits",
            rl.reversed_qty AS "reversedUnits",rl.units_per_variant_snapshot AS "piecesPerUnit"
          FROM procurement.receiving_lines rl WHERE rl.receiving_order_id ${ids(receipts.map(row => costInteger(row.id, "receiptId", 1)))} ORDER BY rl.id`);
        const poLineIds = [...new Set([...shipmentLines, ...receiptLines].flatMap(row => row.purchaseLineId === null ? [] : [costInteger(row.purchaseLineId, "purchaseLineId", 1)]))];
        const purchaseLines = await rows(tx, sql`
          SELECT id,purchase_order_id AS "purchaseId",line_number AS "lineNumber",sku,product_name AS product,order_qty AS "orderedPieces"
          FROM procurement.purchase_order_lines WHERE id ${ids(poLineIds)}
            OR ${root.kind === "purchase" ? sql`purchase_order_id=${root.id}` : sql`false`} ORDER BY purchase_order_id,line_number,id`);
        const poIds = [...new Set([...shipmentLines, ...receipts, ...purchaseLines].flatMap(row => row.purchaseId === null ? [] : [costInteger(row.purchaseId, "purchaseId", 1)]))];
        if (root.kind === "purchase") poIds.push(root.id);
        const purchases = await rows(tx, sql`SELECT id,po_number AS number FROM procurement.purchase_orders WHERE id ${ids(poIds)} ORDER BY id`);
        const charges = await rows(tx, sql`SELECT * FROM procurement.inbound_freight_costs WHERE inbound_shipment_id ${ids(shipmentIds)} ORDER BY id`);
        const costIds = charges.map(row => costInteger(row.id, "costId", 1));
        const allocations = await rows(tx, sql`SELECT a.*,sl.purchase_order_id FROM procurement.inbound_freight_allocations a
          JOIN procurement.inbound_shipment_lines sl ON sl.id=a.inbound_shipment_line_id
          WHERE a.shipment_cost_id ${ids(costIds)} ORDER BY a.id`);
        const credits = await readSupplierCreditCostRows(tx, { freightCostIds: costIds });
        const invoiceLines = credits.length ? await rows(tx, sql`
          SELECT il.*,invoice.currency,invoice.status FROM procurement.vendor_invoice_lines il
          JOIN procurement.vendor_invoices invoice ON invoice.id=il.vendor_invoice_id WHERE il.freight_cost_id ${ids(costIds)} ORDER BY il.id`) : [];
        const chargesById = new Map(charges.map(row => [Number(row.id), row]));
        const linesById = new Map(shipmentLines.map(row => [Number(row.id), row]));
        for (const allocation of allocations) {
          const line = linesById.get(Number(allocation.inbound_shipment_line_id));
          const charge = chargesById.get(Number(allocation.shipment_cost_id));
          if (!line || !charge || line.shipmentId !== charge.inbound_shipment_id) throw new Error("Allocation crosses its shipment boundary");
        }
        return relationshipSnapshotSchema.parse({ root, purchases, purchaseLines, shipments, shipmentLines, receipts, receiptLines,
          ...projectDocumentRelationshipCosts({ charges, allocations, invoices: invoiceLines, credits }),
        });
      }, { isolationLevel: "repeatable read", accessMode: "read only" });
    },
  };
}
