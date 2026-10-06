import { createHash } from "node:crypto";
import { MAX_NAMED_CATALOG_GROUP_ITEMS } from "../../../../shared/dropship/catalog-scope";
import { decideDropshipListingAccess, type DropshipListingAccessDecision } from "../../../../shared/dropship/listing-access";
import type { ContentProfileState, SavedListingContent } from "../../../../shared/dropship/listing-content";
import {
  listingAmountCentsSchema, listingPriceFollowsRules, resolveListingPrice,
  type ListingPriceSetting, type SavedListingPriceRevision,
} from "../../../../shared/dropship/listing-price";
import {
  LISTING_SETTINGS_FIELDS, LISTING_SETTINGS_FIX_CODES, LISTING_SETTINGS_PAGE_SIZE, MAX_LISTING_SETTINGS_ATTENTION_ITEMS,
  type ListingSettingsAttentionCode, type ListingSettingsField, type ListingSettingsFixCode,
  type ListingSettingsPolicyKind, type ListingSettingsPriceIssue, type ListingSettingsPriceLimit,
  type ListingSettingsPriceRule, type ListingSettingsPriceSource, type ListingSettingsPricesInput,
  type ListingSettingsProductRow, type ListingSettingsProductsInput, type ListingSettingsRailState,
  type ListingSettingsSizePrice, type ListingSettingsSummary,
} from "../../../../shared/dropship/listing-settings";
import { pricingBasisCents, type PricingProfile, type PricingProfileState, type RulePriceResult } from "../../../../shared/dropship/pricing-rules";
import type { EbayCategoryRulesState } from "../../../../shared/dropship/ebay-category-rules";
import { evaluateListingPriceAgainstCost } from "../domain/listing-price-cost";
import type { ResolvedEbayListingCategory } from "./dropship-ebay-category-resolver";
import type { DropshipEbayListingPolicyOverride } from "./dropship-ebay-listing-policy-override-service";
import {
  listingCatalogHash, needsListingCatalogReview, prepareContentProfile, resolveContentTemplate,
} from "./dropship-listing-content-resolver";
import {
  applyEbayListingPolicyOverride, pricingPolicyMatchesCandidate,
  type DropshipExistingVendorListing, type DropshipListingCatalogCandidate,
  type DropshipListingStoreContext, type DropshipPricingPolicyRecord,
} from "./dropship-listing-preview-service";
import type { DropshipStoreListingConfig } from "./dropship-marketplace-listing-provider";
import type { DropshipProductCost } from "./dropship-product-cost";
import { createRulePriceResolver } from "./dropship-rule-price";

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

export interface ListingSettingsSizeFacts {
  price: ListingSettingsSizePrice;
  /** Each setting's value on this size, as a comparison key, and whether the size has its own value. */
  values: Readonly<Record<ListingSettingsField, { key: string; own: boolean }>>;
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
  { kind: "shipping", field: "shipping_policy", key: "fulfillmentPolicyId" },
  { kind: "return", field: "return_policy", key: "returnPolicyId" },
  { kind: "payment", field: "payment_policy", key: "paymentPolicyId" },
] as const satisfies ReadonlyArray<{ kind: ListingSettingsPolicyKind; field: ListingSettingsField; key: string }>;
/** Per-product attention lines, in the order a product's problems are named. */
const PRODUCT_ATTENTION_FIXES = ["no_ebay_category", "size_cannot_be_priced", "description_group_conflict"] as const satisfies
  readonly (ListingSettingsFixCode & ListingSettingsAttentionCode)[];
const LOCALE = "en-US";
/** Names sort the way a person reads them: case aside, and "Pack of 25" before "Pack of 100". Ids break ties. */
const NAME_ORDER = new Intl.Collator(LOCALE, { sensitivity: "base", numeric: true });

export function buildListingSettingsFacts(inputs: ListingSettingsInputs): ListingSettingsFacts {
  const resolver = createRulePriceResolver({ state: inputs.pricing });
  const preparedContent = prepareContentProfile(inputs.content);
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
      values: sizeValues(candidate, inputs, category, template.templateName, savedContent),
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
  const rulePrice = resolver.configured ? resolver.priceAtCost(candidate, costCents) : null;
  const ruleOwned = listingPriceFollowsRules({ saved, rulePrice });
  const resolved = resolveListingPrice({ saved, rulePrice, defaultPriceCents: candidate.defaultRetailPriceCents,
    existingListingPriceCents: inputs.existingListings.get(id)?.vendorRetailPriceCents ?? null });
  const priceCents = resolved.effectivePriceCents;
  const basis = ruleOwned ? rulePrice?.basis ?? null : null;
  const paused = inputs.pausedSince.get(id);
  return {
    productVariantId: id,
    productId: candidate.productId,
    productName: candidate.productName,
    sizeName: candidate.variantName,
    sku: candidate.sku,
    priceCents,
    source: PRICE_SOURCE[resolved.source],
    rule: ruleOwned && rulePrice ? describeRule(rulePrice, inputs.pricing.profile) : null,
    basis,
    basisAmountCents: basis ? validAmount(pricingBasisCents(basis, { productCostCents: costCents, catalogRetailCents: candidate.defaultRetailPriceCents })) : null,
    issue: priceIssue({ ruleOwned, rulePrice, priceCents }),
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

function sizeValues(candidate: DropshipListingCatalogCandidate, inputs: ListingSettingsInputs,
  category: ResolvedEbayListingCategory, templateName: string | null,
  savedContent: SavedListingContent | null): ListingSettingsSizeFacts["values"] {
  const override = inputs.policyOverrides.get(candidate.productVariantId) ?? null;
  const effective = applyEbayListingPolicyOverride(inputs.listingConfig, override);
  const shelf = [...(inputs.shelfAssignments.get(candidate.productVariantId) ?? [])].sort();
  const ownPolicy = (key: (typeof POLICY_KEYS)[number]["key"]) => override !== null && override[key] !== null;
  return {
    shipping_policy: { key: businessPolicyId(effective, "fulfillmentPolicyId") ?? "", own: ownPolicy("fulfillmentPolicyId") },
    return_policy: { key: businessPolicyId(effective, "returnPolicyId") ?? "", own: ownPolicy("returnPolicyId") },
    payment_policy: { key: businessPolicyId(effective, "paymentPolicyId") ?? "", own: ownPolicy("paymentPolicyId") },
    // Today a size gets its eBay category from the store's rules, its default or the catalog, never its own.
    ebay_category: { key: category.categoryId ?? "", own: false },
    store_shelf: { key: JSON.stringify(shelf), own: shelf.length > 0 },
    description: { key: JSON.stringify([templateName, ownTextKey(savedContent?.customText ?? null)]), own: savedContent?.customText != null },
  };
}

/**
 * A size's own description as a fixed-length key: the text itself can be
 * 20,000 characters, and the cache keeps every size's keys.
 */
function ownTextKey(customText: string | null): string | null {
  return customText === null ? null : createHash("sha256").update(customText).digest("hex");
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
        ownSettings: LISTING_SETTINGS_FIELDS.filter((field) => productSizes.some((size) => size.values[field].own)),
        sizesDiffer: LISTING_SETTINGS_FIELDS.filter((field) => new Set(productSizes.map((size) => size.values[field].key)).size > 1),
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
    case "own_settings": return product.row.ownSettings.length > 0;
    case "exact_prices": return product.row.exactPriceCount > 0;
    case "below_cost": return product.sizes.some((size) => size.price.belowCostByCents !== null);
    case "cannot_price": return product.sizes.some((size) => size.price.priceCents === null);
  }
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
      productsWithOwnSettings: facts.products.filter((product) => product.row.ownSettings.length > 0).length,
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
