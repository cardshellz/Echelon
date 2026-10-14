const CHARGE_COMPONENTS = [
  ["freightAllocatedCents", "Freight"],
  ["dutyAllocatedCents", "Duty/customs"],
  ["insuranceAllocatedCents", "Insurance"],
  ["otherAllocatedCents", "Other landed charges"],
] as const;

type ChargeField = typeof CHARGE_COMPONENTS[number][0];
export type ShipmentAdjustmentSnapshot = Readonly<Record<ChargeField, unknown> & {
  totalLandedCostCents: unknown;
}>;

function exactStoredCents(value: unknown, field: string): bigint {
  const parsed = typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value) ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${field} requires an explicit nonnegative safe integer cents value`);
  }
  return BigInt(parsed);
}

function checkedDifference(after: bigint, before: bigint, field: string): bigint {
  const difference = after - before;
  const maximum = BigInt(Number.MAX_SAFE_INTEGER);
  if (difference > maximum || difference < -maximum) throw new Error(`${field} exceeds the supported exact cents range`);
  return difference;
}

function describeChange(label: string, before: bigint, after: bigint): string {
  const difference = checkedDifference(after, before, label);
  return `${label}: ${before} -> ${after} cents (${difference >= BigInt(0) ? "+" : ""}${difference})`;
}

/** This is an audit delta, not an inventory posting. Older snapshot totals used
 * rounded per-piece product cents, so their product projection can change even
 * when all landed charges remain unchanged. Keep the complete total difference
 * while identifying each component instead of calling all of it freight. */
export function deriveShipmentCostAdjustment(
  before: ShipmentAdjustmentSnapshot,
  after: ShipmentAdjustmentSnapshot,
  priorProductSource: "legacy" | "exact",
): { adjustmentAmountCents: number; reason: string } | null {
  if (priorProductSource !== "legacy" && priorProductSource !== "exact") throw new Error("Prior product projection source must be explicitly classified");
  const beforeTotal = exactStoredCents(before.totalLandedCostCents, "Prior total landed cost");
  const afterTotal = exactStoredCents(after.totalLandedCostCents, "New total landed cost");
  const components = CHARGE_COMPONENTS.map(([field, label]) => ({ label,
    before: exactStoredCents(before[field], `Prior ${label.toLowerCase()}`),
    after: exactStoredCents(after[field], `New ${label.toLowerCase()}`),
  }));
  const beforeCharges = components.reduce((sum, component) => sum + component.before, BigInt(0));
  const afterCharges = components.reduce((sum, component) => sum + component.after, BigInt(0));
  if (beforeCharges > beforeTotal || afterCharges > afterTotal) {
    throw new Error("Snapshot landed charge components exceed the recorded total; review the prior product projection");
  }
  const beforeProduct = beforeTotal - beforeCharges;
  const afterProduct = afterTotal - afterCharges;
  const productChanged = beforeProduct !== afterProduct;
  const chargesChanged = components.some((component) => component.before !== component.after);
  if (!productChanged && !chargesChanged) return null;

  const classification = productChanged
    ? priorProductSource === "legacy"
      ? "Legacy product projection recalculation (prior exact PO source unavailable)"
      : "Product projection change"
    : "Post-close landed charge reallocation";
  const title = productChanged && chargesChanged ? `${classification} and landed charge reallocation` : classification;
  const details = [describeChange("Product projection", beforeProduct, afterProduct),
    ...components.map((component) => describeChange(component.label, component.before, component.after)),
    describeChange("Total landed", beforeTotal, afterTotal)];
  return {
    adjustmentAmountCents: Number(checkedDifference(afterTotal, beforeTotal, "Total landed adjustment")),
    reason: `${title}. ${details.join("; ")}.`,
  };
}
