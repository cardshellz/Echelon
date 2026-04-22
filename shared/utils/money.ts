// shared/utils/money.ts
//
// Money helpers used across server + client.
//
// Two precisions are supported:
//   * cents (1/100 of a dollar)  — the default unit for EVERYTHING EXCEPT
//     per-unit cost (line totals, PO header, invoices, payments, COGS,
//     margin). Integer-only, no floats.
//   * mills (1/10000 of a dollar) — used for per-unit cost ONLY, so we can
//     carry 4 decimals ($0.0375 = 375 mills). Authoritative when present;
//     the cents mirror column is rounded half-up for back-compat.
//
// Integer math throughout. Floating-point is never allowed on the money path
// (coding-standards.md Rule #3: "Never use floating point for money").
//
// All rounding is bankers-free "half away from zero" (commonly called
// "half up" for non-negative inputs). We reject negatives in the mills
// helpers because per-unit cost is never negative in this system.

// ─── Cents helpers (legacy) ───────────────────────────────────────────

/**
 * Parse a user-typed dollar string into integer cents without floating
 * point. Accepts "12.34", "12", ".34", "-5.00", "$1,234.56", etc. Anything
 * non-numeric is stripped. Truncates at the 2nd decimal (does NOT round);
 * preserved for back-compat with existing callers across the client.
 */
export function dollarsToCents(dollars: string | number): number {
  const val = String(dollars).trim();
  if (!val) return 0;
  const parts = val.replace(/[^0-9.-]/g, "").split(".");
  const whole = parseInt(parts[0] || "0", 10);
  const frac = (parts[1] || "00").padEnd(2, "0").slice(0, 2);
  const cents = parseInt(frac, 10);
  return whole * 100 + (whole < 0 ? -cents : cents);
}

// ─── Mills helpers (per-unit cost, 4-decimal precision) ───────────────

/**
 * Round a non-negative rational `numerator / denominator` to the nearest
 * integer, ties going away from zero (half-up). Pure integer math.
 * Throws on non-integer / negative inputs.
 */
function roundHalfUp(numerator: number, denominator: number): number {
  if (!Number.isInteger(numerator) || !Number.isInteger(denominator)) {
    throw new RangeError("roundHalfUp requires integer inputs");
  }
  if (denominator <= 0) {
    throw new RangeError("roundHalfUp requires a positive denominator");
  }
  if (numerator < 0) {
    // We don't carry negative money anywhere on this path. Callers should
    // never hit this; reject loudly so bugs surface fast.
    throw new RangeError("roundHalfUp requires a non-negative numerator");
  }
  // Integer half-up: q + 1 if the remainder * 2 >= denominator, else q.
  const q = Math.floor(numerator / denominator);
  const r = numerator - q * denominator;
  return r * 2 >= denominator ? q + 1 : q;
}

/**
 * Parse a user-typed dollar string into non-negative integer mills
 * (1/10000 of a dollar). Examples:
 *
 *   "0.0375" -> 375
 *   "1.2345" -> 12345
 *   "10"     -> 100000
 *   ""       -> 0
 *
 * Rules:
 *   * Non-numeric, NaN, Infinity, or negative input → RangeError (caller
 *     should validate first; we fail loud rather than silently).
 *   * 5th+ fractional digit is rounded half-up ("0.12345" → 1235 mills
 *     because the 5 rounds the 4 up).
 *   * Empty string and a lone "." → 0 (matches dollarsToCents).
 */
export function dollarsToMills(input: string | number): number {
  if (input === null || input === undefined) return 0;
  const raw = String(input).trim();
  if (raw === "" || raw === ".") return 0;

  // Reject junk up-front. No thousands-separator support on this path;
  // callers should strip "$" / "," before passing in if needed.
  // We allow a single leading sign and a single decimal point.
  if (!/^[+-]?\d*\.?\d*$/.test(raw)) {
    throw new RangeError(`dollarsToMills: non-numeric input "${input}"`);
  }

  const sign = raw.startsWith("-") ? -1 : 1;
  if (sign < 0) {
    throw new RangeError(`dollarsToMills: negative input "${input}"`);
  }

  const abs = raw.replace(/^[+-]/, "");
  const [wholeRaw = "0", fracRaw = ""] = abs.split(".");
  // "0.0375" -> whole=0, frac="0375"
  // Pad to at least 5 so we see the rounding digit; take first 5.
  const fracPadded = fracRaw.padEnd(5, "0").slice(0, 5);
  const whole = parseInt(wholeRaw || "0", 10);
  const fourDecimals = parseInt(fracPadded.slice(0, 4) || "0", 10);
  const fifthDigit = parseInt(fracPadded[4] || "0", 10);

  if (!Number.isFinite(whole) || !Number.isFinite(fourDecimals)) {
    throw new RangeError(`dollarsToMills: unparsable input "${input}"`);
  }

  // whole dollars -> mills = whole * 10000
  // plus the first 4 decimal digits as-is
  // plus 1 mill if the 5th digit rounds up (half-up).
  const mills = whole * 10000 + fourDecimals + (fifthDigit >= 5 ? 1 : 0);

  if (!Number.isSafeInteger(mills)) {
    throw new RangeError(`dollarsToMills: input exceeds safe integer range`);
  }
  return mills;
}

/**
 * Format mills as a plain 4-decimal dollar string. Always emits 4
 * fractional digits — never truncates. No currency symbol, no thousands
 * separators.
 *
 *   375   -> "0.0375"
 *   12345 -> "1.2345"
 *   0     -> "0.0000"
 */
export function millsToDollarString(mills: number): string {
  if (!Number.isInteger(mills)) {
    throw new RangeError("millsToDollarString requires an integer");
  }
  if (mills < 0) {
    throw new RangeError("millsToDollarString requires a non-negative value");
  }
  const whole = Math.floor(mills / 10000);
  const frac = mills - whole * 10000;
  return `${whole}.${String(frac).padStart(4, "0")}`;
}

/**
 * Format mills as a currency-prefixed 4-decimal string.
 *   375 -> "$0.0375"
 * Thousands separators are added to the whole-dollar part to match the
 * display conventions elsewhere in the app.
 */
export function formatMills(mills: number | null | undefined): string {
  const m = Number(mills) || 0;
  if (!Number.isInteger(m) || m < 0) {
    // Render a safe fallback rather than throwing in a view layer.
    return "$0.0000";
  }
  const whole = Math.floor(m / 10000);
  const frac = m - whole * 10000;
  const wholeStr = whole.toLocaleString("en-US");
  return `$${wholeStr}.${String(frac).padStart(4, "0")}`;
}

/**
 * Convert mills to cents, rounding half-up at the 2nd decimal.
 *   375 mills ($0.0375) -> 4 cents  (.75 of a cent rounds up)
 *   374 mills ($0.0374) -> 4 cents  (.74 of a cent rounds up, 374/100=3.74)
 *                                     Actually: 374/100 = 3.74 -> 4. That's half-up.
 *   350 mills ($0.0350) -> 4 cents  (exactly 3.5, ties go up)
 *   349 mills ($0.0349) -> 3 cents
 */
export function millsToCents(mills: number): number {
  if (!Number.isInteger(mills)) {
    throw new RangeError("millsToCents requires an integer");
  }
  if (mills < 0) {
    throw new RangeError("millsToCents requires a non-negative value");
  }
  return roundHalfUp(mills, 100);
}

/**
 * Convert cents to mills — exact, no rounding. 1 cent = 100 mills.
 */
export function centsToMills(cents: number): number {
  if (!Number.isInteger(cents)) {
    throw new RangeError("centsToMills requires an integer");
  }
  if (cents < 0) {
    throw new RangeError("centsToMills requires a non-negative value");
  }
  const mills = cents * 100;
  if (!Number.isSafeInteger(mills)) {
    throw new RangeError("centsToMills overflow: cents * 100 exceeds safe range");
  }
  return mills;
}

/**
 * Compute line total in cents from mills unit cost × integer order quantity.
 *   lineTotalCents = round_half_up(unitCostMills * orderQty / 100)
 *
 * Rationale: 1 mill × 1 unit = $0.0001. At the line level we collapse back
 * to cents (spec: "Everything else stays in CENTS"). Integer math only;
 * half-up at the sub-cent boundary.
 */
export function computeLineTotalCentsFromMills(
  unitCostMills: number,
  orderQty: number,
): number {
  if (!Number.isInteger(unitCostMills)) {
    throw new RangeError("computeLineTotalCentsFromMills: unitCostMills must be integer");
  }
  if (!Number.isInteger(orderQty)) {
    throw new RangeError("computeLineTotalCentsFromMills: orderQty must be integer");
  }
  if (unitCostMills < 0) {
    throw new RangeError("computeLineTotalCentsFromMills: unitCostMills must be >= 0");
  }
  if (orderQty < 0) {
    throw new RangeError("computeLineTotalCentsFromMills: orderQty must be >= 0");
  }
  if (orderQty === 0 || unitCostMills === 0) return 0;

  const product = unitCostMills * orderQty;
  if (!Number.isSafeInteger(product)) {
    throw new RangeError(
      "computeLineTotalCentsFromMills: unit_cost_mills * order_qty exceeds safe integer range",
    );
  }
  return roundHalfUp(product, 100);
}
