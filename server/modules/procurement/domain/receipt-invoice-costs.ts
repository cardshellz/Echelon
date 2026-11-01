import {
  receiptInvoiceAllocationSchema,
  receiptCostingReceiptSchema,
  type ReceiptInvoiceAllocation,
  type ReceiptCostingReceipt,
} from "@shared/procurement/receipt-invoice-costs";
import {
  receiptSegmentCost,
  type ReceiptCostSegment,
} from "@shared/procurement/receipt-cost-segments";
import {
  CostEvidenceError,
  costInteger,
} from "../../inventory/infrastructure/cost-evidence-values";
import type { CostRevisionInput } from "../../inventory/infrastructure/cost-evidence.repository";
import type { SupplierCreditCostRow } from "./supplier-credit-source";

export interface ReceiptCostingEvidence {
  receipts: ReceiptCostingReceipt[];
  allocations: ReceiptInvoiceAllocation[];
}
export interface ReceiptInvoiceSource {
  purchaseOrderLine: Record<string, unknown>;
  approvedInvoices: Record<string, unknown>[];
  supplierCredits?: SupplierCreditCostRow[];
  receiptCosting?: ReceiptCostingEvidence;
}

function reject(message: string): never {
  throw new CostEvidenceError("RECEIPT_INVOICE_ALLOCATION_INVALID", message);
}
function noOverlap(
  intervals: Array<{ start: number; pieces: number }>,
  maximum: number,
  label: string,
) {
  let end = BigInt(0);
  for (const row of [...intervals].sort((a, b) => a.start - b.start)) {
    const next = BigInt(row.start) + BigInt(row.pieces);
    if (BigInt(row.start) < end || next > BigInt(maximum))
      reject(
        `${label} has overlapping or excessive piece quantities. Review its receipt and invoice assignments.`,
      );
    end = next;
  }
}

/** Validate both sides of every assignment, independent of input/arrival order.
 * These facts identify received pieces; an invoice never creates physical stock. */
export function validateReceiptInvoiceAllocations(
  source: ReceiptInvoiceSource,
  rows: readonly ReceiptInvoiceAllocation[],
) {
  const scope = costInteger(
    source.purchaseOrderLine.order_qty,
    "ordered pieces",
    1,
  );
  const receipts = (source.receiptCosting?.receipts ?? []).map((row) =>
    receiptCostingReceiptSchema.parse(row),
  );
  if (
    new Set(receipts.map((row) => row.receivingLineId)).size !== receipts.length
  )
    reject("A receipt line appears more than once.");
  noOverlap(
    receipts.map((row) => ({ start: row.startBasePiece, pieces: row.pieces })),
    scope,
    "Recorded receiving",
  );
  const parsed = rows.map((row) => receiptInvoiceAllocationSchema.parse(row));
  for (const row of parsed) {
    const receipt = receipts.find(
      (receipt) => receipt.receivingLineId === row.receivingLineId,
    );
    const invoice = source.approvedInvoices.find(
      (invoice) => Number(invoice.id) === row.invoiceLineId,
    );
    if (!receipt || !invoice)
      reject(
        "Choose a completed receipt and an approved invoice line belonging to this same PO line.",
      );
    if (
      BigInt(row.receiptStartPiece) + BigInt(row.pieces) >
        BigInt(receipt.pieces) ||
      BigInt(row.invoiceStartPiece) + BigInt(row.pieces) >
        BigInt(costInteger(invoice.qty_invoiced, "invoice pieces", 1))
    )
      reject("An assignment exceeds its received or invoiced quantity.");
  }
  for (const receipt of receipts)
    noOverlap(
      parsed
        .filter((row) => row.receivingLineId === receipt.receivingLineId)
        .map((row) => ({ start: row.receiptStartPiece, pieces: row.pieces })),
      receipt.pieces,
      receipt.receiptNumber,
    );
  for (const invoice of source.approvedInvoices)
    noOverlap(
      parsed
        .filter((row) => row.invoiceLineId === Number(invoice.id))
        .map((row) => ({ start: row.invoiceStartPiece, pieces: row.pieces })),
      costInteger(invoice.qty_invoiced, "invoice pieces", 1),
      `Invoice line ${invoice.id}`,
    );
  return parsed.sort(
    (a, b) =>
      a.receivingLineId - b.receivingLineId ||
      a.receiptStartPiece - b.receiptStartPiece,
  );
}

/** Existing invoice/tax validation supplies amounts; this owner changes only
 * their explicit quantity destinations. No PO-wide average is introduced. */
export function resolveReceiptInvoiceSources(
  source: ReceiptInvoiceSource,
  legacy: (source: ReceiptInvoiceSource) => CostRevisionInput[],
): CostRevisionInput[] {
  const quote = legacy({
    purchaseOrderLine: { ...source.purchaseOrderLine, status: "open" },
    approvedInvoices: [],
  });
  if (source.supplierCredits?.length)
    reject(
      "Receipt-specific supplier credits require their original receipt attribution before costs can change.",
    );
  const allocations = validateReceiptInvoiceAllocations(
    source,
    source.receiptCosting?.allocations ?? [],
  );
  const receipts = source.receiptCosting!.receipts;
  const actual = new Map<number, CostRevisionInput[]>();
  for (const id of new Set(allocations.map((row) => row.invoiceLineId))) {
    const invoice = source.approvedInvoices.find(
      (row) => Number(row.id) === id,
    )!;
    const selected = legacy({
      purchaseOrderLine: {
        ...source.purchaseOrderLine,
        order_qty: invoice.qty_invoiced,
        received_qty: invoice.qty_invoiced,
        status: "open",
      },
      approvedInvoices: [invoice],
    });
    if (
      selected.some(
        (row) => row.evidence !== "confirmed" || row.currency !== "USD",
      )
    )
      reject(
        `Review product, packaging, tax and currency on invoice line ${id} before assigning it to receipts.`,
      );
    actual.set(id, selected);
  }
  return quote.map((quoted) => {
    if (
      !["product", "packaging"].includes(quoted.component) ||
      quoted.totalMills === null ||
      quoted.basePieces === null
    )
      reject("The uninvoiced pieces need a supported provisional USD PO cost.");
    const segments: ReceiptCostSegment[] = [];
    let cursor = 0;
    const mapped = allocations
      .map((row) => ({
        row,
        start:
          receipts.find(
            (receipt) => receipt.receivingLineId === row.receivingLineId,
          )!.startBasePiece + row.receiptStartPiece,
      }))
      .sort((a, b) => a.start - b.start);
    const provisional = (end: number) => {
      if (end > cursor)
        segments.push({
          startBasePiece: cursor,
          pieces: end - cursor,
          receivingLineId: null,
          invoiceLineId: null,
          sourceStartPiece: cursor,
          sourceBasePieces: quoted.basePieces!,
          sourceTotalMills: quoted.totalMills!,
          evidence: "estimated",
        });
    };
    for (const { row, start } of mapped) {
      provisional(start);
      const selected = actual
        .get(row.invoiceLineId)!
        .find((item) => item.component === quoted.component)!;
      segments.push({
        startBasePiece: start,
        pieces: row.pieces,
        receivingLineId: row.receivingLineId,
        invoiceLineId: row.invoiceLineId,
        sourceStartPiece: row.invoiceStartPiece,
        sourceBasePieces: selected.basePieces!,
        sourceTotalMills: selected.totalMills!,
        evidence: "confirmed",
      });
      cursor = start + row.pieces;
    }
    provisional(quoted.basePieces);
    const projected = receiptSegmentCost(segments, 0, quoted.basePieces);
    if (
      projected.provisionalPieces > 0 &&
      (quoted.evidence !== "estimated" || quoted.currency !== "USD")
    )
      reject("The uninvoiced pieces need a supported provisional USD PO cost.");
    const references = [...actual.values()].flatMap(
      (inputs) =>
        inputs.find((item) => item.component === quoted.component)!.sources,
    );
    if (projected.provisionalPieces > 0) references.push(...quoted.sources);
    return {
      ...quoted,
      currency: "USD",
      issue: null,
      totalMills: projected.totalMills,
      receiptCostSegments: segments,
      evidence:
        projected.provisionalPieces > 0
          ? ("estimated" as const)
          : ("confirmed" as const),
      sources: [
        ...new Map(
          references.map((row) => [
            `${row.kind}:${row.documentId}:${row.lineId}`,
            row,
          ]),
        ).values(),
      ],
    };
  });
}
