const DAY_MS = 24 * 60 * 60 * 1_000;

export const RECOMMENDATION_SUPPLIER_QUOTE_MAX_AGE_DAYS = 365;
export const RECOMMENDATION_SUPPLIER_QUOTE_FUTURE_TOLERANCE_MS = 5 * 60 * 1_000;

export type SupplierQuoteValidityStatus =
  | "current"
  | "missing"
  | "invalid"
  | "future"
  | "expired"
  | "stale";

export interface SupplierQuoteValidityResult {
  status: SupplierQuoteValidityStatus;
  quotedAt: Date | null;
  ageDays: number | null;
  maxAgeDays: number;
  currentDate: string;
}

export interface SupplierQuoteValidityInput {
  quotedAt: Date | string | null | undefined;
  /** Calendar date derived by PostgreSQL from quoted_at in the DB session. */
  quotedAtDate?: string | null;
  quoteValidUntil?: string | null;
  asOf: Date | string;
  /** PostgreSQL current_date for the same transaction/statement as asOf. */
  currentDate?: string | null;
  maxAgeDays?: number;
  futureToleranceMs?: number;
}

function isIsoDateOnly(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function parseTimestamp(value: Date | string | null | undefined): Date | null {
  if (value == null) return null;
  const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function assessSupplierQuoteValidity(
  input: SupplierQuoteValidityInput,
): SupplierQuoteValidityResult {
  const asOf = parseTimestamp(input.asOf);
  if (!asOf) throw new RangeError("Supplier quote validity requires a valid as-of timestamp");

  const maxAgeDays = input.maxAgeDays ?? RECOMMENDATION_SUPPLIER_QUOTE_MAX_AGE_DAYS;
  const futureToleranceMs = input.futureToleranceMs ?? RECOMMENDATION_SUPPLIER_QUOTE_FUTURE_TOLERANCE_MS;
  if (!Number.isInteger(maxAgeDays) || maxAgeDays < 0) {
    throw new RangeError("Supplier quote maximum age must be a non-negative integer number of days");
  }
  if (!Number.isInteger(futureToleranceMs) || futureToleranceMs < 0) {
    throw new RangeError("Supplier quote future tolerance must be a non-negative integer number of milliseconds");
  }

  const currentDate = isIsoDateOnly(input.currentDate)
    ? input.currentDate
    : asOf.toISOString().slice(0, 10);
  const quotedAt = parseTimestamp(input.quotedAt);
  if (input.quotedAt == null) {
    return { status: "missing", quotedAt: null, ageDays: null, maxAgeDays, currentDate };
  }
  if (!quotedAt) {
    return { status: "invalid", quotedAt: null, ageDays: null, maxAgeDays, currentDate };
  }

  const quotedAtDate = isIsoDateOnly(input.quotedAtDate)
    ? input.quotedAtDate
    : quotedAt.toISOString().slice(0, 10);
  const ageDays = Math.max(0, (asOf.getTime() - quotedAt.getTime()) / DAY_MS);

  // The calendar-date guard catches date-only inputs for tomorrow even when
  // they happen to fall inside the timestamp clock-skew tolerance.
  if (
    quotedAtDate > currentDate ||
    quotedAt.getTime() > asOf.getTime() + futureToleranceMs
  ) {
    return { status: "future", quotedAt, ageDays: null, maxAgeDays, currentDate };
  }

  if (input.quoteValidUntil != null && !isIsoDateOnly(input.quoteValidUntil)) {
    return { status: "invalid", quotedAt, ageDays, maxAgeDays, currentDate };
  }
  if (input.quoteValidUntil != null && input.quoteValidUntil < currentDate) {
    return { status: "expired", quotedAt, ageDays, maxAgeDays, currentDate };
  }
  // The fallback age policy exists only when the supplier did not state an
  // expiry. An explicit inclusive valid-until date remains authoritative.
  if (
    input.quoteValidUntil == null &&
    asOf.getTime() - quotedAt.getTime() > maxAgeDays * DAY_MS
  ) {
    return { status: "stale", quotedAt, ageDays, maxAgeDays, currentDate };
  }

  return { status: "current", quotedAt, ageDays, maxAgeDays, currentDate };
}
