import { supplierReturnCostTotalsSchema, supplierReturnListSchema, type SupplierReturnCostTotals, type SupplierReturnDetail } from "@shared/procurement/supplier-return";
import { SupplierReturnError } from "./supplier-return.errors";

export function sumSupplierReturnCosts(values: readonly SupplierReturnCostTotals[]): SupplierReturnCostTotals {
  const exact = { productMills: BigInt(0), packagingMills: BigInt(0), landedMills: BigInt(0), totalMills: BigInt(0) };
  for (const value of values) {
    const parsed = supplierReturnCostTotalsSchema.parse(value);
    for (const field of Object.keys(exact) as Array<keyof typeof exact>) exact[field] += BigInt(parsed[field]);
  }
  if (Object.values(exact).some(value => value > BigInt(Number.MAX_SAFE_INTEGER))) {
    throw new SupplierReturnError("SUPPLIER_RETURN_AMOUNT_LIMIT", "The selected return totals exceed the exact supported amount range.");
  }
  return supplierReturnCostTotalsSchema.parse(Object.fromEntries(Object.entries(exact).map(([key, value]) => [key, Number(value)])));
}

export function supplierReturnCreditState(lines: SupplierReturnDetail["lines"]): SupplierReturnDetail["lines"][number]["creditState"] {
  if (lines.some(line => line.creditState === "review_required")) return "review_required";
  if (lines.length > 0 && lines.every(line => line.creditState === "matched")) return "matched";
  if (lines.some(line => line.creditState === "matched" || line.creditState === "partially_matched")) return "partially_matched";
  return "unmatched";
}

/** Summaries are projections of the same validated physical/value evidence as
 * the detail; credit settlement never substitutes for returned-cost matching. */
export function projectSupplierReturnList(documents: readonly SupplierReturnDetail[], nextAfterId: number | null) {
  return supplierReturnListSchema.parse({
    nextAfterId,
    items: documents.map(document => {
      const returnedBasePieces = document.lines.reduce((sum, line) => sum + BigInt(line.source.basePieces), BigInt(0));
      if (returnedBasePieces > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new SupplierReturnError("SUPPLIER_RETURN_QUANTITY_LIMIT", "The return quantity exceeds the supported exact range.");
      }
      return {
        id: document.id, vendorId: document.vendorId, vendorName: document.vendorName, status: document.status,
        supplierReference: document.supplierReference, returnCalendarDate: document.returnCalendarDate,
        evidenceReference: document.evidenceReference, recordedBy: document.recordedBy, recordedAt: document.recordedAt,
        returnedBasePieces: Number(returnedBasePieces), initialCosts: sumSupplierReturnCosts(document.lines.map(line => line.source.costs)),
        currentCosts: sumSupplierReturnCosts(document.lines.map(line => line.currentCosts)), creditState: supplierReturnCreditState(document.lines),
      };
    }),
  });
}
