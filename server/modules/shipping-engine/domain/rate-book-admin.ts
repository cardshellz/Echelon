/**
 * Pure domain rules for pricing-program (rate book) administration.
 *
 * Operators work with program names and business labels; codes are stable
 * machine identifiers derived once at creation and never edited afterward,
 * because runtime assignment resolution and imports key on them.
 */

export const RATE_BOOK_CODE_MAX_LENGTH = 80;

/** Channels the rating engine currently understands (see rate_book_assignments). */
export const KNOWN_PRICING_CHANNELS = ["shopify", "internal", "dropship", "ebay"] as const;

/** Purposes distinguish shopper-facing prices from backend vendor charges. */
export const KNOWN_RATE_PURPOSES = ["customer_checkout", "vendor_fulfillment_charge"] as const;

/**
 * Derive a stable machine code from an operator-entered program name.
 * Lowercase alphanumerics joined by single dashes; never empty for a
 * name that contains at least one alphanumeric character.
 */
export function slugifyRateBookCode(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, RATE_BOOK_CODE_MAX_LENGTH)
    .replace(/-+$/g, "");
}

export interface RateBookAssignmentInput {
  pricingChannel: string;
  ratePurpose: string;
  originWarehouseId: number | null;
}

/**
 * An assignment set is internally consistent when no two entries claim the
 * same channel + purpose + warehouse scope. The partial unique indexes catch
 * cross-book conflicts at the database; this catches same-payload conflicts
 * before any write happens.
 */
export function findDuplicateAssignments(
  assignments: readonly RateBookAssignmentInput[],
): string[] {
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const assignment of assignments) {
    const key = [
      assignment.pricingChannel,
      assignment.ratePurpose,
      assignment.originWarehouseId ?? "all",
    ].join("|");
    if (seen.has(key)) {
      duplicates.push(describeAssignment(assignment));
    }
    seen.add(key);
  }
  return duplicates;
}

export function describeAssignment(assignment: RateBookAssignmentInput): string {
  const scope = assignment.originWarehouseId === null
    ? "all warehouses"
    : `warehouse ${assignment.originWarehouseId}`;
  return `${assignment.pricingChannel} / ${assignment.ratePurpose} / ${scope}`;
}
