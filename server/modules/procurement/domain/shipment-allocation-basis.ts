import { Decimal } from "decimal.js";
import { canonicalJson } from "@shared/utils/canonical-json";
import {
  shipmentAllocationEvidenceSchema,
  SHIPMENT_ALLOCATION_MAX_RATIO_DIGITS,
  SHIPMENT_ALLOCATION_MAX_SOURCE_QUANTITY,
  type ShipmentAllocationEvidence,
  type ShipmentAllocationRatio,
  type ShipmentAllocationSource,
} from "@shared/procurement/shipment-allocation";

const BasisDecimal = Decimal.clone({ precision: 40 });
const METHODS = new Set(["by_volume", "by_weight", "by_chargeable_weight", "by_value", "by_line_count"]);
const TYPE_OVERRIDES: Record<string, string> = { duty: "by_value", brokerage: "by_line_count", inspection: "by_line_count", platform_fee: "by_line_count" };
export const DIMENSIONAL_ALLOCATION_METHODS = new Set(["by_volume", "by_weight", "by_chargeable_weight"]);
type Ratio = { numerator: bigint; denominator: bigint };
const ZERO: Ratio = { numerator: BigInt(0), denominator: BigInt(1) };
const ONE: Ratio = { numerator: BigInt(1), denominator: BigInt(1) };

export type ShipmentAllocationBasisLine = {
  lineId: number;
  qtyShipped: number;
  totalVolumeCbm: string | number | null;
  totalWeightKg: string | number | null;
  chargeableWeightKg: string | number | null;
  poLineId?: number | null;
  poOrderQty?: string | number | null;
  poTotalProductCostCents?: string | number | null;
  poCurrency?: string | null;
};
export type ShipmentProductValueInput = Pick<ShipmentAllocationBasisLine,
  "poLineId" | "poOrderQty" | "poTotalProductCostCents" | "poCurrency" | "qtyShipped">;
export type ShipmentAllocationBasisValue = {
  lineId: number;
  /** Display/legacy storage mirror only. Allocation uses ratio. */
  basis: number;
  rawRatio: ShipmentAllocationRatio;
  ratio: ShipmentAllocationRatio;
  source: ShipmentAllocationSource;
};
export type ShipmentAllocationBasis = {
  method: ShipmentAllocationEvidence["method"];
  values: ShipmentAllocationBasisValue[];
  /** Display mirrors; totalRatio remains the exact allocation authority. */
  rawBasisTotal: number;
  basisTotal: number;
  totalRatio: ShipmentAllocationRatio;
  usedFallback: boolean;
  missingDimensionLineIds: number[];
};

function gcd(left: bigint, right: bigint): bigint {
  while (right !== BigInt(0)) { const remainder = left % right; left = right; right = remainder; }
  return left;
}
function reduceRatio(numerator: bigint, denominator: bigint): Ratio {
  if (numerator < BigInt(0) || denominator <= BigInt(0)) throw new Error("Allocation ratios require nonnegative values and positive denominators");
  const divisor = gcd(numerator, denominator);
  const reduced = { numerator: numerator / divisor, denominator: denominator / divisor };
  if (reduced.numerator.toString().length > SHIPMENT_ALLOCATION_MAX_RATIO_DIGITS
    || reduced.denominator.toString().length > SHIPMENT_ALLOCATION_MAX_RATIO_DIGITS) {
    throw new Error("Shipment allocation exceeds the supported exact ratio range; review the source quantity denominators");
  }
  return reduced;
}
function serializeRatio(value: Ratio): ShipmentAllocationRatio {
  return { numerator: value.numerator.toString(), denominator: value.denominator.toString() };
}
function parseRatio(value: ShipmentAllocationRatio): Ratio {
  if (typeof value.numerator !== "string" || typeof value.denominator !== "string"
    || value.numerator.length > SHIPMENT_ALLOCATION_MAX_RATIO_DIGITS || value.denominator.length > SHIPMENT_ALLOCATION_MAX_RATIO_DIGITS
    || !/^(0|[1-9][0-9]*)$/.test(value.numerator) || !/^[1-9][0-9]*$/.test(value.denominator)) throw new Error("Allocation ratio must contain bounded exact nonnegative integers");
  return reduceRatio(BigInt(value.numerator), BigInt(value.denominator));
}
function addRatios(left: Ratio, right: Ratio): Ratio {
  const divisor = gcd(left.denominator, right.denominator);
  return reduceRatio(left.numerator * (right.denominator / divisor) + right.numerator * (left.denominator / divisor),
    left.denominator * (right.denominator / divisor));
}
function mirror(value: Ratio): number {
  const result = new BasisDecimal(value.numerator.toString()).div(value.denominator.toString()).toNumber();
  if (!Number.isFinite(result)) throw new Error("Shipment allocation display exceeds the supported finite range");
  return result;
}
function sourceInteger(value: unknown, field: string, minimum = 0): number {
  if ((typeof value !== "number" && typeof value !== "string") || (typeof value === "string" && !/^(0|[1-9][0-9]*)$/.test(value))) throw new Error(`${field} must be an explicit exact integer`);
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < minimum) throw new Error(`${field} is outside the supported exact range`);
  return result;
}
function sourceQuantity(value: unknown, field: string): number {
  const result = sourceInteger(value, field, 1);
  if (result > SHIPMENT_ALLOCATION_MAX_SOURCE_QUANTITY) throw new Error(`${field} exceeds the supported database integer range`);
  return result;
}

/** Preserve the recorded PO product-total policy. No invoice, packaging, tax,
 * quote remainder or rounded per-unit mirror is substituted for this source. */
export function resolveShipmentProductValue(input: ShipmentProductValueInput): {
  ratio: ShipmentAllocationRatio; source: Extract<ShipmentAllocationSource, { kind: "po_product_total" }>;
} {
  const poLineId = sourceQuantity(input.poLineId, "PO line");
  const orderQty = sourceQuantity(input.poOrderQty, "PO ordered pieces");
  const qtyShipped = sourceQuantity(input.qtyShipped, "Shipped pieces");
  const total = sourceInteger(input.poTotalProductCostCents, "PO product total cents");
  if (input.poCurrency !== "USD") throw new Error(`PO line ${poLineId} requires explicit USD product value before allocation`);
  return {
    ratio: serializeRatio(reduceRatio(BigInt(total) * BigInt(qtyShipped), BigInt(orderQty))),
    source: { kind: "po_product_total", poLineId, orderQty, qtyShipped, totalProductCostCents: String(total), currency: "USD" },
  };
}

/** Half-up integer projection for compatibility mirrors, never allocation. */
export function roundShipmentRatioToInteger(value: ShipmentAllocationRatio, multiplier = 1): number {
  sourceInteger(multiplier, "Ratio multiplier", 1);
  const ratio = parseRatio(value);
  const numerator = ratio.numerator * BigInt(multiplier);
  const rounded = (numerator * BigInt(2) + ratio.denominator) / (ratio.denominator * BigInt(2));
  if (rounded > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Rounded shipment value exceeds the supported exact range");
  return Number(rounded);
}

export type ShipmentProductValueProjection = {
  productTotalCents: number;
  poUnitCostCents: number;
  poUnitCostMills: number;
  totalLandedCostCents: number;
  landedUnitCostCents: number;
  landedUnitCostMills: number;
};

/** Project only from frozen, validated PO evidence. Add landed charges before
 * rounding totals and divide exact values before rounding per-piece mirrors. */
export function projectShipmentProductValue(evidence: ShipmentAllocationEvidence, allocatedCents: number): ShipmentProductValueProjection {
  const saved = shipmentAllocationEvidenceSchema.parse(evidence);
  if (saved.method !== "by_value" || saved.source.kind !== "po_product_total") throw new Error("Shipment product projection requires exact PO product-value evidence");
  if (!Number.isSafeInteger(allocatedCents) || allocatedCents < 0) throw new Error("Allocated cents must be a nonnegative safe integer");
  const source = saved.source;
  const expected = resolveShipmentProductValue({ poLineId: source.poLineId, poOrderQty: source.orderQty,
    poTotalProductCostCents: source.totalProductCostCents, poCurrency: source.currency, qtyShipped: source.qtyShipped });
  if (canonicalJson(saved.rawRatio) !== canonicalJson(expected.ratio)) throw new Error("Frozen product ratio does not reconcile to its PO source");
  const product = parseRatio(expected.ratio);
  const landed = addRatios(product, { numerator: BigInt(allocatedCents), denominator: BigInt(1) });
  const perPiece = (value: Ratio) => serializeRatio(reduceRatio(value.numerator, value.denominator * BigInt(source.qtyShipped)));
  return {
    productTotalCents: roundShipmentRatioToInteger(serializeRatio(product)),
    poUnitCostCents: roundShipmentRatioToInteger(perPiece(product)),
    poUnitCostMills: roundShipmentRatioToInteger(perPiece(product), 100),
    totalLandedCostCents: roundShipmentRatioToInteger(serializeRatio(landed)),
    landedUnitCostCents: roundShipmentRatioToInteger(perPiece(landed)),
    landedUnitCostMills: roundShipmentRatioToInteger(perPiece(landed), 100),
  };
}

export function resolveShipmentAllocationMethod(costType: string, allocationMethod: string | null, shipmentDefault: string | null) {
  const method = TYPE_OVERRIDES[costType] ?? allocationMethod ?? shipmentDefault ?? "by_volume";
  if (!METHODS.has(method)) throw new Error(`Unsupported shipment allocation method: ${method}`);
  return { method, source: TYPE_OVERRIDES[costType] ? "cost_type_override" : allocationMethod ? "cost_row" : shipmentDefault ? "shipment_default" : "fallback_default" };
}

function dimensionRatio(raw: string | number | null, lineId: number): { ratio: Ratio; normalized: string | null } {
  const value = new BasisDecimal(raw ?? 0);
  if (!value.isFinite() || value.isNegative() || value.gt(Number.MAX_SAFE_INTEGER)) throw new Error(`Allocation basis for line ${lineId} must be nonnegative, finite and within the supported exact range`);
  if (!new BasisDecimal(value.toNumber()).eq(value)) throw new Error("Allocation basis cannot be represented exactly by the supported DTO");
  const parts = value.toFixed().split(".");
  const denominator = decimalScalePower(parts[1]?.length ?? 0);
  return { ratio: reduceRatio(BigInt(parts.join("")), denominator), normalized: raw === null ? null : value.toString() };
}

/** Multiplication is supported by the repository's older compilation target;
 * bounding the scale also bounds exact decimal denominator construction. */
function decimalScalePower(scale: number): bigint {
  if (!Number.isSafeInteger(scale) || scale < 0 || scale >= SHIPMENT_ALLOCATION_MAX_RATIO_DIGITS) {
    throw new Error("Dimension decimal scale exceeds the supported exact ratio range");
  }
  let value = BigInt(1);
  for (let index = 0; index < scale; index++) value *= BigInt(10);
  return value;
}

/** One exact basis for allocation, its close gate and subsequent source reads. */
export function buildShipmentAllocationBasis(lines: ShipmentAllocationBasisLine[], method: string): ShipmentAllocationBasis {
  if (!METHODS.has(method)) throw new Error(`Unsupported shipment allocation method: ${method}`);
  const missingDimensionLineIds: number[] = [];
  const seen = new Set<number>();
  const rawValues = lines.map((line) => {
    if (!Number.isSafeInteger(line.lineId) || line.lineId <= 0 || line.lineId > SHIPMENT_ALLOCATION_MAX_SOURCE_QUANTITY || seen.has(line.lineId)) throw new Error("Allocation line identity must be unique and positive within the database integer range");
    seen.add(line.lineId);
    let exact = ONE;
    let source: ShipmentAllocationSource = { kind: "line_count" };
    if (method === "by_value") {
      const value = resolveShipmentProductValue(line);
      exact = parseRatio(value.ratio); source = value.source;
    } else if (DIMENSIONAL_ALLOCATION_METHODS.has(method)) {
      const field = method === "by_volume" ? "totalVolumeCbm" : method === "by_weight" ? "totalWeightKg" : "chargeableWeightKg";
      const value = dimensionRatio(line[field], line.lineId);
      exact = value.ratio; source = { kind: "dimension", field, value: value.normalized };
      if (exact.numerator === BigInt(0)) missingDimensionLineIds.push(line.lineId);
    }
    return { lineId: line.lineId, exact, source };
  });
  const rawTotal = rawValues.reduce((sum, value) => addRatios(sum, value.exact), ZERO);
  if (method !== "by_value" && new BasisDecimal(rawTotal.numerator.toString()).div(rawTotal.denominator.toString()).gt(Number.MAX_SAFE_INTEGER)) throw new Error("Allocation basis total exceeds the supported exact range");
  if (method !== "by_value") {
    const displayedTotal = dimensionRatio(mirror(rawTotal), 0).ratio;
    if (displayedTotal.numerator !== rawTotal.numerator || displayedTotal.denominator !== rawTotal.denominator) {
      throw new Error("Allocation basis cannot be represented exactly by the supported DTO");
    }
  }
  const usedFallback = rawTotal.numerator === BigInt(0) && lines.length > 0;
  const total = usedFallback ? reduceRatio(BigInt(lines.length), BigInt(1)) : rawTotal;
  return {
    method: method as ShipmentAllocationEvidence["method"],
    values: rawValues.map((value) => ({ lineId: value.lineId, basis: mirror(usedFallback ? ONE : value.exact),
      rawRatio: serializeRatio(value.exact), ratio: serializeRatio(usedFallback ? ONE : value.exact), source: value.source })),
    rawBasisTotal: mirror(rawTotal), basisTotal: mirror(total), totalRatio: serializeRatio(total), usedFallback, missingDimensionLineIds,
  };
}

/** Largest remainder uses integer fractions throughout, including comparisons.
 * Stable line identity breaks exact ties independently of input ordering. */
export function allocateShipmentCents(amountCents: number, basis: ShipmentAllocationBasis): Array<{
  lineId: number; basis: number; allocatedCents: number; sharePercent: string;
}> {
  if (!Number.isSafeInteger(amountCents) || amountCents < 0) throw new Error("Allocation amount must be a nonnegative safe integer cents value");
  if (basis.values.length === 0) return [];
  const total = parseRatio(basis.totalRatio);
  if (total.numerator === BigInt(0)) throw new Error("Allocation basis total must be positive");
  const seen = new Set<number>();
  let checkedTotal = ZERO;
  const rows = basis.values.map((value) => {
    sourceQuantity(value.lineId, "Allocation line identity");
    if (seen.has(value.lineId)) throw new Error("Allocation line identity must be unique");
    seen.add(value.lineId);
    const ratio = parseRatio(value.ratio);
    checkedTotal = addRatios(checkedTotal, ratio);
    const shareNumerator = ratio.numerator * total.denominator;
    const shareDenominator = ratio.denominator * total.numerator;
    const centsNumerator = BigInt(amountCents) * shareNumerator;
    const scaledPercent = (shareNumerator * BigInt(1_000_000) * BigInt(2) + shareDenominator) / (shareDenominator * BigInt(2));
    return { lineId: value.lineId, basis: value.basis, allocated: centsNumerator / shareDenominator,
      remainder: centsNumerator % shareDenominator, denominator: shareDenominator,
      sharePercent: `${scaledPercent / BigInt(10_000)}.${(scaledPercent % BigInt(10_000)).toString().padStart(4, "0")}` };
  });
  if (checkedTotal.numerator !== total.numerator || checkedTotal.denominator !== total.denominator) throw new Error("Allocation basis total does not match its exact line values");
  const remaining = BigInt(amountCents) - rows.reduce((sum, row) => sum + row.allocated, BigInt(0));
  const ordered = [...rows].sort((left, right) => {
    const difference = right.remainder * left.denominator - left.remainder * right.denominator;
    return difference > BigInt(0) ? 1 : difference < BigInt(0) ? -1 : left.lineId - right.lineId;
  });
  if (remaining < BigInt(0) || remaining >= BigInt(rows.length)) throw new Error("Allocation remainder is inconsistent with exact basis");
  for (let index = 0; index < Number(remaining); index++) ordered[index].allocated += BigInt(1);
  return rows.map((row) => ({ lineId: row.lineId, basis: row.basis, allocatedCents: Number(row.allocated), sharePercent: row.sharePercent }));
}

/** Compatibility entry point for existing numeric callers. It uses the same
 * rational allocator and retains rejection of an all-zero supplied basis. */
export function allocateCentsFromNumericBasis(amountCents: number, values: Array<{ lineId: number; basis: number }>) {
  const basis = buildShipmentAllocationBasis(values.map((value) => ({ lineId: value.lineId, qtyShipped: 1,
    totalVolumeCbm: value.basis, totalWeightKg: null, chargeableWeightKg: null })), "by_volume");
  if (basis.usedFallback) throw new Error("Allocation basis total must be positive");
  return allocateShipmentCents(amountCents, basis);
}

export function buildShipmentAllocationEvidence(basis: ShipmentAllocationBasis, lineId: number): ShipmentAllocationEvidence {
  const line = basis.values.find((value) => value.lineId === lineId);
  if (!line) throw new Error(`Allocation line ${lineId} is absent from the exact basis`);
  return shipmentAllocationEvidenceSchema.parse({ version: 2, lineId, method: basis.method, source: line.source,
    rawRatio: line.rawRatio, ratio: line.ratio, totalRatio: basis.totalRatio, usedFallback: basis.usedFallback });
}

export function shipmentAllocationEvidenceMatches(saved: unknown, basis: ShipmentAllocationBasis, lineId: number): boolean {
  const parsed = shipmentAllocationEvidenceSchema.safeParse(saved);
  return parsed.success && canonicalJson(parsed.data) === canonicalJson(buildShipmentAllocationEvidence(basis, lineId));
}

/** PostgreSQL numeric(14,6) compatibility mirror. Exact JSON evidence remains
 * available when a legitimate value cannot fit the old display column. */
export function storedBasisMirror(value: number): string | null {
  if (!Number.isFinite(value) || value < 0) return null;
  const rounded = new BasisDecimal(value).toDecimalPlaces(6, Decimal.ROUND_HALF_UP);
  return rounded.lt("100000000") ? rounded.toFixed(6) : null;
}

export function shipmentAllocationBasisMatches(saved: unknown, expected: number): boolean {
  if ((typeof saved !== "number" && typeof saved !== "string") || saved === "") return false;
  try {
    const actual = new BasisDecimal(saved);
    return actual.isFinite() && actual.eq(new BasisDecimal(expected));
  } catch { return false; }
}
