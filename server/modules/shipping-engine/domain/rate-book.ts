import type { ShippingRateContext } from "./shipping-channel";

export interface RateBookAssignmentCandidate extends ShippingRateContext {
  assignmentId: number;
  rateBookId: number;
  rateBookCode: string;
  zoneSetId: number;
  originWarehouseId: number | null;
}

export interface RateBookSelectionInput extends ShippingRateContext {
  originWarehouseId: number;
}

export type RateBookSelectionResult =
  | { ok: true; assignment: RateBookAssignmentCandidate }
  | { ok: false; code: "NO_RATE_BOOK" | "AMBIGUOUS_RATE_BOOK"; message: string };

/** Warehouse assignment wins; otherwise use the one channel-wide assignment. */
export function selectRateBookAssignment(
  candidates: readonly RateBookAssignmentCandidate[],
  input: RateBookSelectionInput,
): RateBookSelectionResult {
  const matching = candidates.filter((candidate) =>
    candidate.pricingChannel === input.pricingChannel
    && candidate.purpose === input.purpose);

  const warehouseMatches = matching.filter((candidate) =>
    candidate.originWarehouseId === input.originWarehouseId);
  if (warehouseMatches.length > 1) {
    return ambiguousResult(input, "warehouse-specific");
  }
  if (warehouseMatches[0]) {
    return { ok: true, assignment: warehouseMatches[0] };
  }

  const globalMatches = matching.filter((candidate) => candidate.originWarehouseId === null);
  if (globalMatches.length > 1) {
    return ambiguousResult(input, "channel-wide");
  }
  if (globalMatches[0]) {
    return { ok: true, assignment: globalMatches[0] };
  }

  return {
    ok: false,
    code: "NO_RATE_BOOK",
    message: `no active rate book is assigned to ${input.pricingChannel}/${input.purpose} for warehouse ${input.originWarehouseId}`,
  };
}

function ambiguousResult(
  input: RateBookSelectionInput,
  scope: string,
): RateBookSelectionResult {
  return {
    ok: false,
    code: "AMBIGUOUS_RATE_BOOK",
    message: `multiple active ${scope} rate books are assigned to ${input.pricingChannel}/${input.purpose} for warehouse ${input.originWarehouseId}`,
  };
}

