import type { SupplierReturnStockPreviewLine } from "@shared/procurement/supplier-return";
import { sliceCostQuantityIntervals } from "../../inventory/domain/cost-quantity-intervals";
import { costInteger, CostEvidenceError } from "../../inventory/infrastructure/cost-evidence-values";
const exactQuantity = (value: bigint, label: string) => costInteger(value.toString(), label);

type Interval = { start: number; quantity: number };
export type ReturnInvoiceAssignment = { receivingLineId: number; invoiceLineId: number; receiptStartPiece: number; invoiceStartPiece: number; pieces: number };
function merge(rows: Interval[]): Interval[] {
  const result: Interval[] = [];
  for (const row of rows.sort((a, b) => a.start - b.start)) {
    const last = result.at(-1);
    if (last && last.start + last.quantity >= row.start) last.quantity = Math.max(last.start + last.quantity, row.start + row.quantity) - last.start;
    else result.push({ ...row });
  }
  return result;
}
/** The return owner proves complete one-to-one transfer chains. Reverse those
 * recorded intervals to the original receipt, then intersect the saved invoice
 * assignments. A shared PO alone never proves which invoice supplied a return. */
export function acceptedReturnInvoiceAttribution(source: Pick<SupplierReturnStockPreviewLine, "sourceProof" | "unitsPerVariant">, intervals: readonly Interval[],
  receiptStartBasePiece: number, assignments: readonly ReturnInvoiceAssignment[]) {
  let mappings = intervals.map(row => ({ returnStart: row.start, sourceStart: row.start, quantity: row.quantity }));
  for (const transfer of [...source.sourceProof.transfers].reverse()) {
    const next: typeof mappings = [];
    for (const mapping of mappings) {
      let cursor = mapping.returnStart;
      for (const part of sliceCostQuantityIntervals(transfer.intervals, mapping.sourceStart, mapping.quantity)) {
        next.push({ returnStart: cursor, sourceStart: part.start, quantity: part.quantity }); cursor += part.quantity;
      }
    }
    if (next.length > 10000) throw new CostEvidenceError("RETURN_CREDIT_SCOPE_LIMIT", "The complete return-to-invoice trace exceeds 10000 intervals.");
    mappings = next;
  }
  const offset = BigInt(source.sourceProof.origin.purchaseStartBasePiece) - BigInt(costInteger(receiptStartBasePiece, "original receipt start"));
  if (offset < BigInt(0)) throw new CostEvidenceError("RETURN_CREDIT_RECEIPT_SOURCE_INVALID", "The original return lot precedes its receipt's saved quantity range.");
  const units = BigInt(source.unitsPerVariant), eligible: Interval[] = [];
  const parts: Array<{ receivingLineId: number; receiptStartPiece: number; invoiceStartPiece: number; pieces: number }> = [];
  for (const mapping of mappings) {
    const start = offset + BigInt(mapping.sourceStart) * units, end = start + BigInt(mapping.quantity) * units;
    for (const assignment of assignments.filter(row => row.receivingLineId === source.sourceProof.origin.receivingLineId)) {
      const left = start > BigInt(assignment.receiptStartPiece) ? start : BigInt(assignment.receiptStartPiece);
      const assignmentEnd = BigInt(assignment.receiptStartPiece) + BigInt(assignment.pieces), right = end < assignmentEnd ? end : assignmentEnd;
      if (right <= left) continue;
      // A physical return entitlement counts complete stock units. Its frozen
      // invoice attribution separately records the exact billed pieces within
      // those units, including a stock unit billed across two invoices.
      const first = BigInt(mapping.returnStart) + (left - start) / units;
      const last = BigInt(mapping.returnStart) + (right - start + units - BigInt(1)) / units;
      eligible.push({ start: exactQuantity(first, "returned unit start"), quantity: exactQuantity(last - first, "returned unit quantity") });
      parts.push({ receivingLineId: assignment.receivingLineId, receiptStartPiece: exactQuantity(left, "returned receipt piece"),
        invoiceStartPiece: exactQuantity(BigInt(assignment.invoiceStartPiece) + left - BigInt(assignment.receiptStartPiece), "returned invoice piece"),
        pieces: exactQuantity(right - left, "returned billed pieces") });
    }
  }
  return { eligibleIntervals: merge(eligible), parts: parts.sort((a, b) => a.receiptStartPiece - b.receiptStartPiece || a.invoiceStartPiece - b.invoiceStartPiece) };
}

export function intersectReturnedIntervals(left: readonly Interval[], right: readonly Interval[]): Interval[] {
  return merge(left.flatMap(a => right.flatMap(b => {
    const start = Math.max(a.start, b.start), end = Math.min(a.start + a.quantity, b.start + b.quantity);
    return end > start ? [{ start, quantity: end - start }] : [];
  })));
}
