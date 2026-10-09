import type { ListingPriceSetting } from "@shared/dropship/listing-price";
import type { ListingSettingsPriceIssue, ListingSettingsSizePrice } from "@shared/dropship/listing-settings";
import type { PricingRecipe } from "@shared/dropship/pricing-rules";
import { displayListingPrice } from "./dropship-listing-price";

/**
 * The vendor's words for a size's price on the Listing settings step: the
 * store default recipe, where a size's price comes from ("Built from"), and
 * why a size has no price or falls back to its retail price.
 *
 * Words come from the design record (Listing settings redesign, R:578 and
 * R:593) unless marked interim. Interim words live here only, so the later
 * PRs can replace them in one place. No raw code is ever returned (C10).
 *
 * Pure and integer-only: every amount is integer cents or basis points.
 */

/** The name `resolvePricingRule` gives the store default recipe (shared/dropship/pricing-rules.ts). */
const STORE_DEFAULT_RULE_NAME = "Store default rule";
const BPS_PER_PERCENT = 100;

/** Integer cents as dollars, e.g. 1250 -> "$12.50". */
export function formatCents(cents: number): string {
  return displayListingPrice(cents);
}

/**
 * Basis points as percent text with no trailing zeros: 2000 -> "20",
 * 1250 -> "12.5", 1 -> "0.01". Integer math only, never floating point.
 */
export function percentText(bps: number): string {
  if (!Number.isSafeInteger(bps) || bps < 0) throw new Error("A markup must be a whole number of basis points, zero or more.");
  const value = BigInt(bps);
  const whole = value / BigInt(BPS_PER_PERCENT);
  const fraction = String(value % BigInt(BPS_PER_PERCENT)).padStart(2, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : String(whole);
}

function markupWords(recipe: PricingRecipe): string {
  const flat = recipe.flatCents > 0 ? ` plus ${formatCents(recipe.flatCents)}` : "";
  return `+ ${percentText(recipe.markupBps)}%${flat}`;
}

/**
 * The store default recipe on the Store defaults card:
 * "Retail price + 20%, round up to .99" or "Your cost + 20% plus $1.00, to the cent".
 * The phone form is shorter (C24): "Retail + 20%, up to .99".
 */
export function recipeWords(recipe: PricingRecipe, form: "full" | "phone" = "full"): string {
  const start = recipe.basis === "catalog_retail" ? (form === "phone" ? "Retail" : "Retail price") : "Your cost";
  const rounding = recipe.rounding === "up_99" ? (form === "phone" ? "up to .99" : "round up to .99") : "to the cent";
  return `${start} ${markupWords(recipe)}, ${rounding}`;
}

/**
 * A rule's recipe with the amount it started from, as Built from lines read:
 * "retail $12.50 + 20%, up to .99", "your cost $9.80 + 35%". Rounding to the
 * cent adds no words. The amount is left out when it is not known.
 */
function ruleRecipeWords(recipe: PricingRecipe, basisAmountCents: number | null): string {
  const start = recipe.basis === "catalog_retail" ? "retail" : "your cost";
  const amount = basisAmountCents === null ? "" : ` ${formatCents(basisAmountCents)}`;
  const rounding = recipe.rounding === "up_99" ? ", up to .99" : "";
  return `${start}${amount} ${markupWords(recipe)}${rounding}`;
}

/** The fix shown under a size that uses its retail price because no pricing rule covers it (owner decision L1). Interim. */
export const RETAIL_FALLBACK_FIX = "Set a store price or type a price.";

/** Why the store's pricing rules can't price a size, as the bracket in the retail fallback words. Interim. */
const RULE_FAILURE_REASON: Readonly<Partial<Record<ListingSettingsPriceIssue, string>>> = {
  pricing_rule_priority_conflict: "two older group rules tie",
  pricing_basis_unavailable: "your cost isn't on file",
  pricing_result_out_of_range: "the price it gives is out of range",
};

/**
 * Built from words for an `inherit` size on its retail price, with the reason
 * (owner decision L1):
 * - no rule covers it: "No pricing rule covers this size, so it uses the retail price ($12.50).";
 * - the rules can't price it: "Your pricing rules can't price this size (two older group rules tie), so it uses the retail price ($12.50)."
 *
 * `pricing_basis_unavailable` is a missing cost here: a retail fallback has a
 * retail price, so a rule starting from retail always had its amount.
 */
function retailFallbackWords(issue: ListingSettingsPriceIssue | null, retailCents: number | null): string {
  const retail = retailCents === null ? "the retail price" : `the retail price (${formatCents(retailCents)})`;
  if (issue === null || issue === "pricing_rules_not_configured") return `No pricing rule covers this size, so it uses ${retail}.`;
  const reason = RULE_FAILURE_REASON[issue];
  return `Your pricing rules can't price this size${reason ? ` (${reason})` : ""}, so it uses ${retail}.`;
}

/**
 * The fix for a retail fallback, or null when there is none to show: only a
 * size no rule covers gets "Set a store price or type a price." (L1). A size
 * whose rules can't price it is told why in its Built from words instead.
 */
export function retailFallbackFixWords(price: Pick<ListingSettingsSizePrice, "source" | "issue">): string | null {
  if (price.source !== "retail_fallback") return null;
  return price.issue === null || price.issue === "pricing_rules_not_configured" ? RETAIL_FALLBACK_FIX : null;
}

/** "Can't price: …" for a size with no price. Partly interim (see each line). */
function cannotPriceWords(issue: ListingSettingsPriceIssue | null, basis: ListingSettingsSizePrice["basis"]): string {
  switch (issue) {
    case "pricing_basis_unavailable":
      if (basis === "catalog_retail") return "Can't price: Card Shellz has no retail price for this size";
      if (basis === "product_cost") return "Can't price: your cost isn't on file. Contact support.";
      return "Can't price: what the store price starts from isn't on file"; // interim
    case "pricing_rule_priority_conflict": return "Can't price: two older group rules tie"; // interim
    case "pricing_result_out_of_range": return "Can't price: the rule's price is out of range"; // interim
    case "pricing_rules_not_configured": return "Can't price: no store price yet"; // interim
    case "price_unavailable": return "Can't price: Card Shellz has no retail price for this size";
    case null: return "Can't price this size"; // interim; the server always names an issue for a size with no price
  }
}

/** Where a size's price comes from, as the drawer, the Prices tab and the price check say it (R:593). */
export function builtFromWords(price: ListingSettingsSizePrice): string {
  switch (price.source) {
    case "exact": return "Exact price";
    case "rules": {
      if (!price.rule) return "Your pricing rules"; // interim; a rule-owned price always names its rule
      const recipe = ruleRecipeWords(price.rule.recipe, price.basisAmountCents);
      return price.rule.kind === "store_default" ? `Store default: ${recipe}`
        : `From your older group rule “${price.rule.name}”: ${recipe}`;
    }
    case "last_published": return "Last published price (no store price yet)";
    case "catalog_price": return price.settingRevisionId === null ? "Retail price (no store price yet)" : "Retail price (kept from before)";
    case "retail_fallback": return retailFallbackWords(price.issue, price.priceCents);
    case "none": return cannotPriceWords(price.issue, price.basis);
  }
}

const KNOWN_ISSUES: ReadonlySet<string> = new Set<ListingSettingsPriceIssue>([
  "pricing_rule_priority_conflict", "pricing_basis_unavailable", "pricing_result_out_of_range",
  "pricing_rules_not_configured", "price_unavailable",
]);

/** The W9 answer's rule issue as a known issue; anything else is treated as no price at all. */
function knownIssue(code: string | null | undefined): ListingSettingsPriceIssue {
  return code != null && KNOWN_ISSUES.has(code) ? code as ListingSettingsPriceIssue : "price_unavailable";
}

/** True when a W9 answer is an `inherit` size on its retail price because the rules give it none (L1). */
export function isW9RetailFallback(setting: Pick<ListingPriceSetting, "pricingMode" | "source">): boolean {
  return setting.pricingMode === "inherit" && setting.source === "catalog_default";
}

/**
 * The same words for the per-size price answer (W9,
 * `GET …/variants/:id/price`). W9 does not carry a rule's recipe, so a rule
 * price reads like the Built from line only for the store default, and only
 * when its recipe is passed in (the summary's `storeDefaults.price.recipe`).
 * A group rule is named with the amount it started from. HYPOTHESIS: no
 * group rule is itself named "Store default rule"; W9 cannot tell them apart.
 */
export function w9OriginWords(setting: ListingPriceSetting, storeDefaultRecipe: PricingRecipe | null = null): string {
  const basisAmountCents = setting.ruleBasis === "catalog_retail" ? setting.defaultPriceCents
    : setting.ruleBasis === "product_cost" ? setting.productCostCents ?? null : null;
  switch (setting.source) {
    case "override": return "Exact price";
    case "rules": {
      const name = setting.ruleName ?? null;
      if (name === null || name === STORE_DEFAULT_RULE_NAME) {
        if (storeDefaultRecipe) return `Store default: ${ruleRecipeWords(storeDefaultRecipe, basisAmountCents)}`;
        return basisStartWords("Store default", setting.ruleBasis ?? null, basisAmountCents);
      }
      return basisStartWords(`From your older group rule “${name}”`, setting.ruleBasis ?? null, basisAmountCents);
    }
    case "saved_listing": return "Last published price (no store price yet)";
    case "catalog_default": {
      if (isW9RetailFallback(setting)) {
        return retailFallbackWords(setting.rulesConfigured === true ? knownIssue(setting.pricingIssue) : null, setting.effectivePriceCents);
      }
      return setting.revisionId === null ? "Retail price (no store price yet)" : "Retail price (kept from before)";
    }
    case "unavailable": {
      // Only a size that follows the rules gets the rules' reason; W9 reports "rules" for an unsaved size on a store with rules.
      if (setting.pricingMode !== "rules") return cannotPriceWords("price_unavailable", null);
      if (setting.rulesConfigured !== true) return cannotPriceWords("pricing_rules_not_configured", null);
      return cannotPriceWords(knownIssue(setting.pricingIssue), setting.ruleBasis ?? null);
    }
  }
}

/** "Store default: retail $12.50" when the recipe is not known; the label alone when nothing is. */
function basisStartWords(label: string, basis: ListingPriceSetting["ruleBasis"] | null, amountCents: number | null): string {
  if (!basis) return label;
  const start = basis === "catalog_retail" ? "retail" : "your cost";
  return amountCents === null ? `${label}: ${start}` : `${label}: ${start} ${formatCents(amountCents)}`;
}
