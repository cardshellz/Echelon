/**
 * Integer money arithmetic for the Dropship "Program finance" page
 * (contract §2.10). One implementation for the server, which builds every
 * figure, and the client, whose tests check the same vectors.
 *
 * Everything here is BigInt and pure: no clock, no I/O, no floats. Postgres
 * returns SUM(bigint) as numeric text, so sums arrive as strings, are parsed
 * with parseIntegerString, are added and divided as BigInt, and are turned
 * into JSON numbers only at the edge by toSafeNumber, which refuses a value it
 * cannot represent exactly instead of rounding it (CLAUDE.md §4).
 *
 * The repository targets an ES level without BigInt literals, so constants
 * are built with BigInt(n) once, here.
 */

const ZERO = BigInt(0);
const ONE = BigInt(1);
const TWO = BigInt(2);

/** One cent is 100 mills ($0.0001 each), the unit OMS cost rows use. */
export const MILLS_PER_CENT = BigInt(100);
/** Half a cent in mills: the tie point of mills-to-cents rounding. */
const HALF_CENT_IN_MILLS = BigInt(50);
/** Percent in tenths: 25.0% is 250, so a ratio is scaled by 100 × 10. */
export const TENTHS_SCALE = BigInt(1000);
/** Percent in basis points: 25.00% is 2500, so a ratio is scaled by 100 × 100. */
export const BPS_SCALE = BigInt(10000);

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER);

/** Optional minus, then digits only: no plus sign, spaces, decimal point or exponent. */
const INTEGER_TEXT = /^-?\d+$/;

function absolute(value: bigint): bigint {
  return value < ZERO ? -value : value;
}

/**
 * Signed mills to cents, half away from zero: 149 → 1, 150 → 2, −150 → −2,
 * −149 → −1. Byte for byte the rule of the server's SQL fragment
 * `CASE WHEN m < 0 THEN -((-m + 50) / 100) ELSE (m + 50) / 100 END`
 * (Postgres bigint division and BigInt division both truncate toward zero).
 *
 * shared/utils/money.ts millsToCents is not used: it throws on a negative
 * value, and cost rows are signed (an unpick writes a negative row).
 */
export function signedMillsToCents(mills: bigint): bigint {
  if (mills < ZERO) return -((-mills + HALF_CENT_IN_MILLS) / MILLS_PER_CENT);
  return (mills + HALF_CENT_IN_MILLS) / MILLS_PER_CENT;
}

/**
 * numerator ÷ denominator rounded half away from zero; null when the
 * denominator is zero (a share of nothing has no value, and is never 0).
 * The sign follows ordinary division, so a negative denominator flips it.
 */
export function roundHalfAwayFromZero(numerator: bigint, denominator: bigint): bigint | null {
  if (denominator === ZERO) return null;
  const magnitude = (TWO * absolute(numerator) + absolute(denominator)) / (TWO * absolute(denominator));
  const negative = (numerator < ZERO) !== (denominator < ZERO);
  return negative ? -magnitude : magnitude;
}

/**
 * A ratio as signed tenths of a percent (3881 of 9730 → 399, i.e. 39.9%).
 * Computed from the same integers as toBps, so the two never disagree by a
 * double rounding.
 */
export function toTenths(numerator: bigint, denominator: bigint): bigint | null {
  return roundHalfAwayFromZero(numerator * TENTHS_SCALE, denominator);
}

/** A ratio as signed basis points (3881 of 9730 → 3989, i.e. 39.89%), for the CSV. */
export function toBps(numerator: bigint, denominator: bigint): bigint | null {
  return roundHalfAwayFromZero(numerator * BPS_SCALE, denominator);
}

/**
 * Integer text as Postgres sends int8 and numeric values ("-12", "0",
 * "90071992547409920"), as a BigInt. Anything else is null: "1.5", "1e3",
 * "", " 1", "+1". A null result means the value is not an integer; the
 * caller reports it as bad data and never treats it as zero.
 *
 * node-postgres returns int4 columns as numbers; String(value) of an
 * integer number is accepted text, and of a fraction or an exponent form
 * it is not.
 */
export function parseIntegerString(text: string): bigint | null {
  if (!INTEGER_TEXT.test(text)) return null;
  return BigInt(text);
}

/**
 * A BigInt as a JSON-safe number, or null when it is outside
 * ±Number.MAX_SAFE_INTEGER. The caller marks that figure unavailable with
 * DROPSHIP_FINANCE_AMOUNT_OUT_OF_RANGE; it is never shown as $0.00.
 */
export function toSafeNumber(value: bigint): number | null {
  if (value > MAX_SAFE || value < MIN_SAFE) return null;
  return Number(value);
}

/**
 * Splits `scale` whole units across `parts` in proportion to each part's
 * share of `total`, so the results add up to exactly `scale` (the "of each
 * $1" cents and the bar widths, contract §2.10).
 *
 * Each part first gets floor(part × scale ÷ total). The units left over go
 * one each to the parts with the largest remainders. A tie goes to the part
 * listed first, so callers fix the order (kept, cost of goods, labels, pool,
 * waiting).
 *
 * Null when the split would mean nothing: a non-positive scale or total, a
 * negative part (a loss is not a share of what we billed), or parts that do
 * not add up to the total (the caller's identity is broken; check P1 reports
 * it). The input array is not changed.
 */
export function largestRemainder(parts: readonly bigint[], total: bigint, scale: bigint): bigint[] | null {
  if (scale <= ZERO || total <= ZERO || parts.length === 0) return null;
  let sum = ZERO;
  for (const part of parts) {
    if (part < ZERO) return null;
    sum += part;
  }
  if (sum !== total) return null;

  const shares = parts.map((part) => (part * scale) / total);
  const remainders = parts.map((part) => (part * scale) % total);
  let unitsLeft = scale - shares.reduce((acc, share) => acc + share, ZERO);

  const byRemainder = parts
    .map((_, index) => index)
    .sort((a, b) => {
      if (remainders[a] === remainders[b]) return a - b;
      return remainders[a] > remainders[b] ? -1 : 1;
    });
  // Every remainder is below `total`, so the floors fall short of `scale` by
  // fewer units than there are parts: one pass hands out every unit.
  for (const index of byRemainder) {
    if (unitsLeft === ZERO) break;
    shares[index] += ONE;
    unitsLeft -= ONE;
  }
  return shares;
}
