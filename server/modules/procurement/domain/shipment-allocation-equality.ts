import { Decimal } from "decimal.js";
import type { InsertInboundFreightAllocation } from "@shared/schema";
import { canonicalJson } from "@shared/utils/canonical-json";

function sameDecimal(left: string | null | undefined, right: string | null | undefined): boolean {
  if (left == null || right == null) return left == null && right == null;
  try {
    const value = new Decimal(left);
    return value.isFinite() && value.eq(new Decimal(right));
  } catch {
    // Invalid legacy display mirrors cannot establish equality with new evidence.
    return false;
  }
}

/** Preserve row identity when the computed allocation is unchanged. Identity and
 * timestamps belong to the recorded source evidence, so recreating identical rows
 * would otherwise manufacture a new cost revision on every retry. */
export function shipmentAllocationsEqual(
  existing: readonly InsertInboundFreightAllocation[],
  proposed: readonly InsertInboundFreightAllocation[],
): boolean {
  if (existing.length !== proposed.length) return false;
  const key = (row: InsertInboundFreightAllocation) => `${row.shipmentCostId}:${row.inboundShipmentLineId}`;
  const byLine = new Map(existing.map(row => [key(row), row]));
  if (byLine.size !== existing.length || new Set(proposed.map(key)).size !== proposed.length) return false;
  return proposed.every(row => {
    const saved = byLine.get(key(row));
    return !!saved && saved.allocatedCents === row.allocatedCents
      && sameDecimal(saved.allocationBasisValue, row.allocationBasisValue)
      && sameDecimal(saved.allocationBasisTotal, row.allocationBasisTotal)
      && sameDecimal(saved.sharePercent, row.sharePercent)
      && canonicalJson(saved.basisEvidence ?? null) === canonicalJson(row.basisEvidence ?? null);
  });
}
