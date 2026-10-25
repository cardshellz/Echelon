/**
 * Exact money readers. The caller declares the source unit: database cents
 * and provider dollar decimals must never be inferred from a JS value's type.
 * Missing or malformed evidence is an error; callers own optional-field policy.
 */
export class MoneyInputError extends RangeError {
  readonly code: "MONEY_INPUT_INVALID" | "MONEY_INPUT_OVERFLOW";
  readonly context: { field: string; unit: "cents" | "mills" | "dollars" | "rate" };
  constructor(field: string, unit: "cents" | "mills" | "dollars" | "rate", overflow = false) {
    super(`${field}: ${overflow ? "amount exceeds the safe integer range" : "invalid " + unit + " amount"}`);
    this.name = "MoneyInputError";
    this.code = overflow ? "MONEY_INPUT_OVERFLOW" : "MONEY_INPUT_INVALID";
    this.context = { field, unit };
  }
}

function checkedCents(value: bigint, field: string, unit: "cents" | "mills" | "dollars", signed: boolean): number {
  if (!signed && value < BigInt(0)) throw new MoneyInputError(field, unit);
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER))
    throw new MoneyInputError(field, unit, true);
  return Number(value);
}

/** Read an integer-cent column, including PostgreSQL int8/numeric text. */
function readIntegerAmount(value: unknown, field: string, unit: "cents" | "mills", signed: boolean): number {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new MoneyInputError(field, unit, Number.isInteger(value));
    return checkedCents(BigInt(value), field, unit, signed);
  }
  if (typeof value === "bigint") return checkedCents(value, field, unit, signed);
  if (typeof value !== "string" || !/^-?\d{1,20}$/.test(value))
    throw new MoneyInputError(field, unit);
  return checkedCents(BigInt(value), field, unit, signed);
}

export function readIntegerCents(value: unknown, field = "amount", signed = false): number {
  return readIntegerAmount(value, field, "cents", signed);
}

export function readIntegerMills(value: unknown, field = "unit cost", signed = false): number {
  return readIntegerAmount(value, field, "mills", signed);
}

/** Read a declared dollar amount exactly; integer 5 and text "5" both mean $5. */
export function parseDecimalCents(value: unknown, field = "amount", signed = false): number {
  if (typeof value !== "string" && typeof value !== "number")
    throw new MoneyInputError(field, "dollars");
  if (typeof value === "number" && !Number.isFinite(value))
    throw new MoneyInputError(field, "dollars");
  const text = String(value);
  const match = /^(-?)(\d{1,20})(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) throw new MoneyInputError(field, "dollars");
  const cents = BigInt(match[2]) * BigInt(100) + BigInt((match[3] ?? "").padEnd(2, "0"));
  return checkedCents(match[1] ? -cents : cents, field, "dollars", signed);
}

/** Only for legacy contracts that explicitly round sub-cent dollar inputs. */
export function parseRoundedDecimalCents(value: unknown, field: string, signed = false): number {
  if (typeof value !== "string" && typeof value !== "number") throw new MoneyInputError(field, "dollars");
  const match = /^(-?)(\d{1,20})(?:\.(\d{1,10}))?$/.exec(String(value));
  if (!match) throw new MoneyInputError(field, "dollars");
  const fraction = match[3] ?? "";
  const magnitude = BigInt(match[2]) * BigInt(100)
    + BigInt(fraction.slice(0, 2).padEnd(2, "0"))
    + (fraction.length > 2 && fraction[2] >= "5" ? BigInt(1) : BigInt(0));
  return checkedCents(match[1] ? -magnitude : magnitude, field, "dollars", signed);
}

export function sumCents(values: readonly number[], field = "total", signed = false): number {
  const total = values.reduce((sum, value) => sum + BigInt(readIntegerCents(value, field, signed)), BigInt(0));
  return checkedCents(total, field, "cents", signed);
}

/** Plain decimal wire value without division/rounding through binary dollars. */
export function formatCentsExact(value: unknown): string {
  const cents = BigInt(readIntegerCents(value, "amount", true));
  const absolute = cents < BigInt(0) ? -cents : cents;
  return `${cents < BigInt(0) ? "-" : ""}${absolute / BigInt(100)}.${String(absolute % BigInt(100)).padStart(2, "0")}`;
}

/**
 * Compatibility for APIs whose published contract requires numeric dollars
 * (for example Shopify's draft-discount Float). Do not use for money math.
 * Conversion happens after cent validation and must survive JSON round-trip.
 */
export function centsToJsonDollars(value: unknown): number {
  const cents = readIntegerCents(value, "JSON money", true);
  const decimal = Number(formatCentsExact(cents));
  if (parseDecimalCents(decimal, "JSON money", true) !== cents)
    throw new MoneyInputError("JSON money", "dollars", true);
  return decimal;
}

export function decimalForJson(value: unknown, field = "amount", signed = false): number {
  return centsToJsonDollars(parseDecimalCents(value, field, signed));
}

/** Half-up scaling of a non-negative cent amount by an exact decimal rate. */
export function scaleCentsByRate(amount: unknown, rate: unknown): number {
  const cents = readIntegerCents(amount, "scaled amount");
  if (typeof rate !== "string" && typeof rate !== "number")
    throw new MoneyInputError("rate", "rate");
  const match = /^(\d{1,10})(?:\.(\d{1,10}))?$/.exec(String(rate));
  if (!match) throw new MoneyInputError("rate", "rate");
  const fraction = match[2] ?? "";
  const denominator = BigInt("1" + "0".repeat(fraction.length));
  const numerator = BigInt(match[1]) * denominator + BigInt(fraction || "0");
  return checkedCents((BigInt(cents) * numerator * BigInt(2) + denominator) / (denominator * BigInt(2)), "scaled amount", "cents", false);
}
