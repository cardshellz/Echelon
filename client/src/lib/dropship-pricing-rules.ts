import { pricingProfileSchema, type PricingImpactRow, type PricingProfile, type PricingRecipe } from "@shared/dropship/pricing-rules";
import { displayListingPrice, listingPriceInput } from "./dropship-listing-price";

export type RecipeDraft = { basis: PricingRecipe["basis"]; percentage: string; flat: string; rounding: PricingRecipe["rounding"] };
export type GroupDraft = { id: string; name: string; priority: string; scope: PricingProfile["groups"][number]["scope"]; recipe: RecipeDraft };
export type ProfileDraft = { defaultRecipe: RecipeDraft; groups: GroupDraft[] };
export function recipeDraft(recipe: PricingRecipe): RecipeDraft {
  return { basis: recipe.basis, percentage: listingPriceInput(recipe.markupBps), flat: listingPriceInput(recipe.flatCents), rounding: recipe.rounding };
}
/**
 * What a store with no saved pricing rules starts from: the catalog reference
 * retail, unchanged. Starting from the .ops cost + 0% meant applying the form
 * as it opened listed every size at cost. It is only a suggestion until the
 * vendor reviews and applies it.
 */
export const SUGGESTED_PRICING_RECIPE: PricingRecipe = { basis: "catalog_retail", markupBps: 0, flatCents: 0, rounding: "cent" };
export function profileDraft(profile: PricingProfile | null): ProfileDraft {
  return { defaultRecipe: recipeDraft(profile?.defaultRecipe ?? SUGGESTED_PRICING_RECIPE),
    groups: profile?.groups.map((group) => ({ ...group, priority: String(group.priority), recipe: recipeDraft(group.recipe) })) ?? [] };
}
/**
 * Whether two drafts hold the same text in every field. The same value typed
 * another way ("0" for "0.00") counts as a change. Both come from profileDraft
 * or its edits, so their keys share one order.
 */
export function pricingDraftsMatch(a: ProfileDraft, b: ProfileDraft): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
export function parseNonnegativeHundredths(value: string, label: string): number {
  if (!/^\d+(?:\.\d{1,2})?$/.test(value.trim()) || value.length > 20) throw new Error(`${label} needs a nonnegative number with at most two decimal places.`);
  const [whole, fraction = ""] = value.trim().split(".");
  const number = BigInt(whole) * BigInt(100) + BigInt(fraction.padEnd(2, "0"));
  if (number > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${label} is too large.`);
  return Number(number);
}
export function parseProfileDraft(draft: ProfileDraft): PricingProfile {
  const recipe = (row: RecipeDraft): PricingRecipe => ({ basis: row.basis, rounding: row.rounding,
    markupBps: parseNonnegativeHundredths(row.percentage, "Markup percentage"), flatCents: parseNonnegativeHundredths(row.flat, "Flat markup") });
  const result = pricingProfileSchema.safeParse({ defaultRecipe: recipe(draft.defaultRecipe), groups: draft.groups.map((group) => ({
    ...group, priority: /^\d+$/.test(group.priority) ? Number(group.priority) : NaN, recipe: recipe(group.recipe),
  })) });
  if (!result.success) throw new Error(result.error.issues[0]?.message ?? "Check the rule fields.");
  return result.data;
}

/**
 * What a reviewed price is built from, in the same words as the "Price basis"
 * choices above the table, so the vendor can see why the price came out as it
 * did. A review stored before rows carried the basis shows a dash.
 */
export function describePriceBasis(row: Pick<PricingImpactRow, "preserved" | "basis" | "basisCents">): string {
  if (row.preserved) return "Your fixed price";
  if (row.basis === "catalog_retail") {
    return row.basisCents == null ? "No catalog reference retail" : `Reference retail ${displayListingPrice(row.basisCents)}`;
  }
  if (row.basis === "product_cost") {
    return row.basisCents == null ? "No .ops product cost" : `.ops cost ${displayListingPrice(row.basisCents)}`;
  }
  return "—";
}

/** The size name and SKU under a listing's title, without empty parts. */
export function describeReviewedSize(row: Pick<PricingImpactRow, "sizeName" | "sku">): string {
  return [row.sizeName?.trim(), row.sku?.trim()].filter((part): part is string => Boolean(part)).join(" · ");
}
