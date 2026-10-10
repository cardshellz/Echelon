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
  LISTING_SETTINGS_VALUE_SOURCES, MAX_LISTING_SETTINGS_ATTENTION_ITEMS,
  type ListingSettingsAttentionCode, type ListingSettingsFixCode,
  type ListingSettingsPolicyKind, type ListingSettingsPriceIssue, type ListingSettingsPriceLimit,
  type ListingSettingsPriceRule, type ListingSettingsPriceSource, type ListingSettingsPricesInput,
  type ListingSettingsProductRow, type ListingSettingsProductSettings, type ListingSettingsProductsInput,
  type ListingSettingsRailState, type ListingSettingsSettingKey, type ListingSettingsSizePrice, type ListingSettingsSummary,
  type ListingSettingsValueSource,
} from "../../../../shared/dropship/listing-settings";
import { pricingBasisCents, type PricingProfile, type PricingProfileState, type RulePriceResult } from "../../../../shared/dropship/pricing-rules";
import type { EbayCategoryRulesState } from "../../../../shared/dropship/ebay-category-rules";
import type { DescriptionTemplate } from "../../../../shared/dropship/listing-content";
import { evaluateListingPriceAgainstCost } from "../domain/listing-price-cost";
import { computeDropshipMarketplaceQuantity, type DropshipVendorVariantOverride } from "../domain/vendor-selection";
import type { ResolvedEbayListingCategory } from "./dropship-ebay-category-resolver";
import type { DropshipEbayListingPolicyOverride } from "./dropship-ebay-listing-policy-override-service";
import {
  listingCatalogHash, needsListingCatalogReview, prepareContentProfile, resolveContentTemplate, textDescriptionHtml,
} from "./dropship-listing-content-resolver";
import {
  applyEbayListingPolicyOverride, pricingPolicyMatchesCandidate, withRulePriceLimitCheck,
  type DropshipExistingVendorListing, type DropshipListingCatalogCandidate,
  type DropshipListingStoreContext, type DropshipPricingPolicyRecord,
} from "./dropship-listing-preview-service";
import type { DropshipStoreListingConfig } from "./dropship-marketplace-listing-provider";
import type { DropshipProductCost } from "./dropship-product-cost";
import { createRulePriceResolver } from "./dropship-rule-price";
import type { DropshipAtpSnapshot } from "./dropship-selection-atp-service";

/**
 * The listing settings read model (Listing settings design 8.4) as pure
 * functions over loaded inputs: every chosen size's price and current
 * values, rolled up per product, and the summary's counts, attention lines and
 * rail line. No I/O and no clock: the caller passes `generatedAt`.
 *
 * Each value comes from the functions the preview and the push already use
 * (price, limits, cost, policy override, eBay category, description
 * template), so this view says what step 3 would send.
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
}

export interface ListingSettingsFacts {
  store: DropshipListingStoreContext;
  access: DropshipListingAccessDecision;
  storeDefaults: ListingSettingsSummary["storeDefaults"];
  /** Sorted by product name, then size name, then size id. */
  sizes: readonly ListingSettingsSizeFacts[];
  /** Sorted by product name, then product id. */
  products: readonly ListingSettingsProductFacts[];
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
const LOCALE = "en-US";
/** Names sort the way a person reads them: case aside, and "Pack of 25" before "Pack of 100". Ids break ties. */
const NAME_ORDER = new Intl.Collator(LOCALE, { sensitivity: "base", numeric: true });

export function buildListingSettingsFacts(inputs: ListingSettingsInputs): ListingSettingsFacts {
  const resolver = createRulePriceResolver({ state: inputs.pricing });
  const preparedContent = prepareContentProfile(inputs.content);
  const interner = new SizeValueInterner();
  const templateTexts = new TemplateTexts();
  const sizes = [...inputs.candidates].sort(compareCandidates).map((candidate) => {
    const price = sizePriceFacts(candidate, inputs, resolver);
    const template = resolveContentTemplate(preparedContent, candidate);
    const savedContent = inputs.contentSettings.get(candidate.productVariantId) ?? null;
    const category = inputs.ebayCategories.get(candidate.productVariantId);
    if (!category) throw new Error(`Listing settings has no eBay category result for size ${candidate.productVariantId}.`);
    const fixes = new Set<ListingSettingsFixCode>();
    if (category.source === "none") fixes.add("no_ebay_category");
    if (price.priceCents === null) fixes.add("size_cannot_be_priced");
    // The catalog hash is worked out only for sizes with their own text, the only ones it can flag.
    if (savedContent?.customText != null && needsListingCatalogReview(savedContent, listingCatalogHash(candidate))) fixes.add("own_text_needs_check");
    if (template.conflict) fixes.add("description_group_conflict");
    return {
      price,
      values: sizeValues({ candidate, inputs, category, template, savedContent, interner, templateTexts }),
      fixes: LISTING_SETTINGS_FIX_CODES.filter((code) => fixes.has(code)),
    } satisfies ListingSettingsSizeFacts;
  });
  return {
    store: inputs.store,
    access: decideDropshipListingAccess({
      action: "preview", vendorStatus: inputs.store.vendorStatus, entitlementStatus: inputs.store.entitlementStatus,
      store: { status: inputs.store.storeStatus, launchReady: inputs.store.storeLaunchReady },
    }),
    storeDefaults: buildListingSettingsStoreDefaults(inputs),
    sizes,
    products: productFacts(sizes, inputs),
  };
}

function sizePriceFacts(candidate: DropshipListingCatalogCandidate, inputs: ListingSettingsInputs,
  resolver: ReturnType<typeof createRulePriceResolver>): ListingSettingsSizePrice {
  const id = candidate.productVariantId;
  const saved = inputs.savedPrices.get(id) ?? null;
  const cost = inputs.costs.get(id) ?? null;
  const costCents = cost?.status === "available" ? validAmount(cost.unitCostCents) : null;
  // Without rules there is no rule price, as in the preview and the per-size price.
  const rulePrice = resolver.configured
    ? withRulePriceLimitCheck(candidate, inputs.pricingPolicies, resolver.priceAtCost(candidate, costCents))
    : null;
  const ruleOwned = listingPriceFollowsRules({ saved, rulePrice });
  const resolved = resolveListingPrice({ saved, rulePrice, defaultPriceCents: candidate.defaultRetailPriceCents,
    existingListingPriceCents: inputs.existingListings.get(id)?.vendorRetailPriceCents ?? null });
  const priceCents = resolved.effectivePriceCents;
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
    rule: ruleOwned && rulePrice ? describeRule(rulePrice, inputs.pricing.profile) : null,
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
 * Why the store's rules give a `retail_fallback` size no usable price: null
 * when the store has no rules, so none covers the size. A configured store's
 * rules always name why they give no price (`resolvePricingRule`); a price
 * they give is unusable only when a blocking Card Shellz limit refuses it.
 * Any other answer is a code fault.
 */
function ruleIssue(rulePrice: (RulePriceResult & { blockedByLimit: boolean }) | null): ListingSettingsPriceIssue | null {
  if (rulePrice === null) return null;
  const issue = rulePrice.issue;
  if (issue !== null && RULE_ISSUES.has(issue)) return issue as ListingSettingsPriceIssue;
  if (issue === null && rulePrice.blockedByLimit) return RULE_PRICE_OUTSIDE_LIMIT_ISSUE;
  throw new Error(`Pricing rules gave a size no price without a known reason (${issue ?? "none"}).`);
}

/** The rule that won, with the recipe it priced by. A tie names no rule: none of them priced the size. */
function describeRule(rulePrice: RulePriceResult, profile: PricingProfile | null): ListingSettingsPriceRule | null {
  if (!profile || rulePrice.ruleName === null) return null;
  if (rulePrice.ruleId === null) return { kind: "store_default", name: rulePrice.ruleName, recipe: profile.defaultRecipe };
  const group = profile.groups.find((row) => row.id === rulePrice.ruleId);
  if (!group) throw new Error(`Pricing rule ${rulePrice.ruleId} is missing from the profile it was resolved from.`);
  return { kind: "group", name: group.name, recipe: group.recipe };
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
 * are the ones the preview and the push use: the policy override applied to
 * the store's policies, the resolved eBay category, the shelf names in their
 * order (first shelf, then second), and the template and main text the
 * description is built from.
 */
function sizeValues(input: {
  candidate: DropshipListingCatalogCandidate;
  inputs: ListingSettingsInputs;
  category: ResolvedEbayListingCategory;
  template: ReturnType<typeof resolveContentTemplate>;
  savedContent: SavedListingContent | null;
  interner: SizeValueInterner;
  templateTexts: TemplateTexts;
}): ListingSettingsSizeValues {
  const { candidate, inputs, category, template, savedContent, interner } = input;
  const override = inputs.policyOverrides.get(candidate.productVariantId) ?? null;
  const effective = applyEbayListingPolicyOverride(inputs.listingConfig, override);
  const policy = <K extends (typeof POLICY_KEYS)[number]>(entry: K) => {
    const policyId = businessPolicyId(effective, entry.key);
    // An override applies only over a listing config (applyEbayListingPolicyOverride), so only then is it the size's own.
    const own = inputs.listingConfig !== null && override !== null && override[entry.key] !== null;
    const source: ListingSettingsValueSource = policyId === null ? "none" : own ? "size" : "store_default";
    return interner.get(entry.setting, policyId ?? "", source, null, { policyId });
  };
  const shelf = inputs.shelfAssignments.get(candidate.productVariantId) ?? [];
  const texts = input.templateTexts.of(template.template);
  const ownText = savedContent?.customText ?? null;
  return {
    shippingPolicy: policy(POLICY_KEYS[0]),
    returnPolicy: policy(POLICY_KEYS[1]),
    paymentPolicy: policy(POLICY_KEYS[2]),
    // Today a size gets its eBay category from the store's rules, its default or the catalog, never its own.
    // The key is the category id, as eBay lists by it; the name is a label that can differ for the same id.
    ebayCategory: interner.get("ebayCategory", category.categoryId ?? "", CATEGORY_SOURCE[category.source],
      category.source === "rule" ? category.ruleName : null, { categoryId: category.categoryId, categoryName: category.categoryName }),
    storeShelf: interner.get("storeShelf", JSON.stringify(shelf), shelf.length > 0 ? "size" : "none", null, { names: [...shelf] }),
    descriptionTemplate: template.conflict
      ? interner.get("descriptionTemplate", "conflict", "none", null, { hasIntroduction: false, hasFooter: false, groupConflict: true })
      : interner.get("descriptionTemplate", texts.key, templateSource(template), template.groupName,
        { hasIntroduction: texts.hasIntroduction, hasFooter: texts.hasFooter, groupConflict: false }),
    mainText: ownText === null
      ? interner.get("mainText", "catalog", "catalog", null, { own: false })
      : interner.get("mainText", ownTextKey(ownText), "size", null, { own: true }),
  };
}

const CATEGORY_SOURCE: Readonly<Record<ResolvedEbayListingCategory["source"], ListingSettingsValueSource>> = {
  rule: "group_rule", store_default: "store_default", catalog: "catalog", none: "none",
};

function templateSource(template: ReturnType<typeof resolveContentTemplate>): ListingSettingsValueSource {
  if (template.groupName !== null) return "group_rule";
  return template.template ? "store_default" : "none";
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
  return [...byProduct.entries()].map(([productId, productSizes]) => {
    const prices = productSizes.map((size) => size.price.priceCents).filter((cents): cents is number => cents !== null);
    const sizesTotal = inputs.sizesTotalByProductId.get(productId);
    if (sizesTotal === undefined || sizesTotal < productSizes.length) {
      throw new Error(`Listing settings has no valid size count for product ${productId}.`);
    }
    const fixes = new Set(productSizes.flatMap((size) => size.fixes));
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
          .some((setting) => productSizes.some((size) => size.values[setting].source === "size"))),
        sizesDiffer: LISTING_SETTINGS_FIELDS.filter((field) => LISTING_SETTINGS_FIELD_SETTINGS[field]
          .some((setting) => new Set(productSizes.map((size) => size.values[setting].key)).size > 1)),
        fixes: LISTING_SETTINGS_FIX_CODES.filter((code) => fixes.has(code)),
      },
      sizes: productSizes,
    };
  }).sort((a, b) => NAME_ORDER.compare(a.row.productName, b.row.productName) || a.row.productId - b.row.productId);
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
  return {
    price: { recipe: inputs.pricing.profile?.defaultRecipe ?? null, groupRules: inputs.pricing.profile?.groups.length ?? 0 },
    shippingPolicy: policy("fulfillmentPolicyId"),
    returnPolicy: policy("returnPolicyId"),
    paymentPolicy: policy("paymentPolicyId"),
    ebayCategory: {
      category: defaultCategory ? { categoryId: defaultCategory.categoryId, categoryName: defaultCategory.categoryName } : null,
      groupRules: inputs.ebayCategoryRules.profile?.rules.length ?? 0,
    },
    description: {
      hasIntroduction: (template?.introduction ?? "").trim().length > 0,
      hasFooter: (template?.footer ?? "").trim().length > 0,
      groupRules: inputs.content.profile?.groups.length ?? 0,
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
  input: Pick<ListingSettingsPricesInput, "search" | "show" | "page">): ListingSettingsPage<ListingSettingsSizePrice> {
  const search = normalizeSearch(input.search);
  const matching = facts.sizes.map((size) => size.price).filter((price) => {
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
  input: Pick<ListingSettingsProductsInput, "search" | "show" | "page">): ListingSettingsPage<ListingSettingsProductRow> {
  const search = normalizeSearch(input.search);
  const matching: ListingSettingsProductRow[] = [];
  for (const product of facts.products) {
    if (!productShown(product, input.show)) continue;
    if (!search) {
      matching.push({ ...product.row, matchedSize: null });
      continue;
    }
    if (textMatches(product.row.productName, search)) {
      matching.push({ ...product.row, matchedSize: null });
      continue;
    }
    const size = product.sizes.find((row) => sizeMatches(row.price, search));
    if (size) matching.push({ ...product.row,
      matchedSize: { productVariantId: size.price.productVariantId, sizeName: size.price.sizeName, sku: size.price.sku } });
  }
  return pageOf(matching, input.page);
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
 * A product with a size that has its own value for a setting or an exact
 * price: what the Products tab lists under "Own settings" (its Own settings
 * column names exact prices first, ownSettingsWords), so the chip, its count
 * and the column agree.
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

/** The closest source first, as the precedence reads: the size's own value, an older group rule, the store default, Card Shellz. */
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
