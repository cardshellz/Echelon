import Decimal from "decimal.js";
import { exactMoneyAsInput, parseExactMoneyInput } from "./exact-money-input";

// Local precision is independent of other Decimal users. The API uses cents
// for aggregates and integer 1/10,000-dollar mills for authoritative lot costs.
const Money = Decimal.clone({ precision: 100, rounding: Decimal.ROUND_HALF_UP });
const CENTS_PER_DOLLAR = 100;
const MILLS_PER_DOLLAR = 10000;
const MAX_DECIMAL_INPUT_LENGTH = 64;

type Amount = { state: "known"; value: Decimal } | { state: "missing" | "invalid" };

function readAmount(input: unknown): Amount {
  if (input === null || input === undefined) return { state: "missing" };
  if (typeof input === "number") {
    // An unsafe JSON number has already lost its exact value. BIGINT strings
    // remain exact and do not need to be coerced through Number.
    if (!Number.isFinite(input) || Math.abs(input) > Number.MAX_SAFE_INTEGER) return { state: "invalid" };
    return { state: "known", value: new Money(String(input)) };
  }
  if (typeof input !== "string" && typeof input !== "bigint") return { state: "invalid" };
  const text = String(input).trim();
  if (text.length > MAX_DECIMAL_INPUT_LENGTH || !/^-?\d+(?:\.\d+)?$/.test(text)) return { state: "invalid" };
  return { state: "known", value: new Money(text) };
}

function scaleAmount(input: unknown, scale: number): Amount {
  const amount = readAmount(input);
  if (amount.state !== "known") return amount;
  if (scale === MILLS_PER_DOLLAR && !amount.value.isInteger()) return { state: "invalid" };
  return { state: "known", value: amount.value.div(scale) };
}

function formatAmount(amount: Amount): string {
  if (amount.state !== "known") return amount.state === "missing" ? "Not recorded" : "Unavailable";
  const rounded = amount.value.toDecimalPlaces(4);
  // Retain four places for a subcent value; whole-cent amounts use two.
  const [whole, fraction] = rounded.abs().toFixed(rounded.decimalPlaces() > 2 ? 4 : 2).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${rounded.isNegative() && !rounded.isZero() ? "-" : ""}$${grouped}.${fraction}`;
}

export function formatDashboardCents(input: unknown): string {
  return formatAmount(scaleAmount(input, CENTS_PER_DOLLAR));
}

export function formatDashboardMills(input: unknown): string {
  return formatAmount(scaleAmount(input, MILLS_PER_DOLLAR));
}

export interface DashboardLotMoney {
  po_unit_cost_mills?: unknown;
  po_unit_cost_cents?: unknown;
  landed_cost_mills?: unknown;
  landed_cost_cents?: unknown;
  total_unit_cost_mills?: unknown;
  total_unit_cost_cents?: unknown;
  unit_cost_mills?: unknown;
  unit_cost_cents?: unknown;
  qty_on_hand?: unknown;
}

type LotComponent = "product" | "landed" | "total";

function lotAmount(lot: DashboardLotMoney, component: LotComponent): Amount {
  const candidates = component === "product"
    ? [[lot.po_unit_cost_mills, MILLS_PER_DOLLAR], [lot.po_unit_cost_cents, CENTS_PER_DOLLAR]] as const
    : component === "landed"
      ? [[lot.landed_cost_mills, MILLS_PER_DOLLAR], [lot.landed_cost_cents, CENTS_PER_DOLLAR]] as const
      : [[lot.total_unit_cost_mills, MILLS_PER_DOLLAR], [lot.unit_cost_mills, MILLS_PER_DOLLAR],
        [lot.total_unit_cost_cents, CENTS_PER_DOLLAR], [lot.unit_cost_cents, CENTS_PER_DOLLAR]] as const;
  let recordedZero: Amount = { state: "missing" };
  for (const [input, scale] of candidates) {
    const amount = scaleAmount(input, scale);
    if (amount.state === "invalid") return amount;
    if (amount.state === "known") {
      // Zero mills were added as a legacy default. Match the owner's
      // NULLIF(..., 0)/fallback convention; do not hide populated cents.
      if (!amount.value.isZero()) return amount;
      recordedZero = amount;
    }
  }
  return recordedZero;
}

export function formatDashboardLotCost(lot: DashboardLotMoney, component: LotComponent = "total"): string {
  return formatAmount(lotAmount(lot, component));
}

/** Sum the displayed lots in their existing variant quantities, without
 * rounding each unit to cents or performing floating-point monetary math. */
export function formatDashboardLotValue(lots: readonly DashboardLotMoney[]): string {
  let total = new Money(0);
  for (const lot of lots) {
    const quantity = readAmount(lot.qty_on_hand);
    if (quantity.state !== "known") return formatAmount(quantity);
    if (!quantity.value.isInteger() || quantity.value.isNegative() || quantity.value.gt(Number.MAX_SAFE_INTEGER)) return "Unavailable";
    const cost = lotAmount(lot, "total");
    if (cost.state !== "known") return formatAmount(cost);
    total = total.plus(quantity.value.times(cost.value));
  }
  return formatAmount({ state: "known", value: total });
}

// The existing recost route converts numeric dollars with Math.round(dollars *
// 10000). At <=2^50 mills, decimal-to-binary conversion plus multiplication error
// stays below half a mill. Safe-integer mills alone do not ensure that roundtrip
// near 2^53. This input limit does not restrict exact BIGINT display values.
const MAX_NUMERIC_RECOST_MILLS = BigInt("1125899906842624"); // 2^50

export type DashboardRecostInput =
  | { valid: true; dollars: number; perPieceMills: number }
  | { valid: false; error: string | null };

export function parseDashboardRecostInput(raw: string): DashboardRecostInput {
  if (!raw.trim()) return { valid: false, error: null };
  try {
    const perPieceMills = parseExactMoneyInput(raw, 4);
    if (BigInt(perPieceMills) > MAX_NUMERIC_RECOST_MILLS) {
      return { valid: false, error: "This amount exceeds the current recost form's exact numeric limit ($112,589,990,684.2624 per piece)." };
    }
    return { valid: true, perPieceMills, dollars: Number(exactMoneyAsInput(perPieceMills, 4)) };
  } catch (error) {
    return { valid: false, error: error instanceof Error ? error.message : "Enter a nonnegative amount with at most 4 decimal places." };
  }
}
