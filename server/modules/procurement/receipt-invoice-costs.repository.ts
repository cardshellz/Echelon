import { sql } from "drizzle-orm";
import { canonicalJson } from "@shared/utils/canonical-json";
import {
  receiptCostingReceiptSchema,
  receiptInvoiceAllocationSchema,
  type ReceiptInvoiceAllocation,
} from "@shared/procurement/receipt-invoice-costs";
import {
  CostEvidenceError,
  costInteger,
  type CostEvidenceTransaction,
} from "../inventory/infrastructure/cost-evidence.repository";
import type { ReceiptCostingEvidence } from "./domain/receipt-invoice-costs";

const MAX_RECEIPT_ROOTS = 10_000;

/** Procurement records its financial continuation; inventory owns the flag
 * calculation and writes. The caller retains one transaction for both. */
export async function recordReceiptProvisionalAudit(
  tx: CostEvidenceTransaction,
  lineId: number,
  changes: readonly { lotId: number; before: unknown; after: number }[],
  supplierApplied: boolean,
  actorId: string,
  at: Date,
) {
  if (!changes.length) return;
  await tx.execute(sql`INSERT INTO public.audit_events(timestamp,level,actor,action,target,changes,context)
    VALUES(${at},'AUDIT',${actorId},'inventory.receipt_cost_provisional.updated',${`purchase_order_line:${lineId}`},
      ${canonicalJson({ before: changes.map((row) => ({ lotId: row.lotId, costProvisional: row.before })), after: changes.map((row) => ({ lotId: row.lotId, costProvisional: row.after })) })}::jsonb,${canonicalJson({ supplierApplied })}::jsonb)`);
}
/** Frozen effective origins, including approved historical repairs, are the
 * quantity evidence. Current catalog pack sizes and stock balances are not. */
export async function readReceiptCostingEvidence(
  tx: CostEvidenceTransaction,
  lineId: number,
): Promise<ReceiptCostingEvidence> {
  const roots = (
    await tx.execute(sql`SELECT origin.*,receipt.id AS receipt_id,receipt.receipt_number,
    line.units_per_variant_snapshot AS receive_units,line.received_qty,line.reversed_qty
    FROM inventory.effective_lot_cost_origins origin
    JOIN procurement.receiving_lines line ON line.id=origin.receiving_line_id
    JOIN procurement.receiving_orders receipt ON receipt.id=line.receiving_order_id
    WHERE origin.purchase_order_line_id=${lineId} AND line.purchase_order_line_id=${lineId} AND receipt.status='closed'
    ORDER BY origin.purchase_start_base_piece,origin.inventory_lot_id LIMIT ${MAX_RECEIPT_ROOTS + 1}`)
  ).rows;
  if (roots.length > MAX_RECEIPT_ROOTS)
    throw new CostEvidenceError(
      "RECEIPT_COST_LIMIT",
      "The full receipt cost review exceeds its supported size. No partial assignment was saved.",
    );
  const receipts: ReceiptCostingEvidence["receipts"] = [];
  for (const id of new Set(
    roots.map((row) =>
      costInteger(row.receiving_line_id, "receivingLineId", 1),
    ),
  )) {
    const rows = roots.filter((row) => Number(row.receiving_line_id) === id),
      first = rows[0];
    const start = costInteger(first.purchase_start_base_piece, "receipt start"),
      units = costInteger(first.receive_units, "saved receive units", 1);
    let end = BigInt(start);
    for (const row of rows) {
      if (
        BigInt(costInteger(row.purchase_start_base_piece, "origin start")) !==
          end ||
        costInteger(row.units_per_variant_snapshot, "origin units", 1) !==
          units ||
        costInteger(row.reversed_qty, "reversed pieces") !== 0
      )
        throw new CostEvidenceError(
          "RECEIPT_COST_HISTORY_REVIEW",
          `Receipt ${first.receipt_number} has changed or incomplete piece history. Review its quantity correction or reversal before assigning invoice costs.`,
        );
      end +=
        BigInt(
          costInteger(row.received_variant_qty, "original receive count", 1),
        ) * BigInt(units);
    }
    const pieces = costInteger(
      (end - BigInt(start)).toString(),
      "receipt pieces",
      1,
    );
    if (
      BigInt(pieces) !==
      BigInt(costInteger(first.received_qty, "received count", 1)) *
        BigInt(units)
    )
      throw new CostEvidenceError(
        "RECEIPT_COST_HISTORY_REVIEW",
        `Receipt ${first.receipt_number} has stock without complete cost-origin coverage. Repair its cost links before assigning an invoice.`,
      );
    receipts.push(
      receiptCostingReceiptSchema.parse({
        receivingLineId: id,
        receiptId: costInteger(first.receipt_id, "receipt id", 1),
        receiptNumber: first.receipt_number,
        inboundShipmentLineId:
          first.inbound_shipment_line_id == null
            ? null
            : costInteger(first.inbound_shipment_line_id, "shipment line", 1),
        startBasePiece: start,
        pieces,
      }),
    );
  }
  const rows = (
    await tx.execute(sql`SELECT receiving_line_id AS "receivingLineId",invoice_line_id AS "invoiceLineId",
    receipt_start_piece AS "receiptStartPiece",invoice_start_piece AS "invoiceStartPiece",pieces
    FROM procurement.receipt_invoice_cost_allocations WHERE purchase_order_line_id=${lineId}
    ORDER BY receiving_line_id,receipt_start_piece LIMIT 501`)
  ).rows;
  if (rows.length > 500)
    throw new CostEvidenceError(
      "RECEIPT_COST_LIMIT",
      "This purchase line exceeds the complete assignment limit.",
    );
  return {
    receipts,
    allocations: rows.map((row) =>
      receiptInvoiceAllocationSchema.parse({
        ...row,
        receiptStartPiece: costInteger(row.receiptStartPiece, "receipt start"),
        invoiceStartPiece: costInteger(row.invoiceStartPiece, "invoice start"),
        pieces: costInteger(row.pieces, "allocated pieces", 1),
      }),
    ),
  };
}

/** The caller owns the shared graph/document locks and approved transaction. */
export async function persistReceiptInvoiceAllocations(
  tx: CostEvidenceTransaction,
  lineId: number,
  rows: readonly ReceiptInvoiceAllocation[],
  actorId: string,
  at: Date,
) {
  await tx.execute(
    sql`UPDATE procurement.purchase_order_lines SET receipt_costing_enabled=1 WHERE id=${lineId}`,
  );
  await tx.execute(
    sql`DELETE FROM procurement.receipt_invoice_cost_allocations WHERE purchase_order_line_id=${lineId}`,
  );
  for (const row of rows)
    await tx.execute(sql`INSERT INTO procurement.receipt_invoice_cost_allocations
    (purchase_order_line_id,receiving_line_id,invoice_line_id,receipt_start_piece,invoice_start_piece,pieces,approved_by,approved_at)
    VALUES (${lineId},${row.receivingLineId},${row.invoiceLineId},${row.receiptStartPiece},${row.invoiceStartPiece},${row.pieces},${actorId},${at})`);
}

export async function recordReceiptInvoiceApproval(
  tx: CostEvidenceTransaction,
  poId: number,
  lineId: number,
  preview: unknown,
  actorId: string,
  actorName: string,
  reason: string,
  at: Date,
  commandKey: string,
  applications: unknown,
  authority: unknown,
) {
  const audit =
    await tx.execute(sql`INSERT INTO public.audit_events(action,actor,target,changes,context,timestamp,level)
    VALUES ('procurement.receipt_invoice_costs.approved',${actorId},${`purchase_order_line:${lineId}`},
      ${canonicalJson({ preview, applications })}::jsonb,${canonicalJson({ reason, actorName, commandKey, authority })}::jsonb,${at},'AUDIT') RETURNING id`);
  const id = costInteger(audit.rows[0]?.id, "auditEventId", 1);
  await tx.execute(sql`INSERT INTO procurement.po_events(po_id,event_type,actor_type,actor_id,payload_json,created_at)
    VALUES (${poId},'receipt_invoice_costs_approved','user',${actorId},${canonicalJson({ auditEventId: id, reason, actorName, approvedAt: at.toISOString(), preview })}::jsonb,${at})`);
  return id;
}
