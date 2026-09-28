/**
 * A listing priced under the .ops cost of one sellable pack loses money on
 * every sale. The vendor is warned and never blocked: the loss is theirs to
 * take (owner decision, 2026-09-28), and the cost change policy decides what
 * happens to such a listing after a later cost increase.
 */
export const LISTING_PRICE_BELOW_COST_WARNING = "price_below_product_cost";

/**
 * Compares the price a push would publish with the cost of one sellable pack,
 * the unit an accepted order is charged at. Without a usable price or cost
 * there is nothing to compare: the price blockers and the economics panel
 * already report those.
 */
export function evaluateListingPriceAgainstCost(input: {
  priceCents: number | null;
  unitCostCents: number | null;
}): { warnings: string[] } {
  if (!isCents(input.priceCents) || !isCents(input.unitCostCents)) return { warnings: [] };
  return { warnings: input.priceCents < input.unitCostCents ? [LISTING_PRICE_BELOW_COST_WARNING] : [] };
}

function isCents(value: number | null): value is number {
  return value !== null && Number.isSafeInteger(value) && value >= 0;
}
