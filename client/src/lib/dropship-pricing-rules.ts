import { pricingProfileSchema, type PricingProfile, type PricingRecipe } from "@shared/dropship/pricing-rules";
import { listingPriceInput } from "./dropship-listing-price";

export type RecipeDraft = { basis: PricingRecipe["basis"]; percentage: string; flat: string; rounding: PricingRecipe["rounding"] };
export type GroupDraft = { id: string; name: string; priority: string; scope: PricingProfile["groups"][number]["scope"]; recipe: RecipeDraft };
export type ProfileDraft = { defaultRecipe: RecipeDraft; groups: GroupDraft[] };
export function recipeDraft(recipe: PricingRecipe): RecipeDraft {
  return { basis: recipe.basis, percentage: listingPriceInput(recipe.markupBps), flat: listingPriceInput(recipe.flatCents), rounding: recipe.rounding };
}
export function profileDraft(profile: PricingProfile | null): ProfileDraft {
  return { defaultRecipe: recipeDraft(profile?.defaultRecipe ?? { basis: "product_cost", markupBps: 0, flatCents: 0, rounding: "cent" }),
    groups: profile?.groups.map((group) => ({ ...group, priority: String(group.priority), recipe: recipeDraft(group.recipe) })) ?? [] };
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
