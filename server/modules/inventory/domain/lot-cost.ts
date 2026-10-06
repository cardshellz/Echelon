/** Inventory money is an integer number of mills (one hundredth of a cent).
 * Legacy rows have no proof that their default-zero mill columns were populated.
 * Version 1 is written only by a mill-aware owner; it makes zero authoritative.
 */
export interface LotCostRecord {
  id?: unknown;
  cost_precision_version?: unknown;
  cost_provisional?: unknown;
  cost_source?: unknown;
  qty_received?: unknown;
  unit_cost_mills?: unknown;
  total_unit_cost_mills?: unknown;
  po_unit_cost_mills?: unknown;
  packaging_cost_mills?: unknown;
  landed_cost_mills?: unknown;
  unit_cost_cents?: unknown;
  total_unit_cost_cents?: unknown;
  po_unit_cost_cents?: unknown;
  packaging_cost_cents?: unknown;
  landed_cost_cents?: unknown;
}

export interface LotCosts {
  poMills: bigint;
  packagingMills: bigint;
  landedMills: bigint;
  totalMills: bigint;
}

export class LotCostError extends Error {
  readonly code = "INVALID_SOURCE_LOT_COST";
  readonly statusCode = 409;
  constructor(message: string, readonly context: Record<string, unknown>) {
    super(message);
    this.name = "LotCostError";
  }
}

const MAX_STORED_MONEY = BigInt("9223372036854775807");

export function nonnegativeMoney(value: unknown, field: string): bigint {
  if (value === null || value === undefined) return BigInt(0);
  if ((typeof value === "number" && !Number.isSafeInteger(value))
    || !["number", "string", "bigint"].includes(typeof value)
    || !/^\d+$/.test(String(value))) {
    throw new LotCostError(`${field} must be a nonnegative integer amount.`, { field });
  }
  const amount = BigInt(String(value));
  if (amount > MAX_STORED_MONEY) throw new LotCostError(`${field} exceeds stored money precision.`, { field });
  return amount;
}

/** Validate every recorded column before selecting a compatibility value. A
 * negative authoritative value must never disappear behind a positive mirror.
 */
export function normalizeLotCosts(lot: LotCostRecord): LotCosts {
  return readLotCosts(lot).costs;
}

function readLotCosts(lot: LotCostRecord): { costs: LotCosts; compatibilityEstimated: boolean } {
  const fields = ["unit_cost_mills", "total_unit_cost_mills", "po_unit_cost_mills",
    "packaging_cost_mills", "landed_cost_mills", "unit_cost_cents", "total_unit_cost_cents",
    "po_unit_cost_cents", "packaging_cost_cents", "landed_cost_cents"] as const;
  const values = new Map(fields.map((field) => [field, nonnegativeMoney(lot[field], field)]));
  const get = (field: typeof fields[number]): bigint => values.get(field)!;
  const version = lot.cost_precision_version ?? 0;
  if (![0, 1, "0", "1"].includes(version as number)) {
    throw new LotCostError("Unsupported lot cost precision version.", { lotId: lot.id });
  }
  const exact = Number(version) === 1;
  if (exact && fields.filter((field) => field.endsWith("_mills")).some((field) => lot[field] == null)) {
    throw new LotCostError("A mill-authoritative lot is missing a required amount.", { lotId: lot.id });
  }
  const component = (mills: typeof fields[number], cents: typeof fields[number]): bigint =>
    exact || get(mills) > BigInt(0) ? get(mills) : get(cents) * BigInt(100);
  const totalMills = exact ? get("total_unit_cost_mills")
    : (get("total_unit_cost_mills") || get("unit_cost_mills"))
      || (get("total_unit_cost_cents") || get("unit_cost_cents")) * BigInt(100);
  const packagingMills = component("packaging_cost_mills", "packaging_cost_cents");
  const landedMills = component("landed_cost_mills", "landed_cost_cents");
  const recordedPo = component("po_unit_cost_mills", "po_unit_cost_cents");
  if (totalMills > MAX_STORED_MONEY || packagingMills + landedMills > totalMills) {
    throw new LotCostError("Lot components exceed its supported total cost.", { lotId: lot.id });
  }
  if (exact && (get("unit_cost_mills") !== totalMills || recordedPo + packagingMills + landedMills !== totalMills)) {
    throw new LotCostError("Authoritative lot components do not equal its total.", { lotId: lot.id });
  }
  // Historical lots sometimes put the total into PO cost as well as separate
  // components. Preserve the total and the documented components; classify the
  // residual as a compatibility estimate, never a new confirmed source fact.
  const compatibilityEstimated = recordedPo + packagingMills + landedMills !== totalMills;
  const poMills = compatibilityEstimated ? totalMills - packagingMills - landedMills : recordedPo;
  return { costs: { poMills, packagingMills, landedMills, totalMills }, compatibilityEstimated };
}

export function roundedMillsToCents(value: bigint): bigint {
  if (value < BigInt(0)) throw new LotCostError("Inventory cost cannot be negative.", {});
  return (value + BigInt(50)) / BigInt(100);
}

/** Financial reversals round the same magnitude as their positive posting. */
export function roundedSignedMillsToCents(value: bigint): bigint {
  return value < BigInt(0) ? -roundedMillsToCents(-value) : roundedMillsToCents(value);
}

export function moneyToSafeNumber(value: bigint, field: string): number {
  if (value < -BigInt(Number.MAX_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new LotCostError(`${field} exceeds the response's safe integer precision.`, { field });
  }
  return Number(value);
}

export function lotCostNeedsReview(lot: LotCostRecord): boolean {
  const { costs, compatibilityEstimated } = readLotCosts(lot);
  const provisional = lot.cost_provisional ?? 0;
  if (![0,1,"0","1"].includes(provisional as number)) {
    throw new LotCostError("Invalid lot cost confidence flag.", { lotId: lot.id });
  }
  const basis = lot.qty_received === undefined ? undefined : nonnegativeMoney(lot.qty_received,"qty_received");
  return compatibilityEstimated || Number(provisional) === 1 || lot.cost_source === "unresolved"
    || (Number(lot.cost_precision_version ?? 0) === 0 && costs.totalMills === BigInt(0))
    || basis === BigInt(0);
}

export function recordedUnitCostMills(row: {
  unit_cost_mills?: unknown; unit_cost_cents?: unknown; cost_precision_version?: unknown;
}): bigint {
  const mills = nonnegativeMoney(row.unit_cost_mills, "unit_cost_mills");
  const cents = nonnegativeMoney(row.unit_cost_cents, "unit_cost_cents");
  const version = row.cost_precision_version ?? 0;
  if (![0, 1, "0", "1"].includes(version as number)) throw new LotCostError("Unsupported cost precision version.", {});
  if (Number(version) === 1 && row.unit_cost_mills == null) throw new LotCostError("Authoritative unit cost is missing.", {});
  const amount = Number(version) === 1 || mills > BigInt(0) ? mills : cents * BigInt(100);
  if (amount > MAX_STORED_MONEY) throw new LotCostError("Unit cost exceeds stored precision.", {});
  return amount;
}

/** Explicit adapter for Drizzle's camel-case lot record, shared by FIFO owners. */
export function lotCostRecord(row: {
  id?: unknown; costPrecisionVersion?: unknown; costProvisional?: unknown; costSource?: unknown; qtyReceived?: unknown;
  unitCostMills?: unknown; totalUnitCostMills?: unknown; poUnitCostMills?: unknown;
  packagingCostMills?: unknown; landedCostMills?: unknown; unitCostCents?: unknown;
  totalUnitCostCents?: unknown; poUnitCostCents?: unknown; packagingCostCents?: unknown; landedCostCents?: unknown;
}): LotCostRecord {
  return {
    id: row.id, cost_precision_version: row.costPrecisionVersion, cost_provisional: row.costProvisional,
    cost_source: row.costSource, qty_received: row.qtyReceived, unit_cost_mills: row.unitCostMills,
    total_unit_cost_mills: row.totalUnitCostMills, po_unit_cost_mills: row.poUnitCostMills,
    packaging_cost_mills: row.packagingCostMills, landed_cost_mills: row.landedCostMills,
    unit_cost_cents: row.unitCostCents, total_unit_cost_cents: row.totalUnitCostCents,
    po_unit_cost_cents: row.poUnitCostCents, packaging_cost_cents: row.packagingCostCents, landed_cost_cents: row.landedCostCents,
  };
}
