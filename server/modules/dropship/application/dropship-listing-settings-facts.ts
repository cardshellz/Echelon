import { createHash } from "node:crypto";
import { MAX_NAMED_CATALOG_GROUP_ITEMS } from "../../../../shared/dropship/catalog-scope";
import { decideDropshipListingAccess, type DropshipListingAccessDecision } from "../../../../shared/dropship/listing-access";
import type { ContentProfileState, SavedListingContent } from "../../../../shared/dropship/listing-content";
import {
  RULE_PRICE_OUTSIDE_LIMIT_ISSUE, listingAmountCentsSchema, listingPriceFollowsRules, resolveListingPrice,
  type ListingPriceSetting, type SavedListingPriceRevision,
} from "../../../../shared/dropship/listing-price";
import {
  LISTING_SETTINGS_FIELD_SETTINGS, LISTING_SETTINGS_FIELDS, LISTING_SETTINGS_FIX_CODES, LISTING_SETTINGS_PAGE_SIZE,
  LISTING_SETTINGS_VALUE_SOURCES, MAX_LISTING_SETTINGS_ATTENTION_ITEMS, MAX_LISTING_SETTINGS_CATEGORY_EXAMPLES,
  type ListingSettingsAttentionCode, type ListingSettingsCategoriesResponse, type ListingSettingsCategoryDetail,
  type ListingSettingsCategorySettings, type ListingSettingsFixCode,
  type ListingSettingsPolicyKind, type ListingSettingsPriceIssue, type ListingSettingsPriceLimit,
  type ListingSettingsPriceRule, type ListingSettingsPriceSource, type ListingSettingsPricesInput,
  type ListingSettingsProductIdsInput, type ListingSettingsProductIdsResponse, type ListingSettingsProductOwnSettings,
  type ListingSettingsProductRow, type ListingSettingsProductSettings, type ListingSettingsProductsInput,
  type ListingSettingsRailState, type ListingSettingsSettingKey, type ListingSettingsSizePrice, type ListingSettingsSummary,
  type ListingSettingsUpdatedProductsInput, type ListingSettingsUpdatedProductsResponse, type ListingSettingsValueSource,
} from "../../../../shared/dropship/listing-settings";
import {
  CATEGORY_LISTING_SETTING_FIELDS, PRODUCT_LISTING_SETTING_FIELDS,
  type CategoryListingSettingField, type CategoryListingSettingRow, type ListingSettingMainText,
  type ProductCategoryMark, type ProductListingSettingField, type ProductListingSettingRow, type ProductListingSettingValues,
} from "../../../../shared/dropship/listing-setting-values";
import {
  PRODUCT_PRICE_RULE_NAME, pricingBasisCents, type PricingProfileState, type RulePriceResult,
} from "../../../../shared/dropship/pricing-rules";
import type { EbayCategoryRulesState } from "../../../../shared/dropship/ebay-category-rules";
import type { DescriptionTemplate } from "../../../../shared/dropship/listing-content";
import { categoryMoveChangedFields, categoryMoveMaskedFields } from "../domain/category-move-changes";
import { readEbayStoreShelfDefault, type EbayStoreShelfDefault } from "../domain/ebay-listing-setup-config";
import { LISTING_SETTING_LEFTOVER_FIELDS, listingSettingsInvariantFailed, type ListingSettingLeftoverField } from "../domain/listing-setting-values";
import { evaluateListingPriceAgainstCost } from "../domain/listing-price-cost";
import { computeDropshipMarketplaceQuantity, type DropshipVendorVariantOverride } from "../domain/vendor-selection";
import type { ResolvedEbayListingCategory } from "./dropship-ebay-category-resolver";
import type { DropshipEbayListingPolicyOverride } from "./dropship-ebay-listing-policy-override";
import {
  listingCatalogHash, needsListingCatalogReview, needsProductCatalogReview, prepareContentProfile, productCatalogHash,
  resolveContentTemplate, textDescriptionHtml, type TemplatePartSource,
} from "./dropship-listing-content-resolver";
import {
  applyEbayListingPolicyOverride, pricingPolicyMatchesCandidate, withRulePriceLimitCheck,
  type DropshipExistingVendorListing, type DropshipListingCatalogCandidate,
  type DropshipListingStoreContext, type DropshipPricingPolicyCandidate, type DropshipPricingPolicyRecord,
} from "./dropship-listing-preview-service";
import {
  layersFor, mergeListingPolicyOverride, resolveListingStoreShelf, type ListingSettingLayers, type ListingSettingLayerValues,
} from "./dropship-listing-setting-layers";
import type { DropshipStoreListingConfig } from "./dropship-marketplace-listing-provider";
import type { DropshipProductCost } from "./dropship-product-cost";
import { createRulePriceResolver, rulePriceContextOf, type RulePriceCandidate, type RulePriceResolver } from "./dropship-rule-price";
import type { DropshipAtpSnapshot } from "./dropship-selection-atp-service";

/**
 * The listing settings read model (Listing settings design 8.4) as pure
 * functions over loaded inputs: every chosen size's price and current
 * values, rolled up per product, and the summary's counts, attention lines and
 * rail line. No I/O and no clock: the caller passes `generatedAt`.
 *
 * Each value comes from the functions the preview and the push already use
 * (price, limits, cost, policy override, store shelf, eBay category,
 * description template), over the same product and category settings, so
 * this view says what step 3 would send. With no product or category rows
 * and no store shelf default every value and source is what it was before
 * those settings existed (plan PR 8b, D1).
 */

export interface ListingSettingsInputs {
  store: DropshipListingStoreContext;
  /** The store's chosen sizes: exposed by Card Shellz and selected by the vendor. */
  candidates: readonly DropshipListingCatalogCandidate[];
  /** Every size of each chosen product the vendor could choose (sellable and offered by Card Shellz now), chosen or not. */
  sizesTotalByProductId: ReadonlyMap<number, number>;
  savedPrices: ReadonlyMap<number, SavedListingPriceRevision>;
  existingListings: ReadonlyMap<number, DropshipExistingVendorListing>;
  pricing: PricingProfileState;
  costs: ReadonlyMap<number, DropshipProductCost>;
  pricingPolicies: readonly DropshipPricingPolicyRecord[];
  listingConfig: DropshipStoreListingConfig | null;
  policyOverrides: ReadonlyMap<number, DropshipEbayListingPolicyOverride>;
  shelfAssignments: ReadonlyMap<number, readonly string[]>;
  ebayCategoryRules: EbayCategoryRulesState;
  ebayCategories: ReadonlyMap<number, ResolvedEbayListingCategory>;
  content: ContentProfileState;
  contentSettings: ReadonlyMap<number, SavedListingContent>;
  /** When each paused size's live cost-change hold began. */
  pausedSince: ReadonlyMap<number, Date>;
  /**
   * The store's product and category settings for the chosen sizes, read once
   * in the load's snapshot (plan D26). `ebayCategories` were resolved with the
   * same layers.
   */
  layers: ListingSettingLayers;
  /**
   * The current Card Shellz name of every chosen size's category, and so of
   * every category in `layers` (plan D19): the name a value from that category
   * is shown under, and the name each category's view shows (PR 9e). Display
   * only; never hashed.
   */
  categoryNames: ReadonlyMap<number, string>;
  /**
   * What "Card Shellz updated products" reads (PR 9g, plan 10.6), apart from
   * `layers` and `categoryNames` so the views above read exactly what they
   * read before: each chosen product's category mark, and, only for the
   * categories moved products came from, their settings rows and live names.
   */
  categoryMoves: ListingSettingsCategoryMoveInputs;
}

/** The category marks of the chosen products and what their moves need, read in the load's snapshot. */
export interface ListingSettingsCategoryMoveInputs {
  /** Each chosen product's mark (the category the vendor last confirmed), by product id; a product with no mark is absent. */
  marks: ReadonlyMap<number, ProductCategoryMark>;
  /** The settings rows of the categories moved products came from, by category id; a category with no row is absent. */
  fromCategories: ReadonlyMap<number, CategoryListingSettingRow>;
  /** The current names of those categories; one Card Shellz has deleted is absent (a mark has no foreign key, plan D13). */
  fromCategoryNames: ReadonlyMap<number, string>;
}

/**
 * One size's value for one setting and where the size gets it. Equal keys
 * mean equal values. Sizes that agree share one frozen object (see
 * `SizeValueInterner`), since the cache keeps every size's values.
 */
export interface ListingSettingsSizeValue<V> {
  readonly key: string;
  readonly value: Readonly<V>;
  readonly source: ListingSettingsValueSource;
  readonly ruleName: string | null;
}

export type ListingSettingsSizeValues = {
  readonly [K in ListingSettingsSettingKey]: ListingSettingsSizeValue<ListingSettingsProductSettings[K][number]["value"]>;
};

export interface ListingSettingsSizeFacts {
  price: ListingSettingsSizePrice;
  values: ListingSettingsSizeValues;
  fixes: readonly ListingSettingsFixCode[];
}

export interface ListingSettingsProductFacts {
  row: Omit<ListingSettingsProductRow, "matchedSize">;
  sizes: readonly ListingSettingsSizeFacts[];
  /**
   * The product's Card Shellz category (catalog.product_categories.id), null
   * for none: what the `categoryId` filters match. This and
   * `settingsRevisionId` sit beside `row`, never inside it: the answers spread
   * `row` into strict schemas, which would refuse a field they do not name.
   */
  categoryId: number | null;
  /** The revision of the product's own settings in the load's snapshot; null when it has none. A bulk write sends it back. */
  settingsRevisionId: number | null;
  /**
   * The category settings the product holds its own value for (ownCategoryFields): its own row's, and for
   * policies and the shelf a leftover on a chosen size, in the order of CATEGORY_LISTING_SETTING_FIELDS. A
   * category's "Also clear theirs" clears the products whose fields meet the cleared settings (never the price,
   * which no clear names, plan P34). Beside `row`, as the two fields above.
   */
  ownCategoryFields: readonly CategoryListingSettingField[];
  /** Card Shellz moved the product since the vendor last confirmed its category; null otherwise. Beside `row` (no golden repin). */
  categoryMove: ListingSettingsCategoryMove | null;
}

/**
 * A chosen product whose mark's category IS DISTINCT FROM its current one
 * (plan 10.6): where it came from and where it is now, with the names read in
 * the load's snapshot, and the category settings that change for its listing
 * (categoryMoveChangedFields). A product with no mark is never moved: a move
 * before its first mark is not reported (design record 8.12).
 */
export interface ListingSettingsCategoryMove {
  fromCategoryId: number | null;
  /** Null for no category, and for a category Card Shellz has since deleted. */
  fromCategoryName: string | null;
  toCategoryId: number | null;
  /** Null for no category; null for a category means the inputs lack its name, which the updated products view refuses as a fault. */
  toCategoryName: string | null;
  changedFields: readonly CategoryListingSettingField[];
}

/** One Card Shellz category of the chosen products, for the category views (PR 9e). */
export interface ListingSettingsCategoryFacts {
  categoryId: number;
  /** The category's current name; null only when the inputs lack it, which the category views refuse as a fault. */
  name: string | null;
  /** The chosen products in the category, in the facts' product order. */
  productIds: readonly number[];
  /** The category's own settings row in the load's snapshot; null when it has none. */
  row: CategoryListingSettingRow | null;
  /** The settings the row sets, in the stored shape's order. */
  setFields: readonly CategoryListingSettingField[];
}

export interface ListingSettingsFacts {
  store: DropshipListingStoreContext;
  access: DropshipListingAccessDecision;
  storeDefaults: ListingSettingsSummary["storeDefaults"];
  /** Sorted by product name, then size name, then size id. */
  sizes: readonly ListingSettingsSizeFacts[];
  /** Sorted by product name, then product id. */
  products: readonly ListingSettingsProductFacts[];
  /** Every category that holds a chosen product, by its current name, then id; beside the fields above (PR 9e). */
  categories: readonly ListingSettingsCategoryFacts[];
  /** The store default shelf saved in the listing config, as every size reads it; null when none is saved. */
  storeShelfDefault: EbayStoreShelfDefault | null;
  /** The store's description template (text above and below), as the content profile holds it; null when it has none. */
  storeTemplate: DescriptionTemplate | null;
}

const PRICE_SOURCE: Readonly<Record<ListingPriceSetting["source"], ListingSettingsPriceSource>> = {
  override: "exact", rules: "rules", catalog_default: "catalog_price", saved_listing: "last_published", unavailable: "none",
};
const LIMIT_MODE: Readonly<Record<Exclude<DropshipPricingPolicyRecord["mode"], "off">, ListingSettingsPriceLimit["mode"]>> = {
  warn_only: "warn", block_listing_push: "block_listing", block_order_acceptance: "refuse_orders",
};
const RULE_ISSUES: ReadonlySet<string> = new Set(["pricing_rule_priority_conflict", "pricing_basis_unavailable", "pricing_result_out_of_range"]);
const POLICY_KEYS = [
  { kind: "shipping", setting: "shippingPolicy", key: "fulfillmentPolicyId" },
  { kind: "return", setting: "returnPolicy", key: "returnPolicyId" },
  { kind: "payment", setting: "paymentPolicy", key: "paymentPolicyId" },
] as const satisfies ReadonlyArray<{ kind: ListingSettingsPolicyKind; setting: ListingSettingsSettingKey; key: string }>;
/** Per-product attention lines, in the order a product's problems are named. */
const PRODUCT_ATTENTION_FIXES = ["no_ebay_category", "size_cannot_be_priced", "description_group_conflict"] as const satisfies
  readonly (ListingSettingsFixCode & ListingSettingsAttentionCode)[];
/** The sources that are the product's own value: one left on a size by today's per-size settings, or the product's own setting. */
const OWN_VALUE_SOURCES: ReadonlySet<ListingSettingsValueSource> = new Set<ListingSettingsValueSource>(["size", "product"]);
const LOCALE = "en-US";
/** Names sort the way a person reads them: case aside, and "Pack of 25" before "Pack of 100". Ids break ties. */
const NAME_ORDER = new Intl.Collator(LOCALE, { sensitivity: "base", numeric: true });

export function buildListingSettingsFacts(inputs: ListingSettingsInputs): ListingSettingsFacts {
  const resolver = createRulePriceResolver(rulePriceContextOf(inputs.pricing, inputs.layers));
  const preparedContent = prepareContentProfile(inputs.content);
  // Read once: the preview reads the same default for every size of the store.
  const storeShelfDefault = inputs.listingConfig ? readEbayStoreShelfDefault(inputs.listingConfig.marketplaceConfig) : null;
  const interner = new SizeValueInterner();
  const templateTexts = new TemplateTexts();
  const sizes = [...inputs.candidates].sort(compareCandidates).map((candidate) => {
    const layer = layersFor(inputs.layers, candidate);
    const price = sizePriceFacts(candidate, inputs, resolver);
    const template = resolveContentTemplate(preparedContent, candidate, inputs.layers);
    const savedContent = inputs.contentSettings.get(candidate.productVariantId) ?? null;
    // The product's own main text applies only to a size without its own, as in resolveListingContent.
    const productText = savedContent?.customText != null ? null : layer.product?.mainText ?? null;
    const category = inputs.ebayCategories.get(candidate.productVariantId);
    if (!category) throw new Error(`Listing settings has no eBay category result for size ${candidate.productVariantId}.`);
    const fixes = new Set<ListingSettingsFixCode>();
    if (category.source === "none") fixes.add("no_ebay_category");
    if (price.priceCents === null) fixes.add("size_cannot_be_priced");
    // Each catalog hash is worked out only for sizes with own text that uses it, the only ones it can flag:
    // a size's text against its size's catalog facts, the product's text against the product's (plan D17).
    if (savedContent?.customText != null && needsListingCatalogReview(savedContent, listingCatalogHash(candidate))) fixes.add("own_text_needs_check");
    if (productText !== null && needsProductCatalogReview(productText, productCatalogHash(candidate))) fixes.add("own_text_needs_check");
    if (template.conflict) fixes.add("description_group_conflict");
    return {
      price,
      values: sizeValues({ candidate, inputs, layer, category, template, savedContent, productText, storeShelfDefault,
        interner, templateTexts }),
      fixes: LISTING_SETTINGS_FIX_CODES.filter((code) => fixes.has(code)),
    } satisfies ListingSettingsSizeFacts;
  });
  const products = productFacts(sizes, inputs);
  return {
    store: inputs.store,
    access: decideDropshipListingAccess({
      action: "preview", vendorStatus: inputs.store.vendorStatus, entitlementStatus: inputs.store.entitlementStatus,
      store: { status: inputs.store.storeStatus, launchReady: inputs.store.storeLaunchReady },
    }),
    storeDefaults: buildListingSettingsStoreDefaults(inputs),
    sizes,
    products,
    categories: categoryFacts(products, inputs),
    storeShelfDefault,
    storeTemplate: inputs.content.profile?.defaultTemplate ?? null,
  };
}

/** One size's price as the page shows it (its "Now"), from the inputs every price writer and reader shares. */
export interface EffectiveSizePrice {
  /** The .ops cost when it is known and a valid amount, else null. */
  costCents: number | null;
  /** The rule price with its Card Shellz limit check; null when nothing can price the size by rule. */
  rulePrice: (RulePriceResult & { blockedByLimit: boolean }) | null;
  resolved: Pick<ListingPriceSetting, "effectivePriceCents" | "source">;
  priceCents: number | null;
}

/**
 * A size's effective price: its .ops cost, its rule price (only when a rule
 * covers it, with the Card Shellz limit check that sends a blocked `inherit`
 * size to retail, L1), then the shared resolver over the saved setting, the
 * rule price, the retail price and an earlier push's price. The read model's
 * size price and the W5/W7 price-change builder both call this one function,
 * so a builder's "before" is the page's "Now" by construction (plan 6.4). Pure.
 */
export function effectiveSizePrice(input: {
  candidate: RulePriceCandidate & DropshipPricingPolicyCandidate;
  saved: Pick<SavedListingPriceRevision, "overridePriceCents" | "pricingMode"> | null;
  cost: DropshipProductCost | null;
  pricingPolicies: readonly DropshipPricingPolicyRecord[];
  existingListingPriceCents: number | null;
  resolver: RulePriceResolver;
}): EffectiveSizePrice {
  const { candidate, saved, cost, resolver } = input;
  const costCents = cost?.status === "available" ? validAmount(cost.unitCostCents) : null;
  // A size nothing can price by rule has no rule price, as in the preview and the per-size price.
  const rulePrice = resolver.covers(candidate)
    ? withRulePriceLimitCheck(candidate, input.pricingPolicies, resolver.priceAtCost(candidate, costCents))
    : null;
  const resolved = resolveListingPrice({ saved, rulePrice, defaultPriceCents: candidate.defaultRetailPriceCents,
    existingListingPriceCents: input.existingListingPriceCents });
  return { costCents, rulePrice, resolved, priceCents: resolved.effectivePriceCents };
}

function sizePriceFacts(candidate: DropshipListingCatalogCandidate, inputs: ListingSettingsInputs,
  resolver: RulePriceResolver): ListingSettingsSizePrice {
  const id = candidate.productVariantId;
  const saved = inputs.savedPrices.get(id) ?? null;
  const { costCents, rulePrice, resolved, priceCents } = effectiveSizePrice({
    candidate, saved, cost: inputs.costs.get(id) ?? null, pricingPolicies: inputs.pricingPolicies,
    existingListingPriceCents: inputs.existingListings.get(id)?.vendorRetailPriceCents ?? null, resolver,
  });
  const ruleOwned = listingPriceFollowsRules({ saved, rulePrice });
  // An `inherit` size the rules give no usable price uses the retail price
  // (owner decisions A3 and L1). The vendor sees that it is a fallback, and why.
  const retailFallback = saved?.pricingMode === "inherit" && resolved.source === "catalog_default";
  const basis = ruleOwned ? rulePrice?.basis ?? null : null;
  const paused = inputs.pausedSince.get(id);
  return {
    productVariantId: id,
    productId: candidate.productId,
    productName: candidate.productName,
    sizeName: candidate.variantName,
    sku: candidate.sku,
    priceCents,
    source: retailFallback ? "retail_fallback" : PRICE_SOURCE[resolved.source],
    rule: ruleOwned && rulePrice ? describeRule(rulePrice, candidate, inputs) : null,
    basis,
    basisAmountCents: basis ? validAmount(pricingBasisCents(basis, { productCostCents: costCents, catalogRetailCents: candidate.defaultRetailPriceCents })) : null,
    issue: retailFallback ? ruleIssue(rulePrice) : priceIssue({ ruleOwned, rulePrice, priceCents }),
    costCents,
    belowCostByCents: belowCostBy(priceCents, costCents),
    limits: priceLimits(candidate, inputs.pricingPolicies, priceCents),
    pausedSince: paused ? paused.toISOString() : null,
    settingRevisionId: saved?.revisionId ?? null,
  };
}

/** How much each sale loses, with the same check the preview warns from; null when nothing is lost or nothing is known. */
function belowCostBy(priceCents: number | null, costCents: number | null): number | null {
  if (priceCents === null || costCents === null) return null;
  return evaluateListingPriceAgainstCost({ priceCents, unitCostCents: costCents }).warnings.length > 0 ? costCents - priceCents : null;
}

function priceIssue(input: { ruleOwned: boolean; rulePrice: RulePriceResult | null; priceCents: number | null }): ListingSettingsPriceIssue | null {
  if (input.priceCents !== null) return null;
  if (input.ruleOwned) {
    if (!input.rulePrice) return "pricing_rules_not_configured";
    const issue = input.rulePrice.issue;
    if (issue !== null && RULE_ISSUES.has(issue)) return issue as ListingSettingsPriceIssue;
  }
  return "price_unavailable";
}

/**
 * Why the rules give a `retail_fallback` size no usable price: null when no
 * rule covers the size (no store rules, no product or category price). Rules
 * that cover it always name why they give no price (`resolvePricingRule`); a
 * price they give is unusable only when a blocking Card Shellz limit refuses
 * it. Any other answer is a code fault.
 */
function ruleIssue(rulePrice: (RulePriceResult & { blockedByLimit: boolean }) | null): ListingSettingsPriceIssue | null {
  if (rulePrice === null) return null;
  const issue = rulePrice.issue;
  if (issue !== null && RULE_ISSUES.has(issue)) return issue as ListingSettingsPriceIssue;
  if (issue === null && rulePrice.blockedByLimit) return RULE_PRICE_OUTSIDE_LIMIT_ISSUE;
  throw new Error(`Pricing rules gave a size no price without a known reason (${issue ?? "none"}).`);
}

/**
 * The rule that won, with the recipe it priced by. A tie names no rule: none
 * of them priced the size. The level is read first: a product's or a
 * category's own price has no group id, and the store may have no profile.
 * The product is named by its Card Shellz name and the category by its
 * current one (plan D15, D19); names are display only and never hashed.
 */
function describeRule(rulePrice: RulePriceResult, candidate: DropshipListingCatalogCandidate,
  inputs: ListingSettingsInputs): ListingSettingsPriceRule | null {
  if (rulePrice.ruleLevel === "product") {
    const recipe = inputs.layers.products.get(candidate.productId)?.values.price ?? null;
    if (recipe === null) throw rulePriceWithoutRecipe("product", candidate);
    // A blank Card Shellz name cannot label a rule (the contract's name is never empty); the level's own name stands in.
    return { kind: "product", name: candidate.productName.trim() ? candidate.productName : PRODUCT_PRICE_RULE_NAME, recipe };
  }
  if (rulePrice.ruleLevel === "category") {
    const categoryId = candidate.categoryId;
    const recipe = categoryId === null ? null : inputs.layers.categories.get(categoryId)?.values.price ?? null;
    if (categoryId === null || recipe === null) throw rulePriceWithoutRecipe("category", candidate);
    return { kind: "category", name: categoryName(inputs, candidate), recipe };
  }
  const profile = inputs.pricing.profile;
  if (!profile || rulePrice.ruleName === null) return null;
  if (rulePrice.ruleId === null) return { kind: "store_default", name: rulePrice.ruleName, recipe: profile.defaultRecipe };
  const group = profile.groups.find((row) => row.id === rulePrice.ruleId);
  if (!group) throw new Error(`Pricing rule ${rulePrice.ruleId} is missing from the profile it was resolved from.`);
  return { kind: "group", name: group.name, recipe: group.recipe };
}

/** The resolver priced by a level whose recipe is not in the layers it was built from: a code fault, never retried. */
function rulePriceWithoutRecipe(level: "product" | "category", candidate: DropshipListingCatalogCandidate) {
  return listingSettingsInvariantFailed(`Listing settings found a ${level} rule price without the ${level}'s recipe.`, {
    ruleLevel: level, productId: candidate.productId, productVariantId: candidate.productVariantId, categoryId: candidate.categoryId,
  });
}

/**
 * The current Card Shellz name of the size's category, whose settings give it
 * a value. The load reads a name for every category in the layers, in the
 * same snapshot, and a category with settings cannot be deleted (migration
 * 0739's foreign key), so a missing name, or a category value on a product
 * with no category, means the inputs were built wrong: fatal.
 */
function categoryName(inputs: ListingSettingsInputs, candidate: DropshipListingCatalogCandidate): string {
  const name = candidate.categoryId === null ? undefined : inputs.categoryNames.get(candidate.categoryId);
  if (name === undefined) {
    throw listingSettingsInvariantFailed("Listing settings has no Card Shellz name for a category whose settings it uses.", {
      productId: candidate.productId, productVariantId: candidate.productVariantId, categoryId: candidate.categoryId,
    });
  }
  return name;
}

function priceLimits(candidate: DropshipListingCatalogCandidate, policies: readonly DropshipPricingPolicyRecord[],
  priceCents: number | null): ListingSettingsPriceLimit[] {
  return policies.filter((policy) => policy.mode !== "off" && pricingPolicyMatchesCandidate(policy, candidate)).map((policy) => {
    const mode = policy.mode as Exclude<DropshipPricingPolicyRecord["mode"], "off">;
    const belowFloor = priceCents !== null && policy.floorPriceCents !== null && priceCents < policy.floorPriceCents;
    const aboveCeiling = priceCents !== null && policy.ceilingPriceCents !== null && priceCents > policy.ceilingPriceCents;
    return { policyId: policy.id, floorCents: policy.floorPriceCents, ceilingCents: policy.ceilingPriceCents,
      mode: LIMIT_MODE[mode], breached: belowFloor ? "below_floor" : aboveCeiling ? "above_ceiling" : null };
  });
}

/**
 * Each setting's value on one size, with where the size gets it. The values
 * are the ones the preview and the push use: the size's policy override
 * merged with the product's and category's policies (mergeListingPolicyOverride)
 * and applied to the store's, the resolved eBay category, the shelf names in
 * their order (first shelf, then second, resolveListingStoreShelf), and the
 * template and main text the description is built from. A value from an
 * older group rule carries the rule's name, and one from a category the
 * category's current name; no other source is named.
 */
function sizeValues(input: {
  candidate: DropshipListingCatalogCandidate;
  inputs: ListingSettingsInputs;
  layer: ListingSettingLayerValues;
  category: ResolvedEbayListingCategory;
  template: ReturnType<typeof resolveContentTemplate>;
  savedContent: SavedListingContent | null;
  productText: ListingSettingMainText | null;
  storeShelfDefault: EbayStoreShelfDefault | null;
  interner: SizeValueInterner;
  templateTexts: TemplateTexts;
}): ListingSettingsSizeValues {
  const { candidate, inputs, layer, category, template, savedContent, productText, interner } = input;
  const named = (source: ListingSettingsValueSource, groupRuleName: string | null): string | null =>
    source === "group_rule" ? groupRuleName : source === "category" ? categoryName(inputs, candidate) : null;
  const merged = mergeListingPolicyOverride({ productVariantId: candidate.productVariantId,
    size: inputs.policyOverrides.get(candidate.productVariantId) ?? null, ...layer });
  const effective = applyEbayListingPolicyOverride(inputs.listingConfig, merged.override);
  const policy = <K extends (typeof POLICY_KEYS)[number]>(entry: K) => {
    const policyId = businessPolicyId(effective, entry.key);
    // An override applies only over a listing config (applyEbayListingPolicyOverride), so only then is it where the policy comes from.
    const from = inputs.listingConfig === null ? null : merged.sources[entry.key];
    const source: ListingSettingsValueSource = policyId === null ? "none" : from ?? "store_default";
    return interner.get(entry.setting, policyId ?? "", source, named(source, null), { policyId });
  };
  const shelf = resolveListingStoreShelf({ sizeNames: inputs.shelfAssignments.get(candidate.productVariantId) ?? null, ...layer,
    storeDefault: input.storeShelfDefault });
  const texts = input.templateTexts.of(template.template);
  const templateFrom = templateSource(template);
  const ebayCategorySource = CATEGORY_SOURCE[category.source];
  const ownText = savedContent?.customText ?? null;
  return {
    shippingPolicy: policy(POLICY_KEYS[0]),
    returnPolicy: policy(POLICY_KEYS[1]),
    paymentPolicy: policy(POLICY_KEYS[2]),
    // The key is the category id, as eBay lists by it; the name is a label that can differ for the same id.
    ebayCategory: interner.get("ebayCategory", category.categoryId ?? "", ebayCategorySource,
      named(ebayCategorySource, category.ruleName), { categoryId: category.categoryId, categoryName: category.categoryName }),
    storeShelf: interner.get("storeShelf", JSON.stringify(shelf.names), shelf.source, named(shelf.source, null), { names: shelf.names }),
    descriptionTemplate: template.conflict
      ? interner.get("descriptionTemplate", "conflict", "none", null, { hasIntroduction: false, hasFooter: false, groupConflict: true })
      : interner.get("descriptionTemplate", texts.key, templateFrom, named(templateFrom, template.groupName),
        { hasIntroduction: texts.hasIntroduction, hasFooter: texts.hasFooter, groupConflict: false }),
    // A size's own text, else the product's, else the Card Shellz text. Equal texts are one value, wherever they are set.
    mainText: ownText !== null
      ? interner.get("mainText", ownTextKey(ownText), "size", null, { own: true })
      : productText !== null
        ? interner.get("mainText", ownTextKey(productText.text), "product", null, { own: true })
        : interner.get("mainText", "catalog", "catalog", null, { own: false }),
  };
}

const CATEGORY_SOURCE: Readonly<Record<ResolvedEbayListingCategory["source"], ListingSettingsValueSource>> = {
  product: "product", rule: "group_rule", category: "category", store_default: "store_default", catalog: "catalog", none: "none",
};

/** The template parts' sources, closest first (resolveContentTemplate's order). */
const TEMPLATE_PART_SOURCES = ["product", "group_rule", "category", "store_default", "none"] as const satisfies readonly TemplatePartSource[];

/**
 * Where a size's text above and below come from: the closer of its two parts'
 * sources (plan D18), since the view has one source per value. A template
 * from one place gives that place, as before product and category settings.
 */
function templateSource(template: ReturnType<typeof resolveContentTemplate>): ListingSettingsValueSource {
  const { textAbove, textBelow } = template.parts;
  return TEMPLATE_PART_SOURCES.find((source) => source === textAbove.source || source === textBelow.source) ?? "none";
}

/**
 * A size's own main text as a fixed-length key: the text itself can be
 * 20,000 characters, and the cache keeps every size's keys.
 */
function ownTextKey(customText: string): string {
  return createHash("sha256").update(customText).digest("hex");
}

/**
 * Hands out one frozen object per distinct setting, key, source, rule and
 * value, so the sizes that agree share it instead of each keeping a copy. The
 * value is part of the identity, so a shared object is always exactly the
 * size's own value.
 */
class SizeValueInterner {
  /** The distinct values seen for each setting, source, rule and key; almost always one. */
  private readonly buckets = new Map<string, ListingSettingsSizeValue<object>[]>();

  get<K extends ListingSettingsSettingKey>(setting: K, key: string, source: ListingSettingsValueSource,
    ruleName: string | null, value: ListingSettingsProductSettings[K][number]["value"]): ListingSettingsSizeValues[K] {
    // Built once per size and setting, so no JSON here: the setting and source are fixed words
    // without ":", the rule name carries its length and the key comes last, so two identities
    // never share a bucket id.
    const bucketId = `${setting}:${source}:${ruleName === null ? "-" : `${ruleName.length}:${ruleName}`}:${key}`;
    let bucket = this.buckets.get(bucketId);
    if (!bucket) {
      bucket = [];
      this.buckets.set(bucketId, bucket);
    }
    let shared = bucket.find((entry) => sameFlatValue(entry.value, value));
    if (!shared) {
      shared = Object.freeze({ key, value: freezeValue(value), source, ruleName });
      bucket.push(shared);
    }
    return shared as ListingSettingsSizeValues[K];
  }
}

/** Values are flat: primitives and lists of primitives. Freezing those lists too keeps a shared value whole. */
function freezeValue<V extends object>(value: V): Readonly<V> {
  for (const field of Object.values(value)) if (Array.isArray(field)) Object.freeze(field);
  return Object.freeze(value);
}

/** Two flat values (primitives and lists of primitives) with the same fields and the same contents. */
function sameFlatValue(left: object, right: object): boolean {
  const a = left as Readonly<Record<string, unknown>>;
  const b = right as Readonly<Record<string, unknown>>;
  const fields = Object.keys(a);
  if (fields.length !== Object.keys(b).length) return false;
  return fields.every((field) => {
    if (!Object.prototype.hasOwnProperty.call(b, field)) return false;
    const x = a[field];
    const y = b[field];
    if (Array.isArray(x) || Array.isArray(y)) {
      return Array.isArray(x) && Array.isArray(y) && x.length === y.length && x.every((item, index) => Object.is(item, y[index]));
    }
    return Object.is(x, y);
  });
}

/**
 * The text above and below the main text as it is sent (textDescriptionHtml),
 * keyed by that sent text, so two templates that send the same words are the
 * same value. Worked out once per template, not once per size.
 */
class TemplateTexts {
  private readonly byTemplate = new Map<DescriptionTemplate | null, { key: string; hasIntroduction: boolean; hasFooter: boolean }>();

  of(template: DescriptionTemplate | null): { key: string; hasIntroduction: boolean; hasFooter: boolean } {
    let texts = this.byTemplate.get(template);
    if (!texts) {
      const introduction = textDescriptionHtml(template?.introduction ?? "");
      const footer = textDescriptionHtml(template?.footer ?? "");
      texts = { key: createHash("sha256").update(JSON.stringify([introduction, footer])).digest("hex"),
        hasIntroduction: introduction.length > 0, hasFooter: footer.length > 0 };
      this.byTemplate.set(template, texts);
    }
    return texts;
  }
}

function productFacts(sizes: readonly ListingSettingsSizeFacts[], inputs: ListingSettingsInputs): ListingSettingsProductFacts[] {
  const byProduct = new Map<number, ListingSettingsSizeFacts[]>();
  for (const size of sizes) {
    const list = byProduct.get(size.price.productId) ?? [];
    list.push(size);
    byProduct.set(size.price.productId, list);
  }
  const categories = new Map(inputs.candidates.map((candidate) => [candidate.productId, candidate.category]));
  const categoryIds = new Map(inputs.candidates.map((candidate) => [candidate.productId, candidate.categoryId]));
  return [...byProduct.entries()].map(([productId, productSizes]) => {
    const prices = productSizes.map((size) => size.price.priceCents).filter((cents): cents is number => cents !== null);
    const sizesTotal = inputs.sizesTotalByProductId.get(productId);
    if (sizesTotal === undefined || sizesTotal < productSizes.length) {
      throw new Error(`Listing settings has no valid size count for product ${productId}.`);
    }
    const fixes = new Set(productSizes.flatMap((size) => size.fixes));
    const productOwnFields = productOwnFieldsOf(inputs.layers.products.get(productId)?.values ?? null);
    // 9e's per-size own-field facts, read once for both uses below.
    const sizeLeftovers = productSizes.map((size) => sizeLeftoverFieldsOf(inputs, size.price.productVariantId));
    const categoryId = categoryIds.get(productId) ?? null;
    return {
      row: {
        productId,
        productName: productSizes[0].price.productName,
        category: categories.get(productId) ?? null,
        sizesChosen: productSizes.length,
        sizesTotal,
        priceRange: prices.length ? { minCents: Math.min(...prices), maxCents: Math.max(...prices) } : null,
        exactPriceCount: productSizes.filter((size) => size.price.source === "exact").length,
        ownSettings: LISTING_SETTINGS_FIELDS.filter((field) => LISTING_SETTINGS_FIELD_SETTINGS[field]
          .some((setting) => productSizes.some((size) => OWN_VALUE_SOURCES.has(size.values[setting].source)))),
        sizesDiffer: LISTING_SETTINGS_FIELDS.filter((field) => LISTING_SETTINGS_FIELD_SETTINGS[field]
          .some((setting) => new Set(productSizes.map((size) => size.values[setting].key)).size > 1)),
        fixes: LISTING_SETTINGS_FIX_CODES.filter((code) => fixes.has(code)),
      },
      sizes: productSizes,
      categoryId,
      settingsRevisionId: inputs.layers.products.get(productId)?.revisionId ?? null,
      ownCategoryFields: ownCategoryFields({ productOwnFields, sizeLeftovers }),
      categoryMove: categoryMoveOf({ inputs, productId, categoryId, productOwnFields, productSizes, sizeLeftovers }),
    };
  }).sort((a, b) => NAME_ORDER.compare(a.row.productName, b.row.productName) || a.row.productId - b.row.productId);
}

/**
 * Every category that holds a chosen product, with its live name, its chosen
 * products and its own row, sorted by name, then id. The name is the one the
 * load read for the category; a missing one is kept as null here and refused
 * by the category views (the size and product views do not name categories
 * without settings).
 */
function categoryFacts(products: readonly ListingSettingsProductFacts[], inputs: ListingSettingsInputs): ListingSettingsCategoryFacts[] {
  const byCategory = new Map<number, number[]>();
  for (const product of products) {
    if (product.categoryId === null) continue;
    const list = byCategory.get(product.categoryId) ?? [];
    list.push(product.row.productId);
    byCategory.set(product.categoryId, list);
  }
  return [...byCategory.entries()].map(([categoryId, productIds]) => {
    const row = inputs.layers.categories.get(categoryId) ?? null;
    return {
      categoryId,
      name: inputs.categoryNames.get(categoryId) ?? null,
      productIds,
      row,
      setFields: row === null ? [] : CATEGORY_LISTING_SETTING_FIELDS.filter((field) => row.values[field] !== null),
    };
  }).sort((a, b) => NAME_ORDER.compare(a.name ?? "", b.name ?? "") || a.categoryId - b.categoryId);
}

/**
 * The product's move, when its mark's category differs from its current one
 * (null against an id counts: into or out of a category). The "from" row and
 * name come from `categoryMoves`, the current ones from `layers` and
 * `categoryNames`, which hold every chosen product's category.
 */
function categoryMoveOf(input: {
  inputs: ListingSettingsInputs;
  productId: number;
  categoryId: number | null;
  productOwnFields: ReadonlySet<ProductListingSettingField>;
  /** The product's chosen sizes, and each one's leftovers at the same index. */
  productSizes: readonly ListingSettingsSizeFacts[];
  sizeLeftovers: ReadonlyArray<readonly ListingSettingLeftoverField[]>;
}): ListingSettingsCategoryMove | null {
  const { inputs, productId, categoryId } = input;
  const mark = inputs.categoryMoves.marks.get(productId);
  if (mark === undefined || mark.categoryId === categoryId) return null;
  const sizes = input.productSizes.map((size, index) => ({
    ownsPrice: sizeOwnsPrice(inputs.savedPrices.get(size.price.productVariantId) ?? null),
    leftovers: input.sizeLeftovers[index],
  }));
  const fromCategoryId = mark.categoryId;
  const from = fromCategoryId === null ? null : inputs.categoryMoves.fromCategories.get(fromCategoryId)?.values ?? null;
  const to = categoryId === null ? null : inputs.layers.categories.get(categoryId)?.values ?? null;
  return {
    fromCategoryId,
    fromCategoryName: fromCategoryId === null ? null : inputs.categoryMoves.fromCategoryNames.get(fromCategoryId) ?? null,
    toCategoryId: categoryId,
    toCategoryName: categoryId === null ? null : inputs.categoryNames.get(categoryId) ?? null,
    changedFields: categoryMoveChangedFields({ from, to,
      masked: categoryMoveMaskedFields({ productOwnFields: input.productOwnFields, sizes }) }),
  };
}

/**
 * A size owns its price when its saved setting never follows the rules, so no
 * category price (a category rule, dropship-rule-price.ts) can reach it: a
 * typed price (`fixed`), the catalog default, or a legacy row with no mode.
 * `rules` follows them, `inherit` does whenever they give a usable price, and
 * a size with no saved setting does whenever a rule covers it
 * (shared/dropship/listing-price.ts listingPriceFollowsRules). The price
 * source alone cannot tell: a saved catalog default and a size no rule covers
 * both show the catalog price.
 */
function sizeOwnsPrice(saved: Pick<SavedListingPriceRevision, "pricingMode"> | null): boolean {
  return saved !== null && saved.pricingMode !== "rules" && saved.pricingMode !== "inherit";
}

/** The fields a product's own row sets: a field is the product's own exactly when its stored value is not null. */
export function productOwnFieldsOf(values: ProductListingSettingValues | null): ReadonlySet<ProductListingSettingField> {
  return new Set(values === null ? [] : PRODUCT_LISTING_SETTING_FIELDS.filter((field) => values[field] !== null));
}

/**
 * A chosen size's leftovers from today's per-size panels, as the size views
 * read them: each policy id its override sets, and its shelf row (a row always
 * holds one or two names, migration 215). In LISTING_SETTING_LEFTOVER_FIELDS
 * order; the main text is not a category setting, so it is not read here.
 */
function sizeLeftoverFieldsOf(inputs: ListingSettingsInputs, productVariantId: number): ListingSettingLeftoverField[] {
  const override = inputs.policyOverrides.get(productVariantId) ?? null;
  const shelf = inputs.shelfAssignments.get(productVariantId) ?? null;
  const set: Record<ListingSettingLeftoverField, boolean> = {
    shippingPolicy: override?.fulfillmentPolicyId != null,
    returnPolicy: override?.returnPolicyId != null,
    paymentPolicy: override?.paymentPolicyId != null,
    storeShelf: shelf !== null && shelf.length > 0,
    mainText: false,
  };
  return LISTING_SETTING_LEFTOVER_FIELDS.filter((field) => set[field]);
}

/**
 * The category settings a product holds its own value for (plan 8.12 #1):
 * every one its own row sets (price, eBay category, shelf, policies, text
 * above and below), and a policy or the shelf that a leftover on any of its
 * chosen sizes sets. In CATEGORY_LISTING_SETTING_FIELDS order. One function
 * for the read (GET …/categories/:categoryId `ownValues`, from the rows it
 * loaded) and for W12 (from loadSettingFacts' flags and loadLeftoverFields),
 * so the set a vendor is shown is the set the save derives; were they to
 * differ, every save of that category would answer 409. Pure.
 */
export function ownCategoryFields(input: {
  productOwnFields: ReadonlySet<ProductListingSettingField> | null | undefined;
  sizeLeftovers: Iterable<readonly ListingSettingLeftoverField[]>;
}): CategoryListingSettingField[] {
  const own = new Set<CategoryListingSettingField>();
  for (const field of CATEGORY_LISTING_SETTING_FIELDS) {
    if (input.productOwnFields?.has(field)) own.add(field);
  }
  for (const leftovers of input.sizeLeftovers) {
    // A size's own main text is not a category setting: a category has none.
    for (const field of leftovers) if (field !== "mainText") own.add(field);
  }
  return CATEGORY_LISTING_SETTING_FIELDS.filter((field) => own.has(field));
}

/** The older group rules a store still holds, per kind (plan P21, D16). */
export interface OlderGroupRuleCounts {
  /** Pricing rule groups. */
  pricingGroups: number;
  /** Description template groups. */
  contentGroups: number;
  /** eBay category rules, every scope (`listings` included). */
  ebayCategoryRules: number;
}

/**
 * How many older group rules a store holds (plan P21): its pricing profile's
 * groups, its content profile's groups and its eBay category rules. Any of
 * them beats a category's setting (a group rule wins over a category), so a
 * store holding one cannot save category settings (D16, refused by W12 and the
 * category price check). One function for the summary's `groupRules` and for
 * the writers' refusal, so the two always count alike. Every stored eBay rules
 * document is version 1 (its schema accepts no other, and the reader refuses
 * any other), so no version is checked (v3r, C-feas-10). Pure.
 */
export function olderGroupRuleCounts(input: {
  pricing: Pick<PricingProfileState, "profile">;
  content: Pick<ContentProfileState, "profile">;
  ebayCategoryRules: Pick<EbayCategoryRulesState, "profile">;
}): OlderGroupRuleCounts {
  return {
    pricingGroups: input.pricing.profile?.groups.length ?? 0,
    contentGroups: input.content.profile?.groups.length ?? 0,
    ebayCategoryRules: input.ebayCategoryRules.profile?.rules.length ?? 0,
  };
}

/** The store-level settings. They need no size, so a selection that is too large still shows them. */
export function buildListingSettingsStoreDefaults(
  inputs: Pick<ListingSettingsInputs, "pricing" | "listingConfig" | "ebayCategoryRules" | "content">,
): ListingSettingsSummary["storeDefaults"] {
  const policy = (key: (typeof POLICY_KEYS)[number]["key"]) => ({
    policyId: businessPolicyId(inputs.listingConfig, key), verification: "not_checked" as const,
  });
  const defaultCategory = inputs.ebayCategoryRules.profile?.defaultCategory ?? null;
  const template = inputs.content.profile?.defaultTemplate ?? null;
  const groups = olderGroupRuleCounts(inputs);
  return {
    price: { recipe: inputs.pricing.profile?.defaultRecipe ?? null, groupRules: groups.pricingGroups },
    shippingPolicy: policy("fulfillmentPolicyId"),
    returnPolicy: policy("returnPolicyId"),
    paymentPolicy: policy("paymentPolicyId"),
    ebayCategory: {
      category: defaultCategory ? { categoryId: defaultCategory.categoryId, categoryName: defaultCategory.categoryName } : null,
      groupRules: groups.ebayCategoryRules,
    },
    description: {
      hasIntroduction: (template?.introduction ?? "").trim().length > 0,
      hasFooter: (template?.footer ?? "").trim().length > 0,
      groupRules: groups.contentGroups,
    },
  };
}

/** A policy id stored on the listing config, or null when none is saved. */
function businessPolicyId(config: DropshipStoreListingConfig | null, key: (typeof POLICY_KEYS)[number]["key"]): string | null {
  const policies = config?.marketplaceConfig.businessPolicies;
  if (!policies || typeof policies !== "object" || Array.isArray(policies)) return null;
  const value = (policies as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function validAmount(value: number | null): number | null {
  const parsed = listingAmountCentsSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function compareCandidates(a: DropshipListingCatalogCandidate, b: DropshipListingCatalogCandidate): number {
  return NAME_ORDER.compare(a.productName, b.productName) || a.productId - b.productId
    || NAME_ORDER.compare(a.variantName, b.variantName) || a.productVariantId - b.productVariantId;
}

// ---------------------------------------------------------------------------
// Views over the facts
// ---------------------------------------------------------------------------

export interface ListingSettingsPage<T> { total: number; rows: T[] }

export function selectListingSettingsPrices(facts: ListingSettingsFacts,
  input: Pick<ListingSettingsPricesInput, "search" | "show" | "page" | "categoryId">): ListingSettingsPage<ListingSettingsSizePrice> {
  const search = normalizeSearch(input.search);
  const inCategory = input.categoryId === undefined ? null
    : new Set(facts.products.filter((product) => product.categoryId === input.categoryId).map((product) => product.row.productId));
  const matching = facts.sizes.map((size) => size.price).filter((price) => {
    if (inCategory && !inCategory.has(price.productId)) return false;
    if (search && !sizeMatches(price, search) && !textMatches(price.productName, search)) return false;
    switch (input.show) {
      case "all": return true;
      case "exact_prices": return price.source === "exact";
      case "below_cost": return price.belowCostByCents !== null;
      case "cannot_price": return price.priceCents === null;
      case "paused": return price.pausedSince !== null;
      case "retail_fallback": return price.source === "retail_fallback";
    }
  });
  return pageOf(matching, input.page);
}

export function selectListingSettingsProducts(facts: ListingSettingsFacts,
  input: Pick<ListingSettingsProductsInput, "search" | "show" | "page" | "categoryId">): ListingSettingsPage<ListingSettingsProductRow> {
  const search = normalizeSearch(input.search);
  const matching: ListingSettingsProductRow[] = [];
  for (const product of facts.products) {
    if (input.categoryId !== undefined && product.categoryId !== input.categoryId) continue;
    if (!productShown(product, input.show)) continue;
    const match = productMatch(product, search);
    if (match) matching.push({ ...product.row, matchedSize: match.matchedSize });
  }
  return pageOf(matching, input.page);
}

/**
 * Every product the Products tab would list for these filters, on every
 * page, with its own settings' revision (Listing settings design 8.4
 * `idsOnly`): what "Select all N" and one product's editor send back with a
 * write. `productId` narrows to that one product.
 */
export function selectListingSettingsProductIds(facts: ListingSettingsFacts,
  input: Pick<ListingSettingsProductIdsInput, "search" | "show" | "categoryId" | "productId">): ListingSettingsProductIdsResponse {
  const search = normalizeSearch(input.search);
  const rows = facts.products
    .filter((product) => (input.productId === undefined || product.row.productId === input.productId)
      && (input.categoryId === undefined || product.categoryId === input.categoryId)
      && productShown(product, input.show) && productMatch(product, search) !== null)
    .map((product) => ({ productId: product.row.productId, revisionId: product.settingsRevisionId }));
  return { total: rows.length, rows };
}

/**
 * Whether a search matches the product: its name (no matched size), else the
 * first size whose name or SKU matches. An empty search matches every product.
 */
function productMatch(product: ListingSettingsProductFacts, search: string): { matchedSize: ListingSettingsProductRow["matchedSize"] } | null {
  if (!search || textMatches(product.row.productName, search)) return { matchedSize: null };
  const size = product.sizes.find((row) => sizeMatches(row.price, search));
  return size ? { matchedSize: { productVariantId: size.price.productVariantId, sizeName: size.price.sizeName, sku: size.price.sku } } : null;
}

function productShown(product: ListingSettingsProductFacts, show: ListingSettingsProductsInput["show"]): boolean {
  switch (show) {
    case "all": return true;
    case "needs_fix": return product.row.fixes.length > 0;
    case "sizes_differ": return product.row.sizesDiffer.length > 0;
    case "own_settings": return hasOwnSettings(product);
    case "exact_prices": return product.row.exactPriceCount > 0;
    case "below_cost": return product.sizes.some((size) => size.price.belowCostByCents !== null);
    case "cannot_price": return product.sizes.some((size) => size.price.priceCents === null);
  }
}

/**
 * A product with its own value for a setting (set on the product, or left on
 * one of its sizes) or a size with an exact price: what the Products tab
 * lists under "Own settings" (its Own settings column names exact prices
 * first, ownSettingsWords), so the chip, its count and the column agree.
 * A product's own price recipe is not counted: the row has no field for it
 * (LISTING_SETTINGS_FIELDS), so counting it here alone would list a product
 * under the chip with nothing in its column. No route writes product rows
 * before PR 9 (plan section 5); counting it needs the row contract widened first.
 */
function hasOwnSettings(product: ListingSettingsProductFacts): boolean {
  return product.row.ownSettings.length > 0 || product.row.exactPriceCount > 0;
}

function sizeMatches(price: Pick<ListingSettingsSizePrice, "sizeName" | "sku">, search: string): boolean {
  return textMatches(price.sizeName, search) || (price.sku !== null && textMatches(price.sku, search));
}
function textMatches(value: string, search: string): boolean {
  return value.toLocaleLowerCase(LOCALE).includes(search);
}
function normalizeSearch(value: string): string {
  return value.trim().toLocaleLowerCase(LOCALE);
}
function pageOf<T>(rows: readonly T[], page: number): ListingSettingsPage<T> {
  const start = page * LISTING_SETTINGS_PAGE_SIZE;
  return { total: rows.length, rows: rows.slice(start, start + LISTING_SETTINGS_PAGE_SIZE) };
}

// ---------------------------------------------------------------------------
// One product
// ---------------------------------------------------------------------------

export interface ListingSettingsProductSelection {
  product: Omit<ListingSettingsProductRow, "matchedSize">;
  settings: ListingSettingsProductSettings;
  /** The chosen sizes, by size name. Stock is read separately, live. */
  sizes: Array<{ price: ListingSettingsSizePrice; fixes: ListingSettingsFixCode[] }>;
}

/** One product's settings in full, or null when none of its sizes is chosen for this store. */
export function selectListingSettingsProduct(facts: ListingSettingsFacts, productId: number): ListingSettingsProductSelection | null {
  const product = facts.products.find((row) => row.row.productId === productId);
  if (!product) return null;
  const sizes = product.sizes;
  return {
    product: { ...product.row },
    settings: {
      shippingPolicy: settingValues(sizes, (values) => values.shippingPolicy),
      returnPolicy: settingValues(sizes, (values) => values.returnPolicy),
      paymentPolicy: settingValues(sizes, (values) => values.paymentPolicy),
      ebayCategory: settingValues(sizes, (values) => values.ebayCategory),
      storeShelf: settingValues(sizes, (values) => values.storeShelf),
      descriptionTemplate: settingValues(sizes, (values) => values.descriptionTemplate),
      mainText: settingValues(sizes, (values) => values.mainText),
    },
    sizes: sizes.map((size) => ({ price: size.price, fixes: [...size.fixes] })),
  };
}

// ---------------------------------------------------------------------------
// One product's own settings (PR 10, plan 4.2)
// ---------------------------------------------------------------------------

/**
 * The Card Shellz catalog facts a product's own main text is written against:
 * productCatalogHash's input. Every one is a product column, so any chosen
 * size's candidate gives the same facts.
 */
export type ListingSettingsProductCatalog = Pick<DropshipListingCatalogCandidate, "productId" | "description" | "brand" | "condition" | "itemSpecifics">;

export type ListingSettingsProductOwnSelection = Omit<ListingSettingsProductOwnSettings, "storeConnectionId" | "generatedAt">;

/**
 * One product's own settings row as its editor shows it (plan PR 10, 4.2): each
 * stored value with its stored names and texts, null for a setting the product
 * follows from its category or the store default, and the row's revision (null
 * with every value null when it has no row). Only the product's own row: no
 * size's leftover, category or store default is read here. The main text's
 * catalog hash stays on the server; `needsCheck` is the facts' own check
 * (needsProductCatalogReview against productCatalogHash, as a size's
 * `own_text_needs_check` is worked out), so `catalog` is required exactly when
 * the row holds a main text. New objects: the stored row is never handed out.
 * A row or catalog for another product is a programming fault (fatal). Pure.
 */
export function productOwnSettingsView(input: {
  productId: number;
  row: ProductListingSettingRow | null;
  catalog: ListingSettingsProductCatalog | null;
}): ListingSettingsProductOwnSelection {
  const { productId, row, catalog } = input;
  if (row !== null && row.productId !== productId) {
    throw listingSettingsInvariantFailed("A product's own settings were built from another product's row.", { productId, rowProductId: row.productId });
  }
  if (catalog !== null && catalog.productId !== productId) {
    throw listingSettingsInvariantFailed("A product's own settings were checked against another product's catalog facts.", {
      productId, catalogProductId: catalog.productId,
    });
  }
  const values = row?.values ?? null;
  const storedText = values?.mainText ?? null;
  let mainText: ListingSettingsProductOwnSelection["own"]["mainText"] = null;
  if (storedText !== null) {
    if (catalog === null) {
      throw listingSettingsInvariantFailed("A product's own main text was shown without the catalog facts it is checked against.", { productId });
    }
    mainText = { text: storedText.text, needsCheck: needsProductCatalogReview(storedText, productCatalogHash(catalog)) };
  }
  const policy = (stored: { id: string; name: string | null } | null) => stored && { id: stored.id, name: stored.name };
  const shelf = values?.storeShelf ?? null;
  return {
    productId,
    revisionId: row?.revisionId ?? null,
    own: {
      price: values?.price ? { ...values.price } : null,
      ebayCategory: values?.ebayCategory ? { categoryId: values.ebayCategory.categoryId, categoryName: values.ebayCategory.categoryName } : null,
      storeShelf: shelf === null ? null : shelf.mode === "none" ? { mode: "none" }
        : { mode: "own", shelves: shelf.shelves.map((entry) => ({ id: entry.id, name: entry.name })) },
      shippingPolicy: policy(values?.shippingPolicy ?? null),
      returnPolicy: policy(values?.returnPolicy ?? null),
      paymentPolicy: policy(values?.paymentPolicy ?? null),
      textAbove: templateText(values?.textAbove ?? null),
      textBelow: templateText(values?.textBelow ?? null),
      mainText,
    },
  };
}

// ---------------------------------------------------------------------------
// Card Shellz categories (PR 9e)
// ---------------------------------------------------------------------------

/** Every category that holds a chosen product, with its own settings' revision and what it sets, and the uncategorized count. */
export function selectListingSettingsCategories(facts: ListingSettingsFacts):
  Omit<ListingSettingsCategoriesResponse, "storeConnectionId" | "generatedAt"> {
  return {
    categories: facts.categories.map((category) => ({
      categoryId: category.categoryId,
      name: requiredCategoryName(category),
      productCount: category.productIds.length,
      revisionId: category.row?.revisionId ?? null,
      setFields: [...category.setFields],
    })),
    uncategorizedProductCount: facts.products.filter((product) => product.categoryId === null).length,
  };
}

export type ListingSettingsCategorySelection = Omit<ListingSettingsCategoryDetail, "storeConnectionId" | "generatedAt">;

/**
 * One category's settings in full, or null when none of the store's chosen
 * products is in it (a category that does not exist included): each setting
 * from the category's own row, else the store default, else none; the chosen
 * products in it that hold their own value for a category setting (with the
 * settings revision "Also clear theirs" sends back); and the first sizes'
 * prices as examples, in the sizes' order.
 */
export function selectListingSettingsCategory(facts: ListingSettingsFacts, categoryId: number): ListingSettingsCategorySelection | null {
  const category = facts.categories.find((row) => row.categoryId === categoryId);
  if (!category) return null;
  const inCategory = new Set(category.productIds);
  return {
    categoryId,
    name: requiredCategoryName(category),
    productCount: category.productIds.length,
    revisionId: category.row?.revisionId ?? null,
    settings: categorySettings(facts, category.row),
    ownValues: facts.products
      .filter((product) => inCategory.has(product.row.productId) && product.ownCategoryFields.length > 0)
      .map((product) => ({ productId: product.row.productId, revisionId: product.settingsRevisionId, fields: [...product.ownCategoryFields] })),
    examples: facts.sizes.filter((size) => inCategory.has(size.price.productId)).slice(0, MAX_LISTING_SETTINGS_CATEGORY_EXAMPLES)
      .map((size) => size.price),
  };
}

/**
 * The load reads the live name of every chosen size's category in the same
 * snapshot as the sizes. Deleting a category sets its products' category_id
 * to null in the same statement (ON DELETE SET NULL, migration 0108), so one
 * snapshot never shows a product pointing at a missing category, and a
 * missing name means the inputs were built wrong.
 */
function requiredCategoryName(category: ListingSettingsCategoryFacts): string {
  if (category.name === null) {
    throw listingSettingsInvariantFailed("Listing settings has no Card Shellz name for a chosen product's category.", {
      categoryId: category.categoryId,
    });
  }
  return category.name;
}

// ---------------------------------------------------------------------------
// Card Shellz updated products (PR 9g)
// ---------------------------------------------------------------------------

export type ListingSettingsUpdatedProductsSelection =
  Omit<ListingSettingsUpdatedProductsResponse, "storeConnectionId" | "page" | "pageSize" | "generatedAt">;

/**
 * The chosen products Card Shellz moved to another category since the vendor
 * last confirmed it, or whose own text needs a check (the `own_text_needs_check`
 * fix, as the summary counts it), in the facts' product order, one page of
 * them; and every moved product on every page, as W13's items ("Got it for
 * all N", plan 10.8 #1). New objects: the cached facts are never handed out.
 */
export function selectListingSettingsUpdatedProducts(facts: ListingSettingsFacts,
  input: Pick<ListingSettingsUpdatedProductsInput, "page">): ListingSettingsUpdatedProductsSelection {
  const updated = facts.products.filter((product) => product.categoryMove !== null || ownTextNeedsCheck(product));
  const moved = facts.products.flatMap((product) => product.categoryMove === null ? [] : [{ product, move: product.categoryMove }]);
  for (const { product, move } of moved) {
    // The current category is read with every chosen category's name in the same snapshot (plan 8.11).
    if (move.toCategoryId !== null && move.toCategoryName === null) {
      throw listingSettingsInvariantFailed("Listing settings has no Card Shellz name for a moved product's current category.", {
        productId: product.row.productId, categoryId: move.toCategoryId,
      });
    }
  }
  const page = pageOf(updated, input.page);
  return {
    total: page.total,
    rows: page.rows.map((product) => ({
      productId: product.row.productId,
      productName: product.row.productName,
      ownTextNeedsCheck: ownTextNeedsCheck(product),
      move: product.categoryMove === null ? null : {
        from: { categoryId: product.categoryMove.fromCategoryId, name: product.categoryMove.fromCategoryName },
        to: { categoryId: product.categoryMove.toCategoryId, name: product.categoryMove.toCategoryName },
        changedFields: [...product.categoryMove.changedFields],
      },
    })),
    moves: {
      total: moved.length,
      items: moved.map(({ product, move }) => ({ productId: product.row.productId, shownCategoryId: move.toCategoryId })),
    },
  };
}

/** The product's own text (or a size's) was written against Card Shellz facts that have since changed. */
function ownTextNeedsCheck(product: ListingSettingsProductFacts): boolean {
  return product.row.fixes.includes("own_text_needs_check");
}

/** Each setting: the category's own value, else the store default, else none. New objects: the cached facts are never handed out. */
function categorySettings(facts: ListingSettingsFacts, row: CategoryListingSettingRow | null): ListingSettingsCategorySettings {
  const values = row?.values ?? null;
  const defaults = facts.storeDefaults;
  const policy = (own: { id: string; name: string | null } | null, storePolicyId: string | null) =>
    sourcedSetting(own && { id: own.id, name: own.name }, storePolicyId === null ? null : { id: storePolicyId, name: null });
  const shelf = values?.storeShelf ?? null;
  const storeShelf = facts.storeShelfDefault;
  return {
    price: sourcedSetting(values?.price ? { ...values.price } : null, defaults.price.recipe ? { ...defaults.price.recipe } : null),
    ebayCategory: sourcedSetting(
      values?.ebayCategory ? { categoryId: values.ebayCategory.categoryId, categoryName: values.ebayCategory.categoryName } : null,
      defaults.ebayCategory.category ? { ...defaults.ebayCategory.category } : null),
    storeShelf: sourcedSetting(
      shelf === null ? null : shelf.mode === "none" ? { mode: "none" as const }
        : { mode: "own" as const, shelves: shelf.shelves.map((entry) => ({ id: entry.id, name: entry.name })) },
      storeShelf === null ? null : { mode: "own" as const, shelves: storeShelf.ids.map((id, index) => ({ id, name: storeShelf.names[index] })) }),
    shippingPolicy: policy(values?.shippingPolicy ?? null, defaults.shippingPolicy.policyId),
    returnPolicy: policy(values?.returnPolicy ?? null, defaults.returnPolicy.policyId),
    paymentPolicy: policy(values?.paymentPolicy ?? null, defaults.paymentPolicy.policyId),
    textAbove: sourcedSetting(templateText(values?.textAbove ?? null), storeTemplatePart(facts.storeTemplate, "introduction")),
    textBelow: sourcedSetting(templateText(values?.textBelow ?? null), storeTemplatePart(facts.storeTemplate, "footer")),
  };
}

function sourcedSetting<V>(own: V | null, storeDefault: V | null):
  { source: "category"; value: V } | { source: "store_default"; value: V } | { source: "none"; value: null } {
  if (own !== null) return { source: "category", value: own };
  return storeDefault !== null ? { source: "store_default", value: storeDefault } : { source: "none", value: null };
}

function templateText(value: { mode: "none" } | { mode: "own"; text: string } | null) {
  return value === null ? null : value.mode === "none" ? { mode: "none" as const } : { mode: "own" as const, text: value.text };
}

/**
 * The store template's part, as every size without a closer value reads it
 * (resolveContentTemplate): a store with a template gives its text, or
 * nothing when the part is empty; a store with none gives no value.
 */
function storeTemplatePart(template: DescriptionTemplate | null, part: "introduction" | "footer") {
  if (template === null) return null;
  const text = template[part];
  return text.length > 0 ? { mode: "own" as const, text } : { mode: "none" as const };
}

interface ValueSourceEntry { source: ListingSettingsValueSource; ruleName: string | null; productVariantIds: number[] }

/**
 * A setting's distinct values among the sizes, the most used first (ties in
 * size order), each with the sizes that have it grouped by where they get it.
 */
function settingValues<V>(sizes: readonly ListingSettingsSizeFacts[],
  pick: (values: ListingSettingsSizeValues) => ListingSettingsSizeValue<V>): Array<{ value: Readonly<V>; sources: ValueSourceEntry[] }> {
  const byKey = new Map<string, { value: Readonly<V>; firstIndex: number; count: number; sources: Map<string, ValueSourceEntry> }>();
  sizes.forEach((size, index) => {
    const entry = pick(size.values);
    let option = byKey.get(entry.key);
    if (!option) {
      option = { value: entry.value, firstIndex: index, count: 0, sources: new Map() };
      byKey.set(entry.key, option);
    }
    option.count += 1;
    const sourceId = JSON.stringify([entry.source, entry.ruleName]);
    let from = option.sources.get(sourceId);
    if (!from) {
      from = { source: entry.source, ruleName: entry.ruleName, productVariantIds: [] };
      option.sources.set(sourceId, from);
    }
    from.productVariantIds.push(size.price.productVariantId);
  });
  return [...byKey.values()]
    .sort((a, b) => b.count - a.count || a.firstIndex - b.firstIndex)
    .map((option) => ({ value: option.value, sources: [...option.sources.values()].sort(compareValueSources) }));
}

/**
 * The closest source first, as the precedence reads: the size's own value,
 * the product's, an older group rule, the product's category's, the store
 * default, Card Shellz.
 */
const SOURCE_ORDER: ReadonlyMap<ListingSettingsValueSource, number> = new Map(LISTING_SETTINGS_VALUE_SOURCES.map((source, index) => [source, index]));

function compareValueSources(a: ValueSourceEntry, b: ValueSourceEntry): number {
  return (SOURCE_ORDER.get(a.source) ?? 0) - (SOURCE_ORDER.get(b.source) ?? 0)
    || NAME_ORDER.compare(a.ruleName ?? "", b.ruleName ?? "");
}

/**
 * What Card Shellz would list for each size now, worked out as the preview
 * does (evaluateDropshipVendorCatalogSelection): the size's stock, capped by
 * the vendor's own quantity cap only under legacy authority, because
 * canonical quantities already carry it. The listing tier check stays on
 * step 3. A size the stock read did not answer for is a broken read, not 0.
 */
export function listingSettingsStockUnits(input: {
  snapshot: DropshipAtpSnapshot;
  overrides: readonly DropshipVendorVariantOverride[];
  productVariantIds: readonly number[];
}): Map<number, number> {
  const overrides = new Map(input.overrides.map((row) => [row.productVariantId, row]));
  return new Map(input.productVariantIds.map((productVariantId) => {
    const units = input.snapshot.quantities.get(productVariantId);
    if (units === undefined) throw new Error(`The stock read returned no quantity for size ${productVariantId}.`);
    const cap = input.snapshot.authority === "legacy" ? overrides.get(productVariantId) ?? null : null;
    return [productVariantId, computeDropshipMarketplaceQuantity(units, cap)];
  }));
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

export function buildListingSettingsSummary(facts: ListingSettingsFacts, generatedAt: Date): ListingSettingsSummary {
  const productsNeedingFix = facts.products.filter((product) => product.row.fixes.length > 0).length;
  const attention = attentionItems(facts);
  const missingPolicy = firstMissingPolicy(facts.storeDefaults);
  return {
    storeConnectionId: facts.store.storeConnectionId,
    storeStatus: facts.store.storeStatus,
    access: facts.access,
    catalog: { state: "ok", products: facts.products.length, sizes: facts.sizes.length },
    storeDefaults: facts.storeDefaults,
    counts: {
      productsNeedingFix,
      productsWithSizesDiffer: facts.products.filter((product) => product.row.sizesDiffer.length > 0).length,
      productsWithOwnSettings: facts.products.filter(hasOwnSettings).length,
      exactPrices: facts.sizes.filter((size) => size.price.source === "exact").length,
      belowCost: facts.sizes.filter((size) => size.price.belowCostByCents !== null).length,
      cannotPrice: facts.sizes.filter((size) => size.price.priceCents === null).length,
      paused: facts.sizes.filter((size) => size.price.pausedSince !== null).length,
    },
    attention: { items: attention.slice(0, MAX_LISTING_SETTINGS_ATTENTION_ITEMS), total: attention.length },
    rail: { state: railState({ access: facts.access, missingPolicy, productsNeedingFix }), productsNeedingFix, missingPolicy },
    generatedAt: generatedAt.toISOString(),
  };
}

/**
 * The summary when the selection is over the 10,000-size limit: the store
 * defaults and the banner's facts, with nothing about sizes, since they were
 * not read.
 */
export function buildTooLargeListingSettingsSummary(input: {
  store: DropshipListingStoreContext; storeDefaults: ListingSettingsSummary["storeDefaults"]; generatedAt: Date;
}): ListingSettingsSummary {
  return {
    storeConnectionId: input.store.storeConnectionId,
    storeStatus: input.store.storeStatus,
    access: decideDropshipListingAccess({
      action: "preview", vendorStatus: input.store.vendorStatus, entitlementStatus: input.store.entitlementStatus,
      store: { status: input.store.storeStatus, launchReady: input.store.storeLaunchReady },
    }),
    catalog: { state: "too_large", limit: MAX_NAMED_CATALOG_GROUP_ITEMS },
    storeDefaults: input.storeDefaults,
    counts: null,
    attention: { items: [], total: 0 },
    rail: { state: "too_many_sizes", productsNeedingFix: 0, missingPolicy: null },
    generatedAt: input.generatedAt.toISOString(),
  };
}

type AttentionItem = ListingSettingsSummary["attention"]["items"][number];

function attentionItems(facts: ListingSettingsFacts): AttentionItem[] {
  const items: AttentionItem[] = [];
  if (!facts.access.allowed && facts.access.resolution === "reconnect_store") {
    items.push({ code: "reconnect_store", count: 1, productId: null, productName: null });
  }
  const missingPolicies = POLICY_KEYS.filter(({ kind }) => policyDefault(facts.storeDefaults, kind).policyId === null).length;
  if (missingPolicies > 0) items.push({ code: "choose_store_policies", count: missingPolicies, productId: null, productName: null });
  const ownTextProducts = facts.products.filter((product) => product.row.fixes.includes("own_text_needs_check")).length;
  if (ownTextProducts > 0) items.push({ code: "own_text_needs_check", count: ownTextProducts, productId: null, productName: null });
  for (const product of facts.products) {
    const code = PRODUCT_ATTENTION_FIXES.find((fix) => product.row.fixes.includes(fix));
    if (!code) continue;
    items.push({ code, count: product.sizes.filter((size) => size.fixes.includes(code)).length,
      productId: product.row.productId, productName: product.row.productName });
  }
  return items;
}

function firstMissingPolicy(defaults: ListingSettingsSummary["storeDefaults"]): ListingSettingsPolicyKind | null {
  return POLICY_KEYS.find(({ kind }) => policyDefault(defaults, kind).policyId === null)?.kind ?? null;
}

function policyDefault(defaults: ListingSettingsSummary["storeDefaults"], kind: ListingSettingsPolicyKind) {
  return kind === "shipping" ? defaults.shippingPolicy : kind === "return" ? defaults.returnPolicy : defaults.paymentPolicy;
}

/** The rail names the first thing to do, in the order it has to be done. */
function railState(input: { access: DropshipListingAccessDecision; missingPolicy: ListingSettingsPolicyKind | null;
  productsNeedingFix: number }): ListingSettingsRailState {
  if (!input.access.allowed && input.access.resolution === "reconnect_store") return "reconnect_store";
  if (input.missingPolicy) return "choose_policy";
  if (input.productsNeedingFix > 0) return "products_need_fix";
  return "all_set";
}
