import { CostEvidenceError, costInteger } from "../../inventory/infrastructure/cost-evidence-values";
import type { SupplierCreditSourceEvidence } from "./supplier-credit-source";

/** Unaccepted returns cannot reduce an accepted receipt's price. Their exact
 * original billed interval must be disjoint from all accepted assignments. */
export function validateQuarantineInvoiceCreditIntervals(invoicePieces: number,
  assignments: readonly { invoiceStartPiece: number; pieces: number }[],
  credits: readonly SupplierCreditSourceEvidence[]) {
  const returned = new Map<string, { start: bigint; pieces: bigint }>();
  for (const credit of credits) {
    if (!credit.returnSource || credit.returnInvoiceStartPiece === undefined) continue;
    const start = BigInt(credit.returnInvoiceStartPiece), pieces = BigInt(credit.returnSource.observationQuantity) * BigInt(credit.returnSource.unitsPerVariant);
    if (start + pieces > BigInt(costInteger(invoicePieces, "original invoice pieces", 1))
      || assignments.some(row => start < BigInt(row.invoiceStartPiece) + BigInt(row.pieces) && BigInt(row.invoiceStartPiece) < start + pieces))
      throw new CostEvidenceError("CREDIT_RETURN_INVOICE_OVERLAP", "Returned pieces must identify original billed pieces outside every accepted receipt assignment.");
    const key = `${credit.returnSource.dispositionId}:${start}:${pieces}`;
    for (const [otherKey, other] of returned) if (otherKey !== key && start < other.start + other.pieces && other.start < start + pieces)
      throw new CostEvidenceError("CREDIT_RETURN_INVOICE_OVERLAP", "Two different physical returns cannot consume the same original billed pieces.");
    returned.set(key, { start, pieces });
  }
}
