import { Decimal } from "decimal.js";

const BasisDecimal = Decimal.clone({ precision: 40 });
const METHODS = new Set(["by_volume", "by_weight", "by_chargeable_weight", "by_value", "by_line_count"]);
const TYPE_OVERRIDES: Record<string, string> = { duty: "by_value", brokerage: "by_line_count", inspection: "by_line_count", platform_fee: "by_line_count" };
export const DIMENSIONAL_ALLOCATION_METHODS = new Set(["by_volume", "by_weight", "by_chargeable_weight"]);

export type ShipmentAllocationBasisLine = {
  lineId: number;
  qtyShipped: number;
  totalVolumeCbm: string | number | null;
  totalWeightKg: string | number | null;
  chargeableWeightKg: string | number | null;
  poUnitCostCents: string | number | null;
};

export function resolveShipmentAllocationMethod(costType: string, allocationMethod: string | null, shipmentDefault: string | null) {
  const method = TYPE_OVERRIDES[costType] ?? allocationMethod ?? shipmentDefault ?? "by_volume";
  if (!METHODS.has(method)) throw new Error(`Unsupported shipment allocation method: ${method}`);
  return { method, source: TYPE_OVERRIDES[costType] ? "cost_type_override" : allocationMethod ? "cost_row" : shipmentDefault ? "shipment_default" : "fallback_default" };
}

/** Same basis for allocation, the close gate and later receipt/cost source reads.
 * Decimal arithmetic preserves stored six-decimal dimensions and exact cents.
 * Number conversion occurs only after range checks, for the existing allocator DTO. */
export type ShipmentAllocationBasis = {
  values: Array<{ lineId: number; basis: number }>;
  rawBasisTotal: number;
  basisTotal: number;
  usedFallback: boolean;
  missingDimensionLineIds: number[];
};

function exactBasisNumber(value: Decimal): number {
  const result = value.toNumber();
  if (!new BasisDecimal(result).eq(value)) throw new Error("Allocation basis cannot be represented exactly by the supported DTO");
  return result;
}

export function buildShipmentAllocationBasis(lines: ShipmentAllocationBasisLine[], method: string): ShipmentAllocationBasis {
  if (!METHODS.has(method)) throw new Error(`Unsupported shipment allocation method: ${method}`);
  const missingDimensionLineIds: number[] = [];
  const seen = new Set<number>();
  const values = lines.map((line) => {
    if (!Number.isSafeInteger(line.lineId) || line.lineId <= 0 || seen.has(line.lineId)) throw new Error("Allocation line identity must be unique and positive");
    seen.add(line.lineId);
    let raw: string | number | null = 1;
    if (method === "by_volume") raw = line.totalVolumeCbm;
    if (method === "by_weight") raw = line.totalWeightKg;
    if (method === "by_chargeable_weight") raw = line.chargeableWeightKg;
    if (method === "by_value") raw = line.poUnitCostCents;
    let basis = new BasisDecimal(raw ?? 0);
    if (!basis.isFinite() || basis.isNegative()) throw new Error(`Allocation basis for line ${line.lineId} must be nonnegative and finite`);
    if (method === "by_value") {
      if (!basis.isInteger() || !Number.isSafeInteger(line.qtyShipped) || line.qtyShipped <= 0) throw new Error(`Value allocation for line ${line.lineId} requires exact cents and positive pieces`);
      basis = basis.mul(line.qtyShipped);
    }
    if (basis.gt(Number.MAX_SAFE_INTEGER)) throw new Error(`Allocation basis for line ${line.lineId} exceeds the supported exact range`);
    if (DIMENSIONAL_ALLOCATION_METHODS.has(method) && basis.isZero()) missingDimensionLineIds.push(line.lineId);
    return { lineId: line.lineId, exact: basis };
  });
  const rawTotal = values.reduce((sum, value) => sum.plus(value.exact), new BasisDecimal(0));
  if (rawTotal.gt(Number.MAX_SAFE_INTEGER)) throw new Error("Allocation basis total exceeds the supported exact range");
  const usedFallback = rawTotal.isZero() && lines.length > 0;
  return {
    values: values.map((value) => ({ lineId: value.lineId, basis: usedFallback ? 1 : exactBasisNumber(value.exact) })),
    rawBasisTotal: exactBasisNumber(rawTotal), basisTotal: usedFallback ? values.length : exactBasisNumber(rawTotal), usedFallback, missingDimensionLineIds,
  };
}

export function shipmentAllocationBasisMatches(saved: unknown, expected: number): boolean {
  if ((typeof saved !== "number" && typeof saved !== "string") || saved === "") return false;
  try {
    const actual = new BasisDecimal(saved);
    return actual.isFinite() && actual.eq(new BasisDecimal(expected));
  } catch { return false; }
}
