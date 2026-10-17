import { createHash } from "node:crypto";
import { z } from "zod";
import { matchesCatalogScope, type CatalogScope } from "../../../../shared/dropship/catalog-scope";
import type { EbayCategory } from "../../../../shared/dropship/ebay-category-rules";
import type { DescriptionTemplate, ResolvedListingContent } from "../../../../shared/dropship/listing-content";
import type { SavedListingPriceRevision } from "../../../../shared/dropship/listing-price";
import {
  CONVERSION_BLOCKER_CODES, CONVERSION_CHANGED_FIELDS, CONVERSION_CONTENT_BLOCKER_CODES, CONVERSION_PAGE_SIZE, CONVERSION_RULE_KINDS,
  CONVERSION_SETTINGS, CONVERSION_TIE_SETTINGS, MAX_CONVERSION_PAGE, MAX_CONVERSION_REPORT_ITEMS,
  type ConversionBlockerCode, type ConversionChangeRow, type ConversionChangedField, type ConversionContentBlockerCode, type ConversionKept,
  type ConversionReportItem, type ConversionRuleKind, type ConversionSetting, type ConversionSizeView, type ConversionState,
  type ConversionTieSetting, type ListingRulesConversionCheck, type PricingRuleRef, type SizeRef,
} from "../../../../shared/dropship/listing-rules-conversion";
import type { ListingSettingsSizePrice } from "../../../../shared/dropship/listing-settings";
import {
  categoryListingSettingPatchSchema, categoryListingSettingRowSchema, productListingSettingPatchSchema, productListingSettingRowSchema,
  type CategoryListingSettingPatch, type CategoryListingSettingRow, type CategoryListingSettingValues,
  type ListingSettingTemplateText, type ProductListingSettingPatch, type ProductListingSettingRow,
} from "../../../../shared/dropship/listing-setting-values";
import { MAX_STORE_LISTING_TEXT_BYTES, patchTextBytes } from "../../../../shared/dropship/listing-setting-writes";
import { PRODUCT_PRICE_RULE_NAME, type PricingRecipe, type RulePriceResult } from "../../../../shared/dropship/pricing-rules";
import {
  CONVERSION_NAME_ORDER, assertConversionCategoriesByName, categoryNameMismatches, categoryTargets,
  type ConversionCategoriesByName, type ConversionCategory,
} from "../domain/listing-rules-conversion-names";
import { refuseListingPriceSave, type ListingPriceState } from "../domain/listing-price-save-guard";
import {
  EMPTY_CATEGORY_LISTING_SETTING_VALUES, EMPTY_PRODUCT_LISTING_SETTING_VALUES, applyListingSettingPatch, listingSettingsInvariantFailed,
} from "../domain/listing-setting-values";
import { prepareEbayCategoryRules, resolveEbayListingCategory } from "./dropship-ebay-category-resolver";
import {
  TEMPLATE_PART_SETTING, matchingContentGroups, prepareContentProfile, resolveListingContent,
} from "./dropship-listing-content-resolver";
import type { DropshipListingCatalogCandidate } from "./dropship-listing-preview-service";
import { layersFor, type ListingSettingLayers } from "./dropship-listing-setting-layers";
import {
  buildListingSettingsFacts, effectiveSizePrice, olderGroupRuleCounts,
  type ListingSettingsInputs, type ListingSettingsSizeFacts, type OlderGroupRuleCounts,
} from "./dropship-listing-settings-facts";
import { createRulePriceResolver, rulePriceContextOf, type RulePriceResolver } from "./dropship-rule-price";

/**
 * The PR 11 conversion planner (plan 4.A; design record 8.7, REC:886-901):
 * what moving a store's older group rules into category and product
 * settings would write, the report of what it cannot move, which chosen
 * sizes the move would change, what blocks it, and the two hashes an apply
 * is bound to. 11a2 serves it as the dry run; 11c2 recomputes it under the
 * store lock and writes the plan only when the hashes are the ones shown.
 *
 * One planner over the read model's own inputs (plan D2): today's winner of
 * every chosen size and setting comes from the resolvers the preview and the
 * push use (the rule price resolver, the eBay category resolver and the
 * description groups' walk), never from a copy of their rules.
 *
 * What becomes what (plan D5, 4.A.4):
 * - a category rule becomes a setting on every Card Shellz category whose
 *   name is exactly the rule's category name, chosen products or not;
 * - a product-line, product or named-size rule becomes a chosen product's own
 *   value only when it wins for every chosen size the setting reaches;
 * - ties, mixed winners and named-size rules on some sizes write nothing and
 *   are listed; an existing own value is never overwritten; per-size rows
 *   stay as they are and are counted (D6); the groups are emptied and the
 *   store defaults kept; every chosen product without a category mark gets
 *   its first one.
 *
 * What the move would change (plan D2, D3, 4.A.7-4.A.8): "before" is the read
 * model over the loaded inputs; "after" is the same read model over a new
 * inputs object with the group lists emptied and the planned rows in the
 * layers. Each chosen size is compared on plan 3.2's ten keys, among them the
 * pricing rule it follows whether or not that rule can price it today, so a
 * move that would shift a price only once a cost arrives is a change now.
 * A store is clean only when no size changes and nothing blocks the move.
 *
 * Pure: no I/O, no clock read, no randomness, no logging (plan 3.5), and no
 * input is ever mutated. Every list is sorted (writes by id, the report by
 * name, then id), so the plan is the same whatever order the inputs come in.
 * An input that cannot happen is refused with the fatal
 * DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED, never guessed past.
 */

/**
 * The planner's version, written into a failed system conversion's audit row
 * (plan 3.3, D20): a deploy that fixes the planner bumps it, which re-arms
 * the stores the job dead-lettered under the old one.
 */
export const RULES_CONVERSION_PLANNER_VERSION = 1;

/**
 * Everything the planner reads (plan 4.A.2), loaded in one snapshot (11a2).
 * `listing` is exactly what the read model builds (dropship-listing-settings.repository.ts).
 */
export interface ConversionInputs {
  listing: ListingSettingsInputs;
  /**
   * Every Card Shellz category, active or not, by its exact name, with a key
   * for every name conversionCategoryNamesToRead(listing) gives: the
   * categories with that name, or none. A name with no key was never looked
   * up and is refused (reading it as "no category has it" would drop the
   * rule's setting from a plan that can still be clean).
   */
  categoriesByName: ConversionCategoriesByName;
  /**
   * The current settings row of every category in `categoriesByName`, chosen
   * products or not, or null for one with no row (beside plan 4.A.2:
   * `listing.layers` holds only the chosen products' categories, and a
   * category rule is written to every target, whose row's revision the write
   * compares and whose own fields it never overwrites). A category with no
   * key was never read and is refused, for the same reason as a name.
   */
  categoryRows: ReadonlyMap<number, CategoryListingSettingRow | null>;
  /** The store's saved product text in UTF-8 bytes (the writers' store text cap reads the same sum). */
  storeTextBytes: number;
}

/** An older group rule as the planner reads it: its kind, id, name and scope, and the value it would become. */
export type ConversionRule =
  | { readonly kind: "price"; readonly id: string; readonly name: string; readonly scope: CatalogScope;
    readonly priority: number; readonly recipe: PricingRecipe }
  | { readonly kind: "description"; readonly id: string; readonly name: string; readonly scope: CatalogScope;
    readonly priority: number; readonly template: DescriptionTemplate }
  | { readonly kind: "ebayCategory"; readonly id: string; readonly name: string; readonly scope: CatalogScope;
    readonly category: EbayCategory };

/**
 * Who decides one setting of one chosen size today:
 * - `rule`: an older group rule wins;
 * - `tie`: two older rules tie at the top, so neither gives a value (price and description only);
 * - `own`: the product's own setting decides, so no rule reaches the size;
 * - `none`: no older rule decides (a category's setting, the store default, Card Shellz, or nothing).
 */
export type SettingWinner =
  | { readonly type: "rule"; readonly rule: ConversionRule }
  | { readonly type: "tie" }
  | { readonly type: "own" }
  | { readonly type: "none" };

/** Today's winners of one chosen size (plan 4.A.6). */
export interface SizeWinners {
  readonly candidate: DropshipListingCatalogCandidate;
  /** Null when the size owns its price, or no rule covers it: the price agreement leaves it out. */
  readonly price: SettingWinner | null;
  readonly ebayCategory: SettingWinner;
  readonly textAbove: SettingWinner;
  readonly textBelow: SettingWinner;
}

/** One group list the move empties: the revision it expects and the ids it removes, sorted. */
export interface PlannedProfileWrite {
  readonly expectedRevisionId: number;
  readonly removedIds: readonly string[];
}

/** The three group lists; null for a list already empty, which is not rewritten (plan 4.A.4, row 899). */
export interface PlannedProfileWrites {
  readonly pricing: PlannedProfileWrite | null;
  readonly content: PlannedProfileWrite | null;
  readonly ebayRules: PlannedProfileWrite | null;
}

/** One category's new settings: only the converted fields, over its row (if any) at `expectedRevisionId`. */
export interface PlannedCategoryWrite {
  readonly categoryId: number;
  /** The category's current Card Shellz name; display only. */
  readonly categoryName: string;
  readonly expectedRevisionId: number | null;
  readonly patch: CategoryListingSettingPatch;
  /** The settings the patch sets, in CONVERSION_SETTINGS order. */
  readonly settings: readonly ConversionSetting[];
}

/** One chosen product's new own values: only the converted fields, over its row (if any) at `expectedRevisionId`. */
export interface PlannedProductWrite {
  readonly productId: number;
  /** The product's Card Shellz name; display only. */
  readonly productName: string;
  readonly expectedRevisionId: number | null;
  readonly patch: ProductListingSettingPatch;
  readonly settings: readonly ConversionSetting[];
}

/** The report's lists in full, each sorted by name, then id (the view caps them, plan 4.A.3). */
export interface PlannedReport {
  readonly unmatched: readonly ConversionReportItem<"unmatched">[];
  readonly shared: readonly ConversionReportItem<"shared">[];
  readonly nameMismatches: readonly ConversionReportItem<"nameMismatches">[];
  readonly neverApplies: readonly ConversionReportItem<"neverApplies">[];
  readonly ties: readonly ConversionReportItem<"ties">[];
  readonly someSizesOnly: readonly ConversionReportItem<"someSizesOnly">[];
  readonly mixed: readonly ConversionReportItem<"mixed">[];
}

export interface RulesConversionPlan {
  readonly storeConnectionId: number;
  readonly olderRules: OlderGroupRuleCounts;
  readonly profiles: PlannedProfileWrites;
  /** By category id (the order the writer locks and writes them). */
  readonly categories: readonly PlannedCategoryWrite[];
  /** By product id. */
  readonly products: readonly PlannedProductWrite[];
  /** The chosen products that have no category mark yet, ascending (plan 4.A.4, rows 874 and 899). */
  readonly firstMarks: readonly number[];
  readonly report: PlannedReport;
  readonly kept: ConversionKept;
}

/** What a rule kind becomes on a category or a product: a pricing group its price, a description group both text parts. */
const KIND_SETTINGS: Readonly<Record<ConversionRuleKind, readonly ConversionSetting[]>> = {
  price: ["price"], description: ["textAbove", "textBelow"], ebayCategory: ["ebayCategory"],
};
/** The setting a tie of each setting is reported as (plan 4.A.3 `ties.setting`); eBay category rules never tie. */
const TIE_SETTING: Readonly<Record<ConversionSetting, ConversionTieSetting | null>> = {
  price: "price", ebayCategory: null, textAbove: "description", textBelow: "description",
};
const EMPTY_PROFILE_WRITES: PlannedProfileWrites = Object.freeze({ pricing: null, content: null, ebayRules: null });

// ---------------------------------------------------------------------------
// Today's winners (plan 4.A.6)
// ---------------------------------------------------------------------------

/**
 * Today's winner of each chosen size and setting, sorted as the read model
 * sorts sizes (product name, product id, size name, size id). Each comes from
 * the resolver the preview uses:
 * - price, for a size that does not own its price and that the rules cover:
 *   the rule price the read model resolves (followedRulePrice). The winner
 *   never depends on the cost (resolvePricingRule picks it by scope and
 *   priority before it prices), so it is known even when the cost is not;
 * - eBay category: resolveEbayListingCategory over the store's rules and layers;
 * - text above and below, each on its own: matchingContentGroups, reached only
 *   when the product does not set that part itself.
 */
export function todayWinners(listing: ListingSettingsInputs): SizeWinners[] {
  const rules = olderRules(listing);
  const resolver = createRulePriceResolver(rulePriceContextOf(listing.pricing, listing.layers));
  const ebay = prepareEbayCategoryRules(listing.ebayCategoryRules.revisionId, listing.ebayCategoryRules.profile, listing.layers);
  const content = prepareContentProfile(listing.content);
  return [...listing.candidates].sort(compareCandidates).map((candidate) => {
    const product = layersFor(listing.layers, candidate).product;
    const groups = matchingContentGroups(content, candidate);
    const textWinner = (setting: "textAbove" | "textBelow"): SettingWinner => {
      // A part the product sets itself never reaches the groups (the content resolver's order).
      if ((product?.[setting] ?? null) !== null) return OWN;
      if (groups.tie) return TIE;
      return groups.winner ? ruleWinner(rules, "description", groups.winner.id) : NONE;
    };
    const category = resolveEbayListingCategory(candidate, ebay);
    return {
      candidate,
      price: priceWinner(candidate, listing, resolver, rules),
      ebayCategory: category.source === "product" ? OWN
        : category.source === "rule" ? ruleWinner(rules, "ebayCategory", requiredRuleId(category.ruleId)) : NONE,
      textAbove: textWinner("textAbove"),
      textBelow: textWinner("textBelow"),
    };
  });
}

const OWN: SettingWinner = Object.freeze({ type: "own" });
const TIE: SettingWinner = Object.freeze({ type: "tie" });
const NONE: SettingWinner = Object.freeze({ type: "none" });

function priceWinner(candidate: DropshipListingCatalogCandidate, listing: ListingSettingsInputs, resolver: RulePriceResolver,
  rules: ReadonlyMap<string, ConversionRule>): SettingWinner | null {
  const result = followedRulePrice(candidate, listing, resolver);
  if (result === null) return null;
  const selection = ruleSelectionOf(result);
  switch (selection.level) {
    case "product": return OWN;
    // A category's own price wins only when no group matched (resolvePricingRule): no older rule decides.
    case "category": return NONE;
    case "tie": return TIE;
    // Nothing configured (no profile), or the store default: no older rule decides.
    case "not_configured": return NONE;
    case "store_default": return NONE;
    case "group": return ruleWinner(rules, "price", selection.ruleId);
  }
}

function ruleWinner(rules: ReadonlyMap<string, ConversionRule>, kind: ConversionRuleKind, ruleId: string): SettingWinner {
  const rule = rules.get(ruleKey(kind, ruleId));
  if (!rule) throw listingSettingsInvariantFailed("A resolver named an older rule its profile does not hold.", { kind, ruleId });
  return { type: "rule", rule };
}

function requiredRuleId(ruleId: string | null): string {
  if (ruleId === null) throw listingSettingsInvariantFailed("An eBay category from a rule carries no rule id.");
  return ruleId;
}

/**
 * A size owns its price when its saved setting never follows the rules: a
 * typed price, the catalog default, or a legacy row with no mode. The same
 * rule as the read model's (dropship-listing-settings-facts.ts
 * sizeOwnsPrice, which that module keeps private); a test pins the two to the
 * read model's rule-owned sizes.
 */
export function sizeOwnsPrice(saved: Pick<SavedListingPriceRevision, "pricingMode"> | null): boolean {
  return saved !== null && saved.pricingMode !== "rules" && saved.pricingMode !== "inherit";
}

/**
 * The rule price a chosen size follows, exactly as the read model resolves it
 * (effectiveSizePrice: the .ops cost, the rule price only when a rule covers
 * the size, with its Card Shellz limit check), or null for a size that owns
 * its price or that no rule covers. Both today's price winner and the
 * `pricingRule` key read it, so their cost and coverage are the read model's.
 */
function followedRulePrice(candidate: DropshipListingCatalogCandidate, listing: ListingSettingsInputs,
  resolver: RulePriceResolver): RulePriceResult | null {
  const id = candidate.productVariantId;
  const saved = listing.savedPrices.get(id) ?? null;
  if (sizeOwnsPrice(saved)) return null;
  return effectiveSizePrice({ candidate, saved, cost: listing.costs.get(id) ?? null, pricingPolicies: listing.pricingPolicies,
    existingListingPriceCents: listing.existingListings.get(id)?.vendorRetailPriceCents ?? null, resolver }).rulePrice;
}

// ---------------------------------------------------------------------------
// The pricing rule a size follows (plan 3.2)
// ---------------------------------------------------------------------------

/** Which rule a rule price was resolved from, without its cents or the issue of a priced rule. */
type RuleSelection =
  | { readonly level: "product" | "category" | "tie" | "not_configured" }
  | { readonly level: "store_default"; readonly ruleName: string }
  | { readonly level: "group"; readonly ruleId: string };

/**
 * The one reading of a rule price's winner, in the resolver's order
 * (shared/dropship/pricing-rules.ts resolvePricingRule): the product's own
 * price, the category's, a tie, nothing configured, the store default, else
 * a group. It never reads the cents, so it is the same at every cost, known
 * or not (the resolver keeps the winner when the basis is unavailable).
 */
function ruleSelectionOf(result: RulePriceResult): RuleSelection {
  if (result.ruleLevel === "product") return { level: "product" };
  if (result.ruleLevel === "category") return { level: "category" };
  if (result.issue === "pricing_rule_priority_conflict") return { level: "tie" };
  if (result.ruleName === null) return { level: "not_configured" };
  if (result.ruleId === null) return { level: "store_default", ruleName: result.ruleName };
  return { level: "group", ruleId: result.ruleId };
}

/**
 * The pricing rule a rule price was resolved from (ruleSelectionOf), each
 * named where the read model names it (dropship-listing-settings-facts.ts
 * describeRule), with its recipe. It reads only which rule won, so it is the
 * same at every cost (plan D3: the rule is compared even for a size that
 * can't be priced today). Pure.
 */
export function selectedPricingRule(result: RulePriceResult, candidate: DropshipListingCatalogCandidate,
  listing: Pick<ListingSettingsInputs, "pricing" | "layers" | "categoryNames">): PricingRuleRef | null {
  const selection = ruleSelectionOf(result);
  switch (selection.level) {
    case "product": {
      const recipe = listing.layers.products.get(candidate.productId)?.values.price ?? null;
      if (recipe === null) throw ruleWithoutRecipe("product", candidate);
      // A blank Card Shellz name cannot label a rule; the level's own name stands in (as the read model does).
      return { kind: "product", name: candidate.productName.trim() ? candidate.productName : PRODUCT_PRICE_RULE_NAME, recipe };
    }
    case "category": {
      const categoryId = candidate.categoryId;
      const recipe = categoryId === null ? null : listing.layers.categories.get(categoryId)?.values.price ?? null;
      const name = categoryId === null ? undefined : listing.categoryNames.get(categoryId);
      if (recipe === null || name === undefined) throw ruleWithoutRecipe("category", candidate);
      return { kind: "category", name, recipe };
    }
    case "tie": return { kind: "tie" };
    case "not_configured": return null;
    case "store_default": return { kind: "store_default", name: selection.ruleName, recipe: pricingProfileOf(listing, candidate).defaultRecipe };
    case "group": {
      const group = pricingProfileOf(listing, candidate).groups.find((row) => row.id === selection.ruleId);
      if (!group) throw listingSettingsInvariantFailed("A rule price named a group its profile does not hold.", sizeContext(candidate));
      return { kind: "group", name: group.name, recipe: group.recipe };
    }
  }
}

function pricingProfileOf(listing: Pick<ListingSettingsInputs, "pricing">, candidate: DropshipListingCatalogCandidate) {
  const profile = listing.pricing.profile;
  if (profile === null) throw listingSettingsInvariantFailed("A rule price named a rule with no pricing profile.", sizeContext(candidate));
  return profile;
}

/**
 * The pricing rule one chosen size follows (plan 3.2 `pricingRule`): null for
 * a size that owns its price or that no rule covers, else selectedPricingRule
 * over the rule price the read model resolves for it.
 */
export function sizePricingRule(candidate: DropshipListingCatalogCandidate, listing: ListingSettingsInputs,
  resolver: RulePriceResolver): PricingRuleRef | null {
  const result = followedRulePrice(candidate, listing, resolver);
  return result === null ? null : selectedPricingRule(result, candidate, listing);
}

function ruleWithoutRecipe(level: "product" | "category", candidate: DropshipListingCatalogCandidate) {
  return listingSettingsInvariantFailed(`A ${level} rule price was resolved without the ${level}'s recipe or name.`, sizeContext(candidate));
}

function sizeContext(candidate: DropshipListingCatalogCandidate): Record<string, unknown> {
  return { productId: candidate.productId, productVariantId: candidate.productVariantId, categoryId: candidate.categoryId };
}

// ---------------------------------------------------------------------------
// The plan (plan 4.A.4)
// ---------------------------------------------------------------------------

/**
 * What moving the store's older group rules over would write, and the report
 * of what it cannot move (plan 4.A.4, D5, D6). With no older rules nothing is
 * planned (plan 4.A.8: no planning runs) and only the kept counts are given.
 */
export function planRulesConversion(inputs: ConversionInputs): RulesConversionPlan {
  assertConversionInputs(inputs);
  const { listing } = inputs;
  const olderRuleCounts = olderGroupRuleCounts(listing);
  const kept = keptRows(listing);
  const storeConnectionId = listing.store.storeConnectionId;
  if (olderRuleTotal(olderRuleCounts) === 0) {
    return { storeConnectionId, olderRules: olderRuleCounts, profiles: EMPTY_PROFILE_WRITES, categories: [], products: [],
      firstMarks: [], report: emptyReport(), kept };
  }
  const rules = olderRules(listing);
  const winners = todayWinners(listing);
  const categoryPlan = planCategoryRules(rules, inputs);
  const productPlan = planProductRules(winners, listing);
  const winning = new Set<string>();
  for (const size of winners) {
    for (const winner of [size.price, size.ebayCategory, size.textAbove, size.textBelow]) {
      if (winner?.type === "rule") winning.add(ruleKey(winner.rule.kind, winner.rule.id));
    }
  }
  // "Never applies" (plan D5, 4.A.4): neither written nor winning for any chosen size and setting; an unmatched rule never.
  const neverApplies = [...rules.values()].filter((rule) => {
    const key = ruleKey(rule.kind, rule.id);
    return !categoryPlan.unmatchedKeys.has(key) && !categoryPlan.writtenKeys.has(key) && !productPlan.writtenKeys.has(key)
      && !winning.has(key);
  });
  return {
    storeConnectionId,
    olderRules: olderRuleCounts,
    profiles: plannedProfiles(listing),
    categories: categoryPlan.writes,
    products: productPlan.writes,
    firstMarks: firstMarks(listing),
    report: {
      unmatched: categoryPlan.unmatched,
      shared: categoryPlan.shared,
      nameMismatches: categoryNameMismatches(listing.candidates, listing.categoryNames),
      neverApplies: sortRuleItems(neverApplies.map((rule) => ({ rule, item: { ruleName: rule.name, kind: rule.kind } }))),
      ties: productPlan.ties,
      someSizesOnly: productPlan.someSizesOnly,
      mixed: productPlan.mixed,
    },
    kept,
  };
}

/** A report list as the answer carries it (plan 4.A.3): every item counted, at most MAX_CONVERSION_REPORT_ITEMS shown, in order. */
export function conversionList<T>(items: readonly T[]): { total: number; items: T[] } {
  return { total: items.length, items: items.slice(0, MAX_CONVERSION_REPORT_ITEMS) };
}

/**
 * The category names the loader must look up for `categoriesByName` (plan
 * 4.A.2: every category-scope rule's category name in the three profiles),
 * each once, by UTF-16 code units. The planner refuses inputs without a key
 * for each, so the loader and the planner read the same list.
 */
export function conversionCategoryNamesToRead(listing: ConversionRuleProfiles): string[] {
  const names = new Set<string>();
  for (const rule of olderRules(listing).values()) if (rule.scope.type === "category") names.add(rule.scope.category);
  return [...names].sort(compareIds);
}

/**
 * The three profiles the older rules live in: all the name lookup reads, so
 * the apply (11c2) names the categories to lock from the profiles alone,
 * before it loads the whole inputs (plan 7.B.3 step 8).
 */
export type ConversionRuleProfiles = Pick<ListingSettingsInputs, "pricing" | "content" | "ebayCategoryRules">;

/** Every older rule of the store's three profiles, by `kind:id` (ids are unique within each profile's list). */
function olderRules(listing: ConversionRuleProfiles): ReadonlyMap<string, ConversionRule> {
  const rules = new Map<string, ConversionRule>();
  const add = (rule: ConversionRule) => {
    const key = ruleKey(rule.kind, rule.id);
    if (rules.has(key)) throw listingSettingsInvariantFailed("A store profile holds two older rules with one id.", { kind: rule.kind, ruleId: rule.id });
    rules.set(key, rule);
  };
  for (const group of listing.pricing.profile?.groups ?? []) {
    add({ kind: "price", id: group.id, name: group.name, scope: group.scope, priority: group.priority, recipe: group.recipe });
  }
  for (const group of listing.content.profile?.groups ?? []) {
    add({ kind: "description", id: group.id, name: group.name, scope: group.scope, priority: group.priority, template: group.template });
  }
  for (const rule of listing.ebayCategoryRules.profile?.rules ?? []) {
    add({ kind: "ebayCategory", id: rule.id, name: rule.name, scope: rule.scope, category: rule.category });
  }
  return rules;
}

function ruleKey(kind: ConversionRuleKind, id: string): string {
  return `${kind}:${id}`;
}

// ---------------------------------------------------------------------------
// Category rules → category settings
// ---------------------------------------------------------------------------

interface CategoryPlan {
  writes: PlannedCategoryWrite[];
  unmatched: ConversionReportItem<"unmatched">[];
  shared: ConversionReportItem<"shared">[];
  unmatchedKeys: ReadonlySet<string>;
  writtenKeys: ReadonlySet<string>;
}

/**
 * Each category name's rules of one kind become that kind's settings on every
 * category with exactly that name (plan 4.A.4, row 890; D8). The value is the
 * best rule's: for pricing and description groups the one with the lowest
 * priority, none when the best two tie (the tied sizes have no value today);
 * an eBay category rule is the only one for its name (the rules' schema
 * refuses a second). A category's own field is never overwritten, so a
 * category row already present gets only the converted fields. A name no
 * category has lists all its rules as unmatched; a name two or more share
 * lists each written rule as shared.
 */
function planCategoryRules(rules: ReadonlyMap<string, ConversionRule>, inputs: ConversionInputs): CategoryPlan {
  const byName = new Map<string, ConversionRule[]>();
  for (const rule of rules.values()) {
    if (rule.scope.type !== "category") continue;
    const nameKey = `${rule.kind}:${rule.scope.category}`;
    const list = byName.get(nameKey) ?? [];
    list.push(rule);
    byName.set(nameKey, list);
  }
  const patches = new Map<number, { target: ConversionCategory; values: Partial<CategoryListingSettingValues> }>();
  const unmatched: Array<{ rule: ConversionRule; item: ConversionReportItem<"unmatched"> }> = [];
  const shared: Array<{ rule: ConversionRule; item: ConversionReportItem<"shared"> }> = [];
  const unmatchedKeys = new Set<string>();
  const writtenKeys = new Set<string>();
  for (const sameName of byName.values()) {
    const categoryName = categoryScopeName(sameName[0]);
    const targets = categoryTargets(categoryName, inputs.categoriesByName);
    if (targets.length === 0) {
      for (const rule of sameName) {
        unmatched.push({ rule, item: { ruleName: rule.name, categoryName, kind: rule.kind } });
        unmatchedKeys.add(ruleKey(rule.kind, rule.id));
      }
      continue;
    }
    const best = bestCategoryRule(sameName);
    if (best === null) continue;
    let written = false;
    for (const target of targets) {
      const row = inputs.categoryRows.get(target.id) ?? null;
      const entry = patches.get(target.id) ?? { target, values: {} };
      for (const setting of KIND_SETTINGS[best.kind]) {
        // A field the category already sets itself is never overwritten (plan 4.A.4, further rules).
        if (row !== null && row.values[setting] !== null) continue;
        assignSetting(entry.values, setting, best);
        written = true;
      }
      patches.set(target.id, entry);
    }
    if (!written) continue;
    writtenKeys.add(ruleKey(best.kind, best.id));
    if (targets.length > 1) {
      shared.push({ rule: best, item: { ruleName: best.name, categoryName, categoryCount: targets.length, kind: best.kind } });
    }
  }
  const writes = [...patches.values()]
    .filter((entry) => Object.keys(entry.values).length > 0)
    .map(({ target, values }) => categoryWrite(target, values, inputs.categoryRows.get(target.id) ?? null))
    .sort((a, b) => a.categoryId - b.categoryId);
  return { writes, unmatched: sortRuleItems(unmatched), shared: sortRuleItems(shared), unmatchedKeys, writtenKeys };
}

function categoryScopeName(rule: ConversionRule): string {
  if (rule.scope.type !== "category") throw listingSettingsInvariantFailed("A category rule has no category name.", { ruleId: rule.id });
  return rule.scope.category;
}

/**
 * The one rule of a category name whose value the categories get: the lowest
 * priority for groups (the resolvers' order, priority first), none when the
 * best two share it; for eBay rules the only one.
 */
function bestCategoryRule(sameName: readonly ConversionRule[]): ConversionRule | null {
  if (sameName[0].kind === "ebayCategory") {
    if (sameName.length > 1) {
      throw listingSettingsInvariantFailed("Two eBay category rules name one category.", { ruleIds: sameName.map((rule) => rule.id) });
    }
    return sameName[0];
  }
  const ranked = sameName.filter(isGroupRule).sort((a, b) => a.priority - b.priority || compareIds(a.id, b.id));
  if (ranked.length !== sameName.length) {
    throw listingSettingsInvariantFailed("Rules of two kinds were ranked as one category name's rules.", { ruleId: sameName[0].id });
  }
  return ranked.length > 1 && ranked[0].priority === ranked[1].priority ? null : ranked[0];
}

/** A pricing or description group: the two kinds ranked by priority. */
function isGroupRule(rule: ConversionRule): rule is Extract<ConversionRule, { kind: "price" | "description" }> {
  return rule.kind !== "ebayCategory";
}

function categoryWrite(target: ConversionCategory, values: Partial<CategoryListingSettingValues>,
  row: CategoryListingSettingRow | null): PlannedCategoryWrite {
  return {
    categoryId: target.id,
    categoryName: target.name,
    expectedRevisionId: row?.revisionId ?? null,
    patch: parsedPatch(categoryListingSettingPatchSchema, values, { categoryId: target.id }),
    settings: CONVERSION_SETTINGS.filter((setting) => values[setting] !== undefined),
  };
}

// ---------------------------------------------------------------------------
// Product-line, product and named-size rules → a product's own values
// ---------------------------------------------------------------------------

interface ProductPlan {
  writes: PlannedProductWrite[];
  ties: ConversionReportItem<"ties">[];
  someSizesOnly: ConversionReportItem<"someSizesOnly">[];
  mixed: ConversionReportItem<"mixed">[];
  writtenKeys: ReadonlySet<string>;
}

/**
 * For each chosen product and setting, over the chosen sizes the setting
 * reaches (for the price, those that do not own it; never a size whose
 * product sets the setting itself), one 4.A.4 row (decideProductSetting):
 * the product's own value, nothing (it follows its category), a tie, a
 * named-size rule on some sizes only, or mixed winners. A product with no
 * reached size gets nothing.
 */
function planProductRules(winners: readonly SizeWinners[], listing: ListingSettingsInputs): ProductPlan {
  const byProduct = new Map<number, SizeWinners[]>();
  for (const size of winners) {
    const list = byProduct.get(size.candidate.productId) ?? [];
    list.push(size);
    byProduct.set(size.candidate.productId, list);
  }
  const writes: PlannedProductWrite[] = [];
  const ties: ConversionReportItem<"ties">[] = [];
  const someSizesOnly: Array<{ rule: ConversionRule; item: ConversionReportItem<"someSizesOnly"> }> = [];
  const mixed: ConversionReportItem<"mixed">[] = [];
  const writtenKeys = new Set<string>();
  for (const [productId, sizes] of byProduct) {
    const productName = sizes[0].candidate.productName;
    const row = listing.layers.products.get(productId) ?? null;
    const values: Partial<Record<ConversionSetting, ConversionRule>> = {};
    const tied = new Set<ConversionTieSetting>();
    const listSomeSizesOnly = (setting: ConversionSetting, rules: readonly ConversionRule[]) => {
      for (const rule of rules) someSizesOnly.push({ rule, item: { ruleName: rule.name, productId, productName, setting } });
    };
    for (const setting of CONVERSION_SETTINGS) {
      const reached = sizes.flatMap((size) => {
        const winner = size[setting];
        return winner === null || winner.type === "own" ? [] : [{ candidate: size.candidate, winner }];
      });
      if (reached.length === 0) continue;
      const decision = decideProductSetting(reached, (row?.values[setting] ?? null) !== null);
      switch (decision.kind) {
        case "own_value": values[setting] = decision.rule; break;
        case "follow": break;
        case "tie": tied.add(tieSettingOf(setting)); listSomeSizesOnly(setting, decision.someSizesOnly); break;
        case "some_sizes_only": listSomeSizesOnly(setting, decision.rules); break;
        case "mixed": mixed.push({ productId, productName, setting }); break;
      }
    }
    for (const setting of CONVERSION_TIE_SETTINGS) {
      if (tied.has(setting)) ties.push({ productId, productName, setting });
    }
    const settings = CONVERSION_SETTINGS.filter((setting) => values[setting] !== undefined);
    if (settings.length === 0) continue;
    const patchValues: Record<string, unknown> = {};
    for (const setting of settings) {
      const rule = values[setting] as ConversionRule;
      assignSetting(patchValues, setting, rule);
      writtenKeys.add(ruleKey(rule.kind, rule.id));
    }
    writes.push({
      productId,
      productName,
      expectedRevisionId: row?.revisionId ?? null,
      patch: parsedPatch(productListingSettingPatchSchema, patchValues, { productId }),
      settings,
    });
  }
  const byProductName = <T extends { productId: number; productName: string }>(a: T, b: T) =>
    CONVERSION_NAME_ORDER.compare(a.productName, b.productName) || a.productId - b.productId;
  return {
    writes: writes.sort((a, b) => a.productId - b.productId),
    ties: ties.sort((a, b) => byProductName(a, b) || tieOrder(a.setting) - tieOrder(b.setting)),
    someSizesOnly: someSizesOnly.sort((a, b) => byProductName(a.item, b.item) || settingOrder(a.item.setting) - settingOrder(b.item.setting)
      || CONVERSION_NAME_ORDER.compare(a.rule.name, b.rule.name) || compareIds(a.rule.id, b.rule.id)).map(({ item }) => item),
    mixed: mixed.sort((a, b) => byProductName(a, b) || settingOrder(a.setting) - settingOrder(b.setting)),
    writtenKeys,
  };
}

/** What one chosen product gets for one setting: one branch per plan 4.A.4 row (893, 894, 897 and mixed). */
type ProductSettingDecision =
  | { readonly kind: "own_value"; readonly rule: ConversionRule }
  | { readonly kind: "follow" }
  | { readonly kind: "tie"; readonly someSizesOnly: readonly ConversionRule[] }
  | { readonly kind: "some_sizes_only"; readonly rules: readonly ConversionRule[] }
  | { readonly kind: "mixed" };

/**
 * One product and setting, over today's winners of the chosen sizes the
 * setting reaches (never empty, never "own") (plan 4.A.4, D5):
 * - 897: a tie on any of them writes nothing; the product is listed under
 *   `ties`, and each named-size rule that wins some of the others is still
 *   listed under `someSizesOnly`, so the report names it;
 * - 893/894: one product-line, product or named-size rule winning for all of
 *   them becomes the product's own value, unless the product already sets
 *   the setting itself (an own value is never overwritten);
 * - 893: a category rule, or no rule, for all of them: the product follows
 *   its category, nothing is written;
 * - 894 and mixed: different winners. Each named-size rule that wins some of
 *   them without naming them all is listed under `someSizesOnly`; when none
 *   does, the product is listed under `mixed`, so one cause is listed once.
 */
function decideProductSetting(reached: ReadonlyArray<{ candidate: DropshipListingCatalogCandidate; winner: SettingWinner }>,
  hasOwnValue: boolean): ProductSettingDecision {
  const distinct = new Map<string, SettingWinner>();
  for (const { winner } of reached) distinct.set(winner.type === "rule" ? ruleKey(winner.rule.kind, winner.rule.id) : winner.type, winner);
  const partial = [...distinct.values()].flatMap((winner) => winner.type === "rule" && winner.rule.scope.type === "listings"
    && !reached.every(({ candidate }) => matchesCatalogScope(winner.rule.scope, candidate)) ? [winner.rule] : []);
  // A tie is keyed by its type (a rule by kind and id), so any tied size shows here.
  if (distinct.has("tie")) return { kind: "tie", someSizesOnly: partial };
  if (distinct.size > 1) return partial.length > 0 ? { kind: "some_sizes_only", rules: partial } : { kind: "mixed" };
  const [only] = distinct.values();
  return only.type === "rule" && only.rule.scope.type !== "category" && !hasOwnValue ? { kind: "own_value", rule: only.rule } : { kind: "follow" };
}

/** A tie's setting as the report names it; an eBay category tie cannot happen (the rules' saved order decides), so it is refused. */
function tieSettingOf(setting: ConversionSetting): ConversionTieSetting {
  const tie = TIE_SETTING[setting];
  if (tie === null) throw listingSettingsInvariantFailed("Two older rules tied for a setting rules cannot tie on.", { setting });
  return tie;
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

/**
 * The value a rule becomes for one setting, built from stored data only (no
 * eBay call: an eBay rule stores its category's id, name and path): a pricing
 * group's recipe; a description group's introduction as text above and its
 * footer as text below, an empty part as "None" (own text may not be empty,
 * and both give "" to the description); an eBay rule's category.
 */
function assignSetting(target: Record<string, unknown>, setting: ConversionSetting, rule: ConversionRule): void {
  if (setting === "price" && rule.kind === "price") target.price = rule.recipe;
  else if (setting === "ebayCategory" && rule.kind === "ebayCategory") target.ebayCategory = rule.category;
  else if ((setting === "textAbove" || setting === "textBelow") && rule.kind === "description") {
    target[setting] = templatePart(rule.template[templatePartOf(setting)]);
  } else {
    throw listingSettingsInvariantFailed("An older rule was converted into a setting of another kind.", { setting, kind: rule.kind, ruleId: rule.id });
  }
}

/** The description template part behind a text setting, read from the content resolver's own mapping. */
function templatePartOf(setting: "textAbove" | "textBelow"): keyof typeof TEMPLATE_PART_SETTING {
  const parts = Object.keys(TEMPLATE_PART_SETTING) as Array<keyof typeof TEMPLATE_PART_SETTING>;
  const part = parts.find((key) => TEMPLATE_PART_SETTING[key] === setting);
  if (part === undefined) throw listingSettingsInvariantFailed("A text setting has no description template part.", { setting });
  return part;
}

function templatePart(text: string): ListingSettingTemplateText {
  return text.length > 0 ? { mode: "own", text } : { mode: "none" };
}

/** A patch through its stored contract: a converted value that breaks it is a fault, never written. */
function parsedPatch<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, values: object,
  context: Record<string, unknown>): T {
  const parsed = schema.safeParse(values);
  if (!parsed.success) throw listingSettingsInvariantFailed("A converted setting does not fit the settings contract.", context);
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Profiles, marks, kept rows, inputs
// ---------------------------------------------------------------------------

/** The group lists the move empties, each at the revision it was planned on; a list already empty is left alone. */
function plannedProfiles(listing: ListingSettingsInputs): PlannedProfileWrites {
  const write = (kind: string, revisionId: number | null, ids: readonly string[] | undefined): PlannedProfileWrite | null => {
    if (!ids || ids.length === 0) return null;
    if (revisionId === null) throw listingSettingsInvariantFailed("A store profile with older rules has no revision.", { kind });
    return { expectedRevisionId: revisionId, removedIds: [...ids].sort(compareIds) };
  };
  return {
    pricing: write("pricing", listing.pricing.revisionId, listing.pricing.profile?.groups.map((group) => group.id)),
    content: write("content", listing.content.revisionId, listing.content.profile?.groups.map((group) => group.id)),
    ebayRules: write("ebay_rules", listing.ebayCategoryRules.revisionId, listing.ebayCategoryRules.profile?.rules.map((rule) => rule.id)),
  };
}

/** Every chosen product with no category mark yet, ascending: the move writes its first mark (marks never change a value). */
function firstMarks(listing: ListingSettingsInputs): number[] {
  const products = new Set(listing.candidates.map((candidate) => candidate.productId));
  return [...products].filter((productId) => !listing.categoryMoves.marks.has(productId)).sort((a, b) => a - b);
}

/**
 * The per-size rows the move keeps as they are (plan D6), over the chosen
 * sizes: exact prices (a typed price, or a legacy row with a price), catalog
 * prices (the catalog default, or a legacy row without one), policy and
 * shelf leftovers, and own main texts.
 */
function keptRows(listing: ListingSettingsInputs): ConversionKept {
  const kept = { exactPrices: 0, catalogPrices: 0, sizePolicies: 0, sizeShelves: 0, sizeTexts: 0 };
  for (const { productVariantId: id } of listing.candidates) {
    const saved = listing.savedPrices.get(id);
    if (saved?.pricingMode === "fixed" || (saved !== undefined && saved.pricingMode === undefined && saved.overridePriceCents !== null)) {
      kept.exactPrices += 1;
    } else if (saved?.pricingMode === "catalog_default" || (saved !== undefined && saved.pricingMode === undefined)) {
      kept.catalogPrices += 1;
    }
    const override = listing.policyOverrides.get(id);
    if (override && (override.fulfillmentPolicyId !== null || override.returnPolicyId !== null || override.paymentPolicyId !== null)) {
      kept.sizePolicies += 1;
    }
    if ((listing.shelfAssignments.get(id)?.length ?? 0) > 0) kept.sizeShelves += 1;
    if (listing.contentSettings.get(id)?.customText != null) kept.sizeTexts += 1;
  }
  return kept;
}

/** Inputs that cannot come from one snapshot of one store are refused before anything is planned. */
function assertConversionInputs(inputs: ConversionInputs): void {
  const { listing } = inputs;
  if (!Number.isSafeInteger(inputs.storeTextBytes) || inputs.storeTextBytes < 0) {
    throw listingSettingsInvariantFailed("The store's saved text size must be a whole number of bytes.");
  }
  const sizes = new Set<number>();
  for (const candidate of listing.candidates) {
    if (sizes.has(candidate.productVariantId)) {
      throw listingSettingsInvariantFailed("A chosen size is listed twice.", { productVariantId: candidate.productVariantId });
    }
    sizes.add(candidate.productVariantId);
  }
  assertConversionCategoriesByName(inputs.categoriesByName);
  // Every name the rules target was looked up ([] when no category has it); a missing key is a loader fault, never "no category".
  for (const name of conversionCategoryNamesToRead(listing)) {
    if (!inputs.categoriesByName.has(name)) {
      throw listingSettingsInvariantFailed("A category rule's name was never looked up among the Card Shellz categories.");
    }
  }
  for (const [categoryId, row] of inputs.categoryRows) {
    if (row !== null && (row.categoryId !== categoryId || row.storeConnectionId !== listing.store.storeConnectionId)) {
      throw listingSettingsInvariantFailed("A category settings row is keyed by another category or store.", { categoryId });
    }
  }
  // A target that holds chosen products is in both reads of the one snapshot, so both must give it the same row (or none).
  const chosenCategories = new Set(listing.candidates.flatMap((candidate) => candidate.categoryId === null ? [] : [candidate.categoryId]));
  for (const targets of inputs.categoriesByName.values()) {
    for (const { id } of targets) {
      // Every target's row was read (null when it has none): a missing key would plan an overwrite at no revision.
      if (!inputs.categoryRows.has(id)) {
        throw listingSettingsInvariantFailed("A target category's settings row was never read.", { categoryId: id });
      }
      if (!chosenCategories.has(id) && !listing.layers.categories.has(id)) continue;
      if (inputs.categoryRows.get(id)?.revisionId !== listing.layers.categories.get(id)?.revisionId) {
        throw listingSettingsInvariantFailed("A category's settings row differs between the two reads of one snapshot.", { categoryId: id });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// The after inputs (plan 4.A.7)
// ---------------------------------------------------------------------------

/**
 * The revision id and time of a planned row in the after inputs. The
 * resolvers never read them (they read a row's values only:
 * dropship-rule-price.ts rulePriceContextOf, the content and eBay category
 * resolvers), and the after inputs never reach a writer, which compares the
 * plan's expectedRevisionId. The after side's read model does copy the
 * revision into its product and category views (settingsRevisionId,
 * revisionId), so those views must never be shown, or written from: the
 * conversion compares size views only, and the writes hash covers the plan's
 * expectedRevisionIds. Fixed stand-ins rather than a clock read, so the after
 * side is reproducible (CLAUDE.md §3).
 */
export const PLANNED_ROW_REVISION_ID = 2_147_483_647;
export const PLANNED_ROW_UPDATED_AT = "1970-01-01T00:00:00.000Z";

/**
 * The store as it would be after the move (plan 4.A.7, D2): a new inputs
 * object over the loaded one, which is never changed. The three group lists
 * are emptied with the store defaults kept (a list the plan leaves alone is
 * the same object); each planned row is merged over the row it replaces (or
 * over "follow the default" for a new one) with the writers' own merge
 * (applyListingSettingPatch) and parsed with the stored row's schema; eBay
 * categories are resolved again over the new rules and layers, as the load
 * resolves them; and every target category's name is known, since a value
 * from a category is shown under it. Everything else is the same object.
 *
 * Takes the planner's whole inputs, not only `listing` (beside plan 4.A.7's
 * `(listing, plan)`): a target category with no chosen product has its row
 * only in `categoryRows`. A plan that does not belong to these inputs (another
 * store, a row at another revision) is refused as a fatal invariant.
 */
export function conversionAfterInputs(inputs: ConversionInputs, plan: RulesConversionPlan): ListingSettingsInputs {
  const { listing } = inputs;
  const storeConnectionId = listing.store.storeConnectionId;
  if (plan.storeConnectionId !== storeConnectionId) {
    throw listingSettingsInvariantFailed("A conversion plan was applied to another store's inputs.", { storeConnectionId });
  }
  const pricing = plan.profiles.pricing === null ? listing.pricing
    : { ...listing.pricing, profile: { defaultRecipe: plannedProfile("pricing", listing.pricing, plan.profiles.pricing).defaultRecipe, groups: [] } };
  const content = plan.profiles.content === null ? listing.content
    : { ...listing.content, profile: { defaultTemplate: plannedProfile("content", listing.content, plan.profiles.content).defaultTemplate, groups: [] } };
  const ebayCategoryRules = plan.profiles.ebayRules === null ? listing.ebayCategoryRules
    : { ...listing.ebayCategoryRules, profile: { version: 1 as const,
      defaultCategory: plannedProfile("ebay_rules", listing.ebayCategoryRules, plan.profiles.ebayRules).defaultCategory, rules: [] } };
  const products = new Map(listing.layers.products);
  for (const write of plan.products) {
    const existing = listing.layers.products.get(write.productId) ?? null;
    assertExpectedRevision("product", write.productId, existing, write.expectedRevisionId);
    products.set(write.productId, plannedRow(productListingSettingRowSchema, { storeConnectionId, productId: write.productId,
      revisionId: PLANNED_ROW_REVISION_ID, updatedAt: PLANNED_ROW_UPDATED_AT,
      values: applyListingSettingPatch(existing?.values ?? EMPTY_PRODUCT_LISTING_SETTING_VALUES, write.patch) }, { productId: write.productId }));
  }
  const categories = new Map(listing.layers.categories);
  const categoryNames = new Map(listing.categoryNames);
  for (const write of plan.categories) {
    const existing = inputs.categoryRows.get(write.categoryId) ?? null;
    assertExpectedRevision("category", write.categoryId, existing, write.expectedRevisionId);
    categories.set(write.categoryId, plannedRow(categoryListingSettingRowSchema, { storeConnectionId, categoryId: write.categoryId,
      revisionId: PLANNED_ROW_REVISION_ID, updatedAt: PLANNED_ROW_UPDATED_AT,
      values: applyListingSettingPatch(existing?.values ?? EMPTY_CATEGORY_LISTING_SETTING_VALUES, write.patch) }, { categoryId: write.categoryId }));
    const known = categoryNames.get(write.categoryId);
    if (known !== undefined && known !== write.categoryName) {
      throw listingSettingsInvariantFailed("A category has two names in one snapshot.", { categoryId: write.categoryId });
    }
    categoryNames.set(write.categoryId, write.categoryName);
  }
  const layers: ListingSettingLayers = { products, categories };
  const prepared = prepareEbayCategoryRules(ebayCategoryRules.revisionId, ebayCategoryRules.profile, layers);
  return {
    ...listing,
    pricing,
    content,
    ebayCategoryRules,
    ebayCategories: new Map(listing.candidates.map((candidate) => [candidate.productVariantId,
      resolveEbayListingCategory(candidate, prepared)])),
    layers,
    categoryNames,
  };
}

/** The profile a planned list write empties: it must exist at the revision the plan read. */
function plannedProfile<P>(kind: string, state: { revisionId: number | null; profile: P | null }, write: PlannedProfileWrite): P {
  if (state.profile === null || state.revisionId !== write.expectedRevisionId) {
    throw listingSettingsInvariantFailed("A conversion plan empties a profile these inputs do not hold.", { kind });
  }
  return state.profile;
}

function assertExpectedRevision(kind: "product" | "category", id: number, existing: { revisionId: number } | null,
  expectedRevisionId: number | null): void {
  if ((existing?.revisionId ?? null) !== expectedRevisionId) {
    throw listingSettingsInvariantFailed(`A conversion plan writes a ${kind} row at a revision these inputs do not hold.`, { kind, id });
  }
}

function plannedRow<T extends ProductListingSettingRow | CategoryListingSettingRow>(
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, row: object,
  context: Record<string, unknown>): T {
  const parsed = schema.safeParse(row);
  if (!parsed.success) throw listingSettingsInvariantFailed("A planned settings row does not fit the stored contract.", context);
  return parsed.data;
}

// ---------------------------------------------------------------------------
// The diff (plan 4.A.8, 3.2)
// ---------------------------------------------------------------------------

/**
 * Every issue the content resolver raises (resolveListingContent), and the
 * blocker it is in the `listable` key (plan 3.2): the three no fix code
 * covers are blockers of their own; a group tie and own text to check are
 * already the read model's fix codes `description_group_conflict` and
 * `own_text_needs_check` (null here). The preview blocks on every content
 * issue, so an issue this table does not know is refused (contentIssueBlockers),
 * never dropped: a new one must be classified before a store can be clean.
 */
export const CONTENT_ISSUE_BLOCKERS: ReadonlyMap<string, ConversionContentBlockerCode | null> = new Map<string,
  ConversionContentBlockerCode | null>([
  ...CONVERSION_CONTENT_BLOCKER_CODES.map((code) => [code, code] as const),
  ["listing_content_template_conflict", null],
  ["listing_content_catalog_review_required", null],
]);

/** The blockers a size's content issues add (CONTENT_ISSUE_BLOCKERS); an issue it does not know is a fatal invariant. */
export function contentIssueBlockers(issues: readonly string[]): ConversionContentBlockerCode[] {
  return issues.flatMap((issue) => {
    const blocker = CONTENT_ISSUE_BLOCKERS.get(issue);
    if (blocker === undefined) {
      throw listingSettingsInvariantFailed("The content resolver raised an issue the conversion does not classify.", { issue });
    }
    return blocker === null ? [] : [blocker];
  });
}
/** A Card Shellz price limit in this mode stops the listing from being sent (the save guard's "blocking"). */
const BLOCKING_LIMIT_MODE = "block_listing";

/**
 * What each compared key reads from a size's view (plan 3.2), as plain JSON
 * values: two sizes agree on a key exactly when its values serialize alike,
 * and the plan hash hashes the same values, so the compare and the hash can
 * never disagree. The pricing rule is its recipe (its kind and name are
 * labels), "tie", or null; the price source names the basis of a rule price.
 */
const KEY_VALUE: { readonly [K in ConversionChangedField]: (view: ConversionSizeView) => unknown } = {
  price: (view) => view.price.priceCents,
  priceSource: (view) => priceSourceClass(view.price),
  pricingRule: (view) => view.pricingRule === null ? null : view.pricingRule.kind === "tie" ? "tie" : recipeKey(view.pricingRule.recipe),
  ebayCategory: (view) => view.ebayCategory?.id ?? null,
  storeShelf: (view) => view.shelfNames,
  shippingPolicy: (view) => view.policies.shipping,
  returnPolicy: (view) => view.policies.return,
  paymentPolicy: (view) => view.policies.payment,
  description: (view) => view.descriptionHash,
  listable: (view) => view.blockers,
};

/** The compared keys' values of one side, in CONVERSION_CHANGED_FIELDS order (the plan hash's form, plan 3.3). */
export function conversionKeyValues(view: ConversionSizeView): Record<ConversionChangedField, unknown> {
  return Object.fromEntries(CONVERSION_CHANGED_FIELDS.map((field) => [field, KEY_VALUE[field](view)])) as Record<ConversionChangedField, unknown>;
}

/**
 * The price source class of plan 3.2: a rule price names its basis (from
 * cost or from retail); every other source is itself. A rule price always
 * has a basis (the facts give one exactly when the rules own a usable price).
 */
function priceSourceClass(price: ListingSettingsSizePrice): string {
  if (price.source !== "rules") return price.source;
  if (price.basis === null) {
    throw listingSettingsInvariantFailed("A rule price has no basis.", { productVariantId: price.productVariantId });
  }
  return `rules_${price.basis}`;
}

/** A recipe as its four values, in a fixed order, whatever key order it was stored with. */
function recipeKey(recipe: PricingRecipe): Record<string, unknown> {
  return { basis: recipe.basis, markupBps: recipe.markupBps, flatCents: recipe.flatCents, rounding: recipe.rounding };
}

/**
 * Every chosen size the move would change (plan 4.A.8, D3): the read model
 * (buildListingSettingsFacts) and the description resolver on both sides,
 * one view per side, and a row whenever any of plan 3.2's keys differ,
 * naming exactly those keys. Evidence hashes, rule names and template labels
 * are never compared: they move on any profile revision with no value change.
 * Rows are ordered by product name, size name, then size id (plan 4.A.3);
 * names come from the inputs and ids stay keys. Both sides must hold the same
 * store's same chosen sizes.
 */
export function compareConversion(before: ListingSettingsInputs, after: ListingSettingsInputs): ConversionChangeRow[] {
  const ids = (inputs: ListingSettingsInputs) => inputs.candidates.map((candidate) => candidate.productVariantId).sort((a, b) => a - b);
  if (before.store.storeConnectionId !== after.store.storeConnectionId || JSON.stringify(ids(before)) !== JSON.stringify(ids(after))) {
    throw listingSettingsInvariantFailed("A conversion compares two different stores or selections.", {
      storeConnectionId: before.store.storeConnectionId,
    });
  }
  const beforeViews = conversionSizeViews(before);
  const afterViews = conversionSizeViews(after);
  const rows: ConversionChangeRow[] = [];
  for (const { candidate, view } of beforeViews.values()) {
    const afterView = afterViews.get(candidate.productVariantId)?.view;
    if (!afterView) throw listingSettingsInvariantFailed("A chosen size has no view after the move.", sizeContext(candidate));
    const changed = CONVERSION_CHANGED_FIELDS.filter((field) =>
      JSON.stringify(KEY_VALUE[field](view)) !== JSON.stringify(KEY_VALUE[field](afterView)));
    if (changed.length === 0) continue;
    rows.push({ productVariantId: candidate.productVariantId, productId: candidate.productId, productName: candidate.productName,
      sizeName: candidate.variantName, changed, before: view, after: afterView });
  }
  return rows.sort(compareRows);
}

/**
 * One view per chosen size (plan 4.A.3 SizeView): the read model's size
 * price, the pricing rule it follows, its eBay category, shelves and policy
 * ids, the hash of the description it is sent, and its blockers. The content
 * profile is prepared once and passed with its own state (the resolver
 * refuses a prepared profile of another state).
 */
function conversionSizeViews(listing: ListingSettingsInputs): Map<number, { candidate: DropshipListingCatalogCandidate; view: ConversionSizeView }> {
  const facts = buildListingSettingsFacts(listing);
  const resolver = createRulePriceResolver(rulePriceContextOf(listing.pricing, listing.layers));
  const preparedProfile = prepareContentProfile(listing.content);
  const candidates = new Map(listing.candidates.map((candidate) => [candidate.productVariantId, candidate]));
  const views = new Map<number, { candidate: DropshipListingCatalogCandidate; view: ConversionSizeView }>();
  for (const size of facts.sizes) {
    const candidate = candidates.get(size.price.productVariantId);
    if (!candidate) throw listingSettingsInvariantFailed("The read model priced a size that was not chosen.", { productVariantId: size.price.productVariantId });
    const content = resolveListingContent({ candidate, profile: listing.content, preparedProfile,
      saved: listing.contentSettings.get(candidate.productVariantId) ?? null, layers: listing.layers });
    views.set(candidate.productVariantId, { candidate, view: sizeView(size, sizePricingRule(candidate, listing, resolver), content) });
  }
  return views;
}

function sizeView(size: ListingSettingsSizeFacts, pricingRule: PricingRuleRef | null, content: ResolvedListingContent): ConversionSizeView {
  const blockers = new Set<string>(size.fixes);
  if (size.price.limits.some((limit) => limit.mode === BLOCKING_LIMIT_MODE && limit.breached !== null)) blockers.add("price_outside_limit");
  for (const blocker of contentIssueBlockers(content.issues)) blockers.add(blocker);
  const category = size.values.ebayCategory.value;
  return {
    price: size.price,
    pricingRule,
    ebayCategory: category.categoryId === null ? null : { id: category.categoryId, name: category.categoryName },
    shelfNames: [...size.values.storeShelf.value.names],
    policies: {
      shipping: size.values.shippingPolicy.value.policyId,
      return: size.values.returnPolicy.value.policyId,
      payment: size.values.paymentPolicy.value.policyId,
    },
    descriptionHash: sha256Hex(content.descriptionHtml),
    blockers: CONVERSION_BLOCKER_CODES.filter((code) => blockers.has(code)),
  };
}

/** By product name, size name, then size id (plan 4.A.3), names compared as the read model compares them. */
function compareRows(a: Pick<SizeRef, "productName" | "sizeName" | "productVariantId">,
  b: Pick<SizeRef, "productName" | "sizeName" | "productVariantId">): number {
  return CONVERSION_NAME_ORDER.compare(a.productName, b.productName) || CONVERSION_NAME_ORDER.compare(a.sizeName, b.sizeName)
    || a.productVariantId - b.productVariantId;
}

// ---------------------------------------------------------------------------
// What blocks a move (plan D9, 3.2)
// ---------------------------------------------------------------------------

/** What blocks the move (plan D9); the lists are full and in the rows' order (the view caps them). */
export interface ConversionBlocks {
  /** D9a: a size with a usable price today that would have none, or one outside a blocking Card Shellz limit. */
  readonly wouldLosePrice: readonly SizeRef[];
  /** D9b: a size listed on eBay that can be sent today and would be blocked after; `reasons` are its blockers after. */
  readonly wouldBlockListing: readonly (SizeRef & { readonly reasons: readonly ConversionBlockerCode[] })[];
  /** D9c: the planned product text would raise the store's saved text past the cap. */
  readonly tooMuchText: boolean;
  /** UTF-8 bytes of the product text the plan adds (the store text refusal's context, 11c2). */
  readonly addedProductTextBytes: number;
}

/** A listing in this status is off eBay and gets no stock updates (migration 0086's status list). */
const ENDED_LISTING_STATUS = "ended";
/**
 * A listing in these statuses has a push queued or running (queue creation
 * and an operator's retry set `queued`, under or beside the store lock), and
 * that push can go live with no eBay id read yet: the worker refreshes its
 * preview, calls eBay, then writes the eBay id without the store lock
 * (dropship-listing-push-worker.repository.ts, completeItem). A refresh taken
 * before a conversion commits would publish from the old settings and mark
 * the listing live after it, then be blocked from stock updates, which D9b
 * exists to refuse; so it counts as listed.
 */
const PUSH_IN_FLIGHT_LISTING_STATUSES: ReadonlySet<string> = new Set(["queued", "pushing"]);

/**
 * What blocks the move (plan D9, 3.2), each size listed once:
 * - `wouldLosePrice`: the save guard's own refusal of an untyped change
 *   (refuseListingPriceSave, listing-price-save-guard.ts): a usable price
 *   today (one, and no blocking limit breached) and none after;
 * - `wouldBlockListing`: not already losing its price, it has a listing on
 *   eBay (an eBay listing id, or a push queued or running, and not ended)
 *   that can be sent today (no blocker)
 *   and would have a blocker after: a blocked listing stops getting stock
 *   updates and can oversell. Its fix is not the price, so it is listed here;
 * - `tooMuchText`, by the writers' own rule: only the planned product text
 *   counts (category text is not in the cap, and the move never replaces a
 *   product's own part, so no bytes are given back), and only a move that
 *   adds text and takes the store's total past MAX_STORE_LISTING_TEXT_BYTES
 *   is refused, so a store already over the cap that adds none is not.
 * Every size a block names is a changed row (its price or blockers change),
 * so the blocks are read from the rows.
 */
export function conversionBlocks(input: {
  listing: Pick<ListingSettingsInputs, "existingListings">;
  rows: readonly ConversionChangeRow[];
  plan: Pick<RulesConversionPlan, "products">;
  storeTextBytes: number;
}): ConversionBlocks {
  const wouldLosePrice: SizeRef[] = [];
  const wouldBlockListing: Array<SizeRef & { reasons: ConversionBlockerCode[] }> = [];
  for (const row of [...input.rows].sort(compareRows)) {
    const ref: SizeRef = { productId: row.productId, productVariantId: row.productVariantId, productName: row.productName,
      sizeName: row.sizeName, priceCents: row.before.price.priceCents };
    if (losesPrice(row)) {
      wouldLosePrice.push(ref);
      continue;
    }
    const listing = input.listing.existingListings.get(row.productVariantId) ?? null;
    const listed = listing !== null && listing.status !== ENDED_LISTING_STATUS
      && (listing.externalListingId !== null || PUSH_IN_FLIGHT_LISTING_STATUSES.has(listing.status));
    if (listed && row.before.blockers.length === 0 && row.after.blockers.length > 0) {
      wouldBlockListing.push({ ...ref, reasons: [...row.after.blockers] });
    }
  }
  const addedProductTextBytes = input.plan.products.reduce((total, write) => total + patchTextBytes(write.patch), 0);
  return {
    wouldLosePrice,
    wouldBlockListing,
    tooMuchText: addedProductTextBytes > 0 && input.storeTextBytes + addedProductTextBytes > MAX_STORE_LISTING_TEXT_BYTES,
    addedProductTextBytes,
  };
}

/** D9a by the save guard's own rule (W9's refusal), so the two can never disagree; the move types no price. */
function losesPrice(row: ConversionChangeRow): boolean {
  return refuseListingPriceSave({ before: priceState(row.before), after: { ...priceState(row.after), typed: false } })
    === "DROPSHIP_LISTING_PRICE_WOULD_BE_LOST";
}

/** One side's price as the save guard reads it: the cents, and the blocking Card Shellz limit it breaches, if any. */
function priceState(view: ConversionSizeView): ListingPriceState {
  return { priceCents: view.price.priceCents, blockers: view.blockers.filter((code) => code === "price_outside_limit") };
}

function isBlocked(blocks: ConversionBlocks): boolean {
  return blocks.wouldLosePrice.length > 0 || blocks.wouldBlockListing.length > 0 || blocks.tooMuchText;
}

// ---------------------------------------------------------------------------
// State and hashes (plan 4.A.8, 3.3)
// ---------------------------------------------------------------------------

/**
 * `no_older_rules` when the store holds none (nothing is planned); `clean`
 * when no chosen size changes and nothing blocks the move (the only state the
 * system job applies, plan D1); else `not_clean`.
 */
export function conversionState(input: { olderRules: OlderGroupRuleCounts; rows: readonly unknown[]; blocked: ConversionBlocks }): ConversionState {
  if (olderRuleTotal(input.olderRules) === 0) return "no_older_rules";
  return input.rows.length === 0 && !isBlocked(input.blocked) ? "clean" : "not_clean";
}

function olderRuleTotal(counts: OlderGroupRuleCounts): number {
  return counts.pricingGroups + counts.contentGroups + counts.ebayCategoryRules;
}

const ruleIds = z.array(z.string().min(1));
/** A Postgres int4 id (store, category, product or revision): positive, at most 2^31 - 1. */
const int4Id = z.number().int().positive().max(2_147_483_647);
/**
 * The writes a plan makes, in the canonical form the writes hash hashes (plan
 * 3.3): parsed with the stored patch contracts, so every object's key order
 * is its schema's whatever order the plan built it in (the P22 lesson), and
 * every list sorted by id. Names are display only and left out; so are the
 * first marks, which never change a value. A pricing or content profile
 * removes groups and the eBay document removes rules; null leaves the list
 * alone.
 */
export const conversionWritesSchema = z.object({
  v: z.literal(1),
  storeConnectionId: int4Id,
  profiles: z.object({
    pricing: z.object({ expectedRevisionId: int4Id, removedGroupIds: ruleIds }).strict().nullable(),
    content: z.object({ expectedRevisionId: int4Id, removedGroupIds: ruleIds }).strict().nullable(),
    ebayRules: z.object({ expectedRevisionId: int4Id, removedRuleIds: ruleIds }).strict().nullable(),
  }).strict(),
  categories: z.array(z.object({ categoryId: int4Id, expectedRevisionId: int4Id.nullable(), patch: categoryListingSettingPatchSchema }).strict()),
  products: z.array(z.object({ productId: int4Id, expectedRevisionId: int4Id.nullable(), patch: productListingSettingPatchSchema }).strict()),
}).strict();
export type ConversionWrites = z.infer<typeof conversionWritesSchema>;

/** The plan's writes in canonical form (conversionWritesSchema): what the writes hash covers and nothing else. */
export function conversionCanonicalWrites(plan: Pick<RulesConversionPlan, "storeConnectionId" | "profiles" | "categories" | "products">): ConversionWrites {
  const profile = <K extends string>(write: PlannedProfileWrite | null, idsKey: K) => write === null ? null
    : { expectedRevisionId: write.expectedRevisionId, [idsKey]: [...write.removedIds].sort(compareIds) };
  const parsed = conversionWritesSchema.safeParse({
    v: 1,
    storeConnectionId: plan.storeConnectionId,
    profiles: {
      pricing: profile(plan.profiles.pricing, "removedGroupIds"),
      content: profile(plan.profiles.content, "removedGroupIds"),
      ebayRules: profile(plan.profiles.ebayRules, "removedRuleIds"),
    },
    categories: [...plan.categories].sort((a, b) => a.categoryId - b.categoryId)
      .map((write) => ({ categoryId: write.categoryId, expectedRevisionId: write.expectedRevisionId, patch: write.patch })),
    products: [...plan.products].sort((a, b) => a.productId - b.productId)
      .map((write) => ({ productId: write.productId, expectedRevisionId: write.expectedRevisionId, patch: write.patch })),
  });
  if (!parsed.success) {
    throw listingSettingsInvariantFailed("A conversion plan's writes do not fit their contract.", { storeConnectionId: plan.storeConnectionId });
  }
  return parsed.data;
}

export interface ConversionHashes {
  /** sha256 of the canonical writes: what the move would write. */
  readonly writesHash: string;
  /** sha256 of the writes hash, the changed sizes' compared keys and what blocks the move: what the vendor was shown. */
  readonly planHash: string;
}

/**
 * The two hashes an apply is bound to (plan 3.3, D1). The server keeps no
 * copy of the plan it showed, so the apply recomputes both under the store
 * lock and compares: a different plan hash with the same writes hash means
 * only the listed changes moved (a cost, say), a different writes hash that
 * the settings did. The plan hash covers each changed size by id with only
 * plan 3.2's key values on both sides, and the blocked sizes' ids and the
 * text flag, every list by id. Neither covers `generatedAt`, a name, the
 * first marks or the page. sha256 hex (node:crypto).
 */
export function conversionHashes(input: {
  plan: Pick<RulesConversionPlan, "storeConnectionId" | "profiles" | "categories" | "products">;
  rows: readonly ConversionChangeRow[];
  blocked: ConversionBlocks;
}): ConversionHashes {
  const writesHash = sha256Hex(JSON.stringify(conversionCanonicalWrites(input.plan)));
  const byId = <T extends { productVariantId: number }>(items: readonly T[]) => [...items].sort((a, b) => a.productVariantId - b.productVariantId);
  const planHash = sha256Hex(JSON.stringify({
    v: 1,
    writesHash,
    diff: byId(input.rows).map((row) => ({ productVariantId: row.productVariantId, changed: row.changed,
      before: conversionKeyValues(row.before), after: conversionKeyValues(row.after) })),
    blocked: {
      wouldLosePrice: byId(input.blocked.wouldLosePrice).map((size) => size.productVariantId),
      wouldBlockListing: byId(input.blocked.wouldBlockListing).map((size) => size.productVariantId),
      tooMuchText: input.blocked.tooMuchText,
    },
  }));
  return { writesHash, planHash };
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// One check (plan 4.A.8) and its answer (plan 4.A.3)
// ---------------------------------------------------------------------------

/** What the move would change for one store: the rows, the blocks, the state and the hashes (null only without older rules). */
export interface ConversionDiff {
  readonly rows: readonly ConversionChangeRow[];
  readonly blocked: ConversionBlocks;
  readonly state: ConversionState;
  readonly hashes: ConversionHashes | null;
}

const NOTHING_BLOCKED: ConversionBlocks = Object.freeze({ wouldLosePrice: [], wouldBlockListing: [], tooMuchText: false, addedProductTextBytes: 0 });

/**
 * The whole check of one plan over the inputs it was planned from (plan
 * 4.A.8): the after inputs, the diff, the blocks, the state and the hashes.
 * A store with no older rules is not compared at all (no planning runs): its
 * state is `no_older_rules` and it has no hashes.
 */
export function diffRulesConversion(inputs: ConversionInputs, plan: RulesConversionPlan): ConversionDiff {
  const counts = olderGroupRuleCounts(inputs.listing);
  if (plan.storeConnectionId !== inputs.listing.store.storeConnectionId || JSON.stringify(counts) !== JSON.stringify(plan.olderRules)) {
    throw listingSettingsInvariantFailed("A conversion plan was checked against inputs it was not planned from.", {
      storeConnectionId: inputs.listing.store.storeConnectionId,
    });
  }
  if (olderRuleTotal(counts) === 0) return { rows: [], blocked: NOTHING_BLOCKED, state: "no_older_rules", hashes: null };
  const rows = compareConversion(inputs.listing, conversionAfterInputs(inputs, plan));
  const blocked = conversionBlocks({ listing: inputs.listing, rows, plan, storeTextBytes: inputs.storeTextBytes });
  return { rows, blocked, state: conversionState({ olderRules: plan.olderRules, rows, blocked }), hashes: conversionHashes({ plan, rows, blocked }) };
}

/** One store's check: the plan and its diff over the same inputs. */
export interface RulesConversionCheck {
  readonly plan: RulesConversionPlan;
  readonly diff: ConversionDiff;
}

/**
 * The one entry point for a check (plan 4.A.8): the plan and the diff over
 * the same inputs, so no caller pairs a plan with another plan's diff. The
 * dry run (11a2), the apply under the store lock (11c2) and the job (11e2)
 * all call this; the step functions stay exported for the tests.
 */
export function checkRulesConversion(inputs: ConversionInputs): RulesConversionCheck {
  const plan = planRulesConversion(inputs);
  return { plan, diff: diffRulesConversion(inputs, plan) };
}

/**
 * The dry run's answer for one page (plan 4.A.3): the state and both hashes,
 * the older rules' counts, what blocks the move, what the rules become, the
 * report, the kept rows and one page of CONVERSION_PAGE_SIZE changed sizes.
 * Every list counts all its items and carries at most
 * MAX_CONVERSION_REPORT_ITEMS of them, ordered by name, then id; ids are keys
 * only. `generatedAt` is the caller's clock (no clock read here). The route
 * parses the answer with listingRulesConversionCheckSchema (11a2). A page
 * outside 0..MAX_CONVERSION_PAGE is refused as a fatal invariant (the route
 * parses the page first), and so is a diff that does not belong to the plan:
 * its state and both hashes must be the ones the plan's writes and the diff's
 * own rows and blocks give, so the answer never shows one plan's writes
 * beside another's rows and hashes.
 */
export function conversionCheckView(plan: RulesConversionPlan, diff: ConversionDiff, page: number,
  generatedAt: Date): ListingRulesConversionCheck {
  if (!Number.isSafeInteger(page) || page < 0 || page > MAX_CONVERSION_PAGE) {
    throw listingSettingsInvariantFailed("A conversion check page is outside its bounds.", { page });
  }
  if (!Number.isFinite(generatedAt.getTime())) throw listingSettingsInvariantFailed("A conversion check has no valid time.");
  assertDiffOfPlan(plan, diff);
  const byCategoryName = (a: PlannedCategoryWrite, b: PlannedCategoryWrite) =>
    CONVERSION_NAME_ORDER.compare(a.categoryName, b.categoryName) || a.categoryId - b.categoryId;
  const byProductName = (a: PlannedProductWrite, b: PlannedProductWrite) =>
    CONVERSION_NAME_ORDER.compare(a.productName, b.productName) || a.productId - b.productId;
  const start = page * CONVERSION_PAGE_SIZE;
  return {
    storeConnectionId: plan.storeConnectionId,
    generatedAt: generatedAt.toISOString(),
    state: diff.state,
    planHash: diff.hashes?.planHash ?? null,
    writesHash: diff.hashes?.writesHash ?? null,
    olderRules: { ...plan.olderRules },
    blocked: {
      wouldLosePrice: conversionList(diff.blocked.wouldLosePrice.map((size) => ({ ...size }))),
      wouldBlockListing: conversionList(diff.blocked.wouldBlockListing.map((size) => ({ ...size, reasons: [...size.reasons] }))),
      tooMuchText: diff.blocked.tooMuchText,
    },
    becomes: {
      categories: conversionList([...plan.categories].sort(byCategoryName)
        .map((write) => ({ categoryId: write.categoryId, categoryName: write.categoryName, settings: [...write.settings] }))),
      products: conversionList([...plan.products].sort(byProductName)
        .map((write) => ({ productId: write.productId, productName: write.productName, settings: [...write.settings] }))),
    },
    report: {
      unmatched: conversionList(plan.report.unmatched),
      shared: conversionList(plan.report.shared),
      nameMismatches: conversionList(plan.report.nameMismatches),
      neverApplies: conversionList(plan.report.neverApplies),
      ties: conversionList(plan.report.ties),
      someSizesOnly: conversionList(plan.report.someSizesOnly),
      mixed: conversionList(plan.report.mixed),
    },
    kept: { ...plan.kept },
    changes: { page, pageSize: CONVERSION_PAGE_SIZE, total: diff.rows.length, rows: diff.rows.slice(start, start + CONVERSION_PAGE_SIZE) },
  };
}

/** A diff belongs to a plan when its state and hashes are the ones the plan's writes and the diff's rows and blocks give. */
function assertDiffOfPlan(plan: RulesConversionPlan, diff: ConversionDiff): void {
  const state = conversionState({ olderRules: plan.olderRules, rows: diff.rows, blocked: diff.blocked });
  const hashes = state === "no_older_rules" ? null : conversionHashes({ plan, rows: diff.rows, blocked: diff.blocked });
  if (diff.state !== state || diff.hashes?.writesHash !== hashes?.writesHash || diff.hashes?.planHash !== hashes?.planHash) {
    throw listingSettingsInvariantFailed("A conversion diff does not belong to its plan.", { storeConnectionId: plan.storeConnectionId });
  }
}

// ---------------------------------------------------------------------------
// Order
// ---------------------------------------------------------------------------

/** Sorted as the read model sorts sizes (dropship-listing-settings-facts.ts compareCandidates). */
function compareCandidates(a: DropshipListingCatalogCandidate, b: DropshipListingCatalogCandidate): number {
  return CONVERSION_NAME_ORDER.compare(a.productName, b.productName) || a.productId - b.productId
    || CONVERSION_NAME_ORDER.compare(a.variantName, b.variantName) || a.productVariantId - b.productVariantId;
}

/** Ids by UTF-16 code units: never the server's locale, so the order is the same everywhere. */
function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function settingOrder(setting: ConversionSetting): number {
  return CONVERSION_SETTINGS.indexOf(setting);
}

function tieOrder(setting: ConversionTieSetting): number {
  return CONVERSION_TIE_SETTINGS.indexOf(setting);
}

/** Rule items by rule name, then the category name they name (if any), then kind, then rule id; the ids are dropped. */
function sortRuleItems<T extends { ruleName: string; kind: ConversionRuleKind; categoryName?: string }>(
  entries: ReadonlyArray<{ rule: ConversionRule; item: T }>): T[] {
  return [...entries].sort((a, b) => CONVERSION_NAME_ORDER.compare(a.item.ruleName, b.item.ruleName)
    || CONVERSION_NAME_ORDER.compare(a.item.categoryName ?? "", b.item.categoryName ?? "")
    || CONVERSION_RULE_KINDS.indexOf(a.item.kind) - CONVERSION_RULE_KINDS.indexOf(b.item.kind)
    || compareIds(a.rule.id, b.rule.id)).map(({ item }) => item);
}

function emptyReport(): PlannedReport {
  return { unmatched: [], shared: [], nameMismatches: [], neverApplies: [], ties: [], someSizesOnly: [], mixed: [] };
}
