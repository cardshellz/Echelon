import type { PricingRecipe } from "@shared/dropship/pricing-rules";

/**
 * What a store with no saved pricing rules starts from: the catalog reference
 * retail, unchanged. Starting from the .ops cost + 0% meant applying the form
 * as it opened listed every size at cost. It is only a suggestion until the
 * vendor reviews and applies it.
 */
export const SUGGESTED_PRICING_RECIPE: PricingRecipe = { basis: "catalog_retail", markupBps: 0, flatCents: 0, rounding: "cent" };
export function parseNonnegativeHundredths(value: string, label: string): number {
  if (!/^\d+(?:\.\d{1,2})?$/.test(value.trim()) || value.length > 20) throw new Error(`${label} needs a nonnegative number with at most two decimal places.`);
  const [whole, fraction = ""] = value.trim().split(".");
  const number = BigInt(whole) * BigInt(100) + BigInt(fraction.padEnd(2, "0"));
  if (number > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${label} is too large.`);
  return Number(number);
}
