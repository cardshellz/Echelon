/**
 * Currency validation at every boundary.
 *
 * Per coding-standards Rule #3 and refactor plan v2 invariant #9:
 *   - Money is ALWAYS integer cents.
 *   - No floats. No `|| 0` fallbacks. No NaN tolerance.
 *   - Validate at every boundary — webhook ingest, DB read, SS push.
 *
 * This module provides:
 *   - `CentsSchema`           — non-negative integer cents (default).
 *   - `PositiveCentsSchema`   — strictly positive integer cents, for
 *     fields where zero is a bug (e.g. `amount_paid_cents` on a paid
 *     order, `unit_price_cents` on a billable line).
 *   - `CurrencyCodeSchema`    — 3-letter ISO 4217 currency.
 *   - `ensureCents` / `ensurePositiveCents` — throwing guards with
 *     structured messages.
 *
 * No database dependency; safe to import from anywhere including
 * client bundles.
 */

import { z } from "zod";

// ─── Currency code ───────────────────────────────────────────────────
//
// ISO 4217 alpha-3. We don't validate against the full registry here
// (overkill for our integration surface) — upper-case 3-letter string
// is sufficient. Callers with a closed-set constraint (e.g. "USD only"
// for a channel) should narrow further.

export const CurrencyCodeSchema = z
  .string()
  .trim()
  .length(3, "currency must be a 3-letter ISO 4217 code")
  .regex(/^[A-Z]{3}$/, "currency must be upper-case A–Z");

export type CurrencyCode = z.infer<typeof CurrencyCodeSchema>;

// ─── Cents schemas ───────────────────────────────────────────────────

/**
 * Non-negative integer cents. Accepts `0`. Rejects:
 *   - floats (`0.5`, `1.99`)
 *   - NaN, Infinity
 *   - negative values
 *   - non-number types (strings, bigints, null, undefined)
 *
 * Use this for fields where zero is semantically valid (e.g.
 * `discount_cents`, `tax_cents` on a tax-exempt order).
 */
export const CentsSchema = z
  .number({ invalid_type_error: "cents must be a number" })
  .int("cents must be an integer (no fractional cents)")
  .nonnegative("cents must be >= 0")
  .finite("cents must be finite");

/**
 * Strictly positive integer cents. Use for fields where zero is a bug
 * (e.g. `amount_paid_cents` on a paid order, `unit_price_cents` on a
 * billable line, `total_price_cents` on any line with qty > 0).
 */
export const PositiveCentsSchema = z
  .number({ invalid_type_error: "cents must be a number" })
  .int("cents must be an integer (no fractional cents)")
  .positive("cents must be > 0")
  .finite("cents must be finite");

// ─── Throwing guards ─────────────────────────────────────────────────
//
// Prefer these at boundaries where the caller wants to fail loud. The
// error message includes the field name + offending value so logs are
// useful without the caller adding context.

export class CurrencyValidationError extends RangeError {
  readonly code = "CURRENCY_VALIDATION_ERROR" as const;
  constructor(
    public readonly field: string,
    public readonly value: unknown,
    issue: string,
  ) {
    super(`${field}: ${issue} (got ${JSON.stringify(value)})`);
    this.name = "CurrencyValidationError";
  }
}

export function ensureCents(field: string, value: unknown): number {
  const result = CentsSchema.safeParse(value);
  if (!result.success) {
    throw new CurrencyValidationError(
      field,
      value,
      result.error.issues.map((i) => i.message).join("; "),
    );
  }
  return result.data;
}

export function ensurePositiveCents(field: string, value: unknown): number {
  const result = PositiveCentsSchema.safeParse(value);
  if (!result.success) {
    throw new CurrencyValidationError(
      field,
      value,
      result.error.issues.map((i) => i.message).join("; "),
    );
  }
  return result.data;
}

export function ensureCurrencyCode(field: string, value: unknown): CurrencyCode {
  const result = CurrencyCodeSchema.safeParse(value);
  if (!result.success) {
    throw new CurrencyValidationError(
      field,
      value,
      result.error.issues.map((i) => i.message).join("; "),
    );
  }
  return result.data;
}

// ─── Line-total reconciliation helper ────────────────────────────────
//
// Push validation needs: sum of (unit_price × qty) per line must match
// the order's total_cents within a small tolerance (1¢ per line for
// rounding). This helper centralizes that check so every caller uses
// the same rule.

/**
 * Returns `true` if `expectedTotalCents` is within `tolerancePerLine × lineCount`
 * of `computedTotalCents`. Both inputs must be integer cents (or the
 * function throws).
 */
export function isLineSumWithinTolerance(
  expectedTotalCents: number,
  computedTotalCents: number,
  lineCount: number,
  tolerancePerLine = 1,
): boolean {
  ensureCents("expectedTotalCents", expectedTotalCents);
  ensureCents("computedTotalCents", computedTotalCents);
  if (!Number.isInteger(lineCount) || lineCount < 0) {
    throw new CurrencyValidationError(
      "lineCount",
      lineCount,
      "must be a non-negative integer",
    );
  }
  if (!Number.isInteger(tolerancePerLine) || tolerancePerLine < 0) {
    throw new CurrencyValidationError(
      "tolerancePerLine",
      tolerancePerLine,
      "must be a non-negative integer",
    );
  }
  const maxDelta = tolerancePerLine * lineCount;
  return Math.abs(expectedTotalCents - computedTotalCents) <= maxDelta;
}
