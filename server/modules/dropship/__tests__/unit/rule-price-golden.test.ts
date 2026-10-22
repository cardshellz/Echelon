import type { PoolClient } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_LISTING_PRICE_CENTS, type ListingPriceSetting, type SavedListingPriceRevision,
} from "../../../../../shared/dropship/listing-price";
import type {
  CategoryListingSettingRow, CategoryListingSettingValues, ProductListingSettingRow,
} from "../../../../../shared/dropship/listing-setting-values";
import {
  CATEGORY_PRICE_RULE_NAME, PRODUCT_PRICE_RULE_NAME, pricingProfileStateSchema, type PricingProfile, type PricingProfileState, type PricingRecipe,
} from "../../../../../shared/dropship/pricing-rules";
import {
  createRulePriceResolver, NO_PRICING_PROFILE_STATE, pricingHash, rulePriceContextOf, withRecipes, type ListingRulePrice, type RulePriceCandidate,
} from "../../application/dropship-rule-price";
import { buildListingPriceChanges } from "../../application/dropship-listing-price-change-builder";
import { classifyListing, type CostActionVendorFacts } from "../../application/dropship-cost-change-listing-action-service";
import { prepareEbayCategoryRules, resolveEbayListingCategory } from "../../application/dropship-ebay-category-resolver";
import { buildListingSettingsFacts, type ListingSettingsInputs } from "../../application/dropship-listing-settings-facts";
import { EMPTY_LISTING_SETTING_LAYERS, type ListingSettingLayers } from "../../application/dropship-listing-setting-layers";
import { DropshipListingPriceService, type ListingPriceTransaction } from "../../application/dropship-listing-price-service";
import { DropshipPricingRulesService, type PricingRulesTransaction, type StoredPricingReview } from "../../application/dropship-pricing-rules-service";
import type { DropshipListingCatalogCandidate, DropshipListingPreviewRepository } from "../../application/dropship-listing-preview-service";
import type { DropshipProductCost } from "../../application/dropship-product-cost";
import { categoryValuesToColumns, productValuesToColumns } from "../../infrastructure/dropship-listing-setting-shared.repository";
import { readListingSettingLayers } from "../../infrastructure/dropship-listing-setting-layers.reader";
import { loadListingRulePrices } from "../../infrastructure/dropship-rule-price.loader";
import { PgShellzClubProductCostAdapter } from "../../infrastructure/shellz-club-product-cost.adapter";
import {
  GOLDEN_CATEGORIZED_CANDIDATE, GOLDEN_CATEGORY_NAMES, GOLDEN_CATEGORY_RECIPE, GOLDEN_PRODUCT_RECIPE,
  GOLDEN_RULE_PRICE_CASES, GOLDEN_RULE_PRICE_V2_CASES, GOLDEN_RULE_PRICES, GOLDEN_RULE_PRICES_V2, GOLDEN_RULE_PROFILE_STATE,
  goldenCategoryPriceRow, goldenLayers, goldenProductPriceRow, type GoldenRulePriceCase, type GoldenRulePriceV2,
  type GoldenRulePriceV2Case,
} from "../fixtures/rule-price-golden.fixture";

const STORE_ID = 22;
const VENDOR_ID = 10;
const cases = GOLDEN_RULE_PRICE_CASES.map((row, index) => [row.name, row, GOLDEN_RULE_PRICES[index]] as const);

function pinnedFields(price: ListingRulePrice, productVariantId: number) {
  return { productVariantId, priceCents: price.priceCents, ruleName: price.ruleName, ruleId: price.ruleId,
    issue: price.issue, basis: price.basis, profileRevisionId: price.profileRevisionId, evidenceHash: price.evidenceHash };
}

/** The evidence recipe written out in full: one sha256 over the whole JSON, as the code before the shared resolver did. */
function legacyEvidenceHash(state: PricingProfileState, row: GoldenRulePriceCase, price: { priceCents: number | null;
  ruleName: string | null; ruleId: string | null; issue: string | null }): string {
  return pricingHash({ profile: state, productVariantId: row.candidate.productVariantId,
    productId: row.candidate.productId, category: row.candidate.category,
    productLineIds: [...row.candidate.productLineIds].sort((a, b) => a - b),
    catalogRetailCents: row.candidate.defaultRetailPriceCents, cost: row.cost,
    price: { priceCents: price.priceCents, ruleName: price.ruleName, ruleId: price.ruleId, issue: price.issue } });
}

/** The golden profile with no product or category listing settings: every pin below is today's. */
const goldenResolver = () => createRulePriceResolver(rulePriceContextOf(GOLDEN_RULE_PROFILE_STATE, EMPTY_LISTING_SETTING_LAYERS));

/** The golden profile as readPricingProfile returns it from its database row. */
const profileRow = { id: GOLDEN_RULE_PROFILE_STATE.revisionId, profile: GOLDEN_RULE_PROFILE_STATE.profile,
  created_at: new Date(GOLDEN_RULE_PROFILE_STATE.updatedAt!) };

/** Stored product and category listing settings rows, as PR 8a's readers select them. */
interface StoredSettings { products?: readonly StoredProductRow[]; categories?: readonly StoredCategoryRow[] }
type StoredProductRow = ReturnType<typeof storedProductRow>;
type StoredCategoryRow = ReturnType<typeof storedCategoryRow>;

/**
 * Answers the pricing profile read and the product and category listing
 * settings reads, with no settings rows unless given (no product or category
 * sets a price) and only the rows of the ids asked for; any other query fails
 * the test.
 */
function fakeClient(profile: typeof profileRow | null, settings: StoredSettings = {}) {
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (/FROM dropship\.dropship_pricing_profiles/.test(sql)) return { rows: profile ? [profile] : [] };
    const ids = params[2] as readonly number[];
    if (/FROM dropship\.dropship_product_listing_settings s/.test(sql)) {
      return { rows: (settings.products ?? []).filter((row) => ids.includes(row.product_id)) };
    }
    if (/FROM dropship\.dropship_category_listing_settings s/.test(sql)) {
      return { rows: (settings.categories ?? []).filter((row) => ids.includes(row.category_id)) };
    }
    throw new Error(`Unexpected query: ${sql}`);
  });
  return { query, client: { query } as unknown as Pick<PoolClient, "query"> };
}

/** A product's settings row as PostgreSQL returns it from the listing settings read. */
function storedProductRow(productId: number, price: PricingRecipe) {
  return storedProductColumns(goldenProductPriceRow(productId, price));
}
function storedCategoryRow(categoryId: number, price: PricingRecipe) {
  return storedCategoryColumns(goldenCategoryPriceRow(categoryId, price));
}
/** A layer row as the listing settings read selects it; the revision's created_at is the row's updated time. */
function storedProductColumns(row: ProductListingSettingRow) {
  return { product_id: row.productId, revision_id: row.revisionId, ...productValuesToColumns(row.values), created_at: new Date(row.updatedAt) };
}
function storedCategoryColumns(row: CategoryListingSettingRow) {
  return { category_id: row.categoryId, revision_id: row.revisionId, ...categoryValuesToColumns(row.values), created_at: new Date(row.updatedAt) };
}

function costsFor(rows: readonly GoldenRulePriceCase[]): Map<number, DropshipProductCost> {
  // A size whose cost was never read has no entry, as the cost reader returns it.
  return new Map(rows.flatMap((row) => (row.cost ? [[row.candidate.productVariantId, row.cost] as const] : [])));
}

/** A golden size as a full catalog candidate, as the listing preview reader returns it. */
function catalogCandidate(row: GoldenRulePriceCase, categoryId = row.candidate.categoryId): DropshipListingCatalogCandidate {
  return { ...row.candidate, categoryId, productName: row.name, variantName: `Size ${row.candidate.productVariantId}`, title: row.name,
    sku: `SKU-${row.candidate.productVariantId}`, productIsActive: true, variantIsActive: true, variantUomType: "pack",
    unitsPerVariant: 1 } as DropshipListingCatalogCandidate;
}

/** The golden sizes as full catalog candidates. */
function catalogCandidates(): DropshipListingCatalogCandidate[] {
  return GOLDEN_RULE_PRICE_CASES.map((row) => catalogCandidate(row));
}

/** Store, vendor, entitlement and selection checks every per-size and review path makes first: all pass. */
function allowedCatalog(candidates: readonly DropshipListingCatalogCandidate[], saved: readonly SavedListingPriceRevision[] = []) {
  return {
    loadStoreContext: vi.fn(async () => ({ vendorId: VENDOR_ID, vendorStatus: "active", entitlementStatus: "active", storeStatus: "connected" })),
    listCatalogExposureRules: vi.fn(async () => [{ id: 1, scopeType: "catalog", action: "include" }]),
    listSelectionRules: vi.fn(async () => [{ id: 2, scopeType: "catalog", action: "include", isActive: true }]),
    listCatalogCandidates: vi.fn(async (ids: number[]) => candidates.filter((row) => ids.includes(row.productVariantId))),
    listVariantOverrides: vi.fn(async () => []), listExistingListings: vi.fn(async () => []),
    listSavedListingPrices: vi.fn(async () => [...saved]), listPricingPolicies: vi.fn(async () => []),
  };
}

/**
 * The golden store default proposed in a pricing review (W1) over the given
 * sizes, with the groups the store already holds (Listing settings PR 12,
 * D26): W1 refuses a new or changed group (D9), so a store with no pricing
 * profile is proposed the golden recipe with no groups, and the golden store
 * its own seven groups again. Reviewed against the store's current profile
 * `current` and the given listing settings layers.
 */
function goldenProposal(current: PricingProfileState): PricingProfile {
  return { ...GOLDEN_RULE_PROFILE_STATE.profile!, groups: current.profile?.groups ?? [] };
}

async function goldenReview(layers: ListingSettingLayers, options: { current?: PricingProfileState;
  candidates?: DropshipListingCatalogCandidate[]; saved?: SavedListingPriceRevision[] } = {}):
  Promise<Map<number, StoredPricingReview["rows"][number]>> {
  const { tx, review, stored } = goldenReviewRun(layers, options);
  const current = options.current ?? GOLDEN_RULE_PROFILE_STATE;
  await review(goldenProposal(current));
  expect(tx.loadRuleLayers).toHaveBeenCalledTimes(1);
  return new Map(stored()!.rows.map((row) => [row.productVariantId, row]));
}

/** The W1 review service over a fake transaction: `review` proposes a profile, `stored` is the review it stored, if any. */
function goldenReviewRun(layers: ListingSettingLayers, options: { current?: PricingProfileState;
  candidates?: DropshipListingCatalogCandidate[]; saved?: SavedListingPriceRevision[] } = {}) {
  const candidates = options.candidates ?? catalogCandidates();
  const current = options.current ?? GOLDEN_RULE_PROFILE_STATE;
  let stored: StoredPricingReview | null = null;
  const tx = { vendorId: VENDOR_ID, catalog: allowedCatalog(candidates, options.saved) as unknown as DropshipListingPreviewRepository,
    costs: { loadProductCosts: vi.fn(async () => costsFor(GOLDEN_RULE_PRICE_CASES)) },
    listVariantIds: vi.fn(async (afterId: number, limit: number) => candidates
      .map((row) => row.productVariantId).filter((id) => id > afterId).sort((a, b) => a - b).slice(0, limit)),
    listProductLines: vi.fn(async () => []), loadProfile: vi.fn(async () => current),
    loadRuleLayers: vi.fn(async () => layers),
    storeReview: vi.fn(async (review: StoredPricingReview) => { stored = review; }),
    loadReview: vi.fn(async () => stored), findApplication: vi.fn(async () => null), applyReview: vi.fn(async () => 1),
  } as unknown as PricingRulesTransaction;
  const service = new DropshipPricingRulesService({ repository: { execute: async (_member, _store, operation) => operation(tx) },
    clock: { now: () => new Date("2026-10-06T12:00:00.000Z") }, newId: () => "02892196-a1f2-4e72-823a-32188b9cb234",
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } });

  const review = (profile: PricingProfile) => service.reviewForMember("member-1", STORE_ID, { profile,
    expectedRevisionId: current.revisionId, releaseFixedOverrides: false });
  return { tx, review, stored: () => stored };
}

/**
 * The per-size price answer (W9 GET) for one size, through W9's own loader
 * call (dropship-listing-price.repository.ts): one size, no layers given, so
 * the loader reads the profile and the layers on `client`.
 */
async function perSizePrice(candidate: DropshipListingCatalogCandidate, client: Pick<PoolClient, "query">,
  saved: SavedListingPriceRevision | null = null): Promise<ListingPriceSetting> {
  const tx = { vendorId: VENDOR_ID, catalog: allowedCatalog([candidate]), loadSaved: vi.fn(async () => saved),
    loadRulePrice: async (size: DropshipListingCatalogCandidate) => (await loadListingRulePrices(client, {
      vendorId: VENDOR_ID, storeConnectionId: STORE_ID, candidates: [size] })).get(size.productVariantId) ?? null,
    loadProductCost: vi.fn(async () => null), loadReplay: vi.fn(async () => null), save: vi.fn(),
  } as unknown as ListingPriceTransaction;
  const service = new DropshipListingPriceService({ repository: { execute: async (_request, operation) => operation(tx) },
    clock: { now: () => new Date("2026-10-06T12:00:00.000Z") }, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } });
  return service.getForMember("member-1", { storeConnectionId: STORE_ID, productVariantId: candidate.productVariantId });
}

/** The .ops cost source reads tables outside dropship; every loader's cost read answers from the golden costs. */
function mockGoldenCosts() {
  const loadProductCosts = vi.fn(async () => costsFor(GOLDEN_RULE_PRICE_CASES));
  const forTransaction = vi.spyOn(PgShellzClubProductCostAdapter, "forTransaction")
    .mockReturnValue({ loadProductCosts } as unknown as PgShellzClubProductCostAdapter);
  return { loadProductCosts, forTransaction };
}

afterEach(() => vi.restoreAllMocks());

describe("golden rule prices", () => {
  it("has one pinned result per case, on a profile shaped like a stored one", () => {
    expect(GOLDEN_RULE_PRICES.map((row) => row.productVariantId))
      .toEqual(GOLDEN_RULE_PRICE_CASES.map((row) => row.candidate.productVariantId));
    // The hash serializes the state, so the fixture must keep the stored key order.
    expect(JSON.stringify(pricingProfileStateSchema.parse(JSON.parse(JSON.stringify(GOLDEN_RULE_PROFILE_STATE)))))
      .toBe(JSON.stringify(GOLDEN_RULE_PROFILE_STATE));
  });

  it.each(cases)("the evidence recipe gives the pinned hash: %s", (_name, row, golden) => {
    expect(legacyEvidenceHash(GOLDEN_RULE_PROFILE_STATE, row, golden)).toBe(golden.evidenceHash);
  });

  it.each(cases)("the shared resolver keeps the pinned price and evidence: %s", (_name, row, golden) => {
    const price = goldenResolver().price(row.candidate, row.cost);
    expect(pinnedFields(price, row.candidate.productVariantId)).toEqual(golden);
    expect(price.productCost).toBe(row.cost);
  });

  it("gives every size of a batch the same price and evidence as resolving it alone", () => {
    const batch = goldenResolver();
    const together = GOLDEN_RULE_PRICE_CASES.map((row) => batch.price(row.candidate, row.cost));
    // Twice through the same resolver: the hash prefix it reuses is never consumed.
    const again = GOLDEN_RULE_PRICE_CASES.map((row) => batch.price(row.candidate, row.cost));
    expect(together.map((price) => price.evidenceHash)).toEqual(GOLDEN_RULE_PRICES.map((row) => row.evidenceHash));
    expect(again).toEqual(together);
  });

  it.each(cases)("the price at a given .ops cost matches the pinned price: %s", (_name, row, golden) => {
    const costCents = row.cost?.status === "available" ? row.cost.unitCostCents : null;
    expect(goldenResolver().priceAtCost(row.candidate, costCents)).toEqual({
      priceCents: golden.priceCents, ruleName: golden.ruleName, ruleId: golden.ruleId, issue: golden.issue, basis: golden.basis });
  });

  it("says a store without a pricing profile or product and category prices covers no size, and still prices nothing", () => {
    const resolver = createRulePriceResolver(rulePriceContextOf({ revisionId: null, profile: null, updatedAt: null }, EMPTY_LISTING_SETTING_LAYERS));
    const golden = goldenResolver();
    for (const { candidate } of GOLDEN_RULE_PRICE_CASES) {
      expect(resolver.covers(candidate)).toBe(false);
      expect(golden.covers(candidate)).toBe(true);
    }
    const row = GOLDEN_RULE_PRICE_CASES[0];
    expect(resolver.priceAtCost(row.candidate, 809)).toEqual({ priceCents: null, ruleName: null, ruleId: null,
      issue: "pricing_rules_not_configured", basis: null });
  });
});

describe("every price path gives the golden rule prices", () => {

  it("listing preview and queue: the shared loader reads the profile, then every cost in one read", async () => {
    const loadProductCosts = vi.fn(async () => costsFor(GOLDEN_RULE_PRICE_CASES));
    const forTransaction = vi.spyOn(PgShellzClubProductCostAdapter, "forTransaction")
      .mockReturnValue({ loadProductCosts } as unknown as PgShellzClubProductCostAdapter);
    const { query, client } = fakeClient(profileRow);

    const prices = await loadListingRulePrices(client, { vendorId: VENDOR_ID, storeConnectionId: STORE_ID,
      candidates: GOLDEN_RULE_PRICE_CASES.map((row) => row.candidate) });

    for (const [, row, golden] of cases) {
      expect(pinnedFields(prices.get(row.candidate.productVariantId)!, row.candidate.productVariantId)).toEqual(golden);
    }
    // The profile, then the products' listing settings. No size has a Card
    // Shellz category, so the category read is skipped.
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0][1]).toEqual([STORE_ID, VENDOR_ID]);
    expect(query.mock.calls[1][0]).toMatch(/FROM dropship\.dropship_product_listing_settings s/);
    expect(query.mock.calls[1][1]).toEqual([VENDOR_ID, STORE_ID,
      [...new Set(GOLDEN_RULE_PRICE_CASES.map((row) => row.candidate.productId))].sort((a, b) => a - b)]);
    expect(forTransaction).toHaveBeenCalledWith(client);
    expect(loadProductCosts).toHaveBeenCalledTimes(1);
    expect(loadProductCosts).toHaveBeenCalledWith({ vendorId: VENDOR_ID,
      productVariantIds: GOLDEN_RULE_PRICE_CASES.map((row) => row.candidate.productVariantId) });
  });

  it("per-size price: the same loader for one size gives that size's golden price", async () => {
    const row = GOLDEN_RULE_PRICE_CASES[3];
    const loadProductCosts = vi.fn(async () => costsFor([row]));
    vi.spyOn(PgShellzClubProductCostAdapter, "forTransaction")
      .mockReturnValue({ loadProductCosts } as unknown as PgShellzClubProductCostAdapter);

    const prices = await loadListingRulePrices(fakeClient(profileRow).client, { vendorId: VENDOR_ID, storeConnectionId: STORE_ID,
      candidates: [row.candidate] });

    expect(pinnedFields(prices.get(row.candidate.productVariantId)!, row.candidate.productVariantId)).toEqual(GOLDEN_RULE_PRICES[3]);
    expect(loadProductCosts).toHaveBeenCalledWith({ vendorId: VENDOR_ID, productVariantIds: [row.candidate.productVariantId] });
  });

  it("a store without rules gets no rule prices, and no cost is read for them", async () => {
    const forTransaction = vi.spyOn(PgShellzClubProductCostAdapter, "forTransaction");
    const prices = await loadListingRulePrices(fakeClient(null).client, { vendorId: VENDOR_ID, storeConnectionId: STORE_ID,
      candidates: GOLDEN_RULE_PRICE_CASES.map((row) => row.candidate) });
    expect(prices.size).toBe(0);
    expect(forTransaction).not.toHaveBeenCalled();
  });

  it("pricing review: new prices and row evidence are what the code before the shared resolver gave", async () => {
    // The same rules proposed again: every new price is the golden one.
    const rows = await goldenReview(EMPTY_LISTING_SETTING_LAYERS);
    // A proposed profile is not stored yet, so it has no updated time.
    const proposed: PricingProfileState = { revisionId: GOLDEN_RULE_PROFILE_STATE.revisionId,
      profile: GOLDEN_RULE_PROFILE_STATE.profile, updatedAt: null };
    for (const [, row, golden] of cases) {
      const reviewRow = rows.get(row.candidate.productVariantId)!;
      expect(reviewRow).toMatchObject({ priceCents: golden.priceCents, ruleName: golden.ruleName, basis: golden.basis,
        preserved: false });
      if (golden.issue) expect(reviewRow.issues).toContain(golden.issue);
      expect(reviewRow.evidenceHash).toBe(pricingHash({ rule: legacyEvidenceHash(proposed, row, golden),
        oldRule: golden.evidenceHash, setting: null, existing: null, guardrails: [] }));
    }
  });

  it.each(cases.filter(([, row]) => row.cost?.status === "available"))(
    "cost-change classifier: a rule-priced listing resolves to the golden price at that cost: %s",
    (_name, row, golden) => {
      const facts: CostActionVendorFacts = {
        listings: [], profiles: new Map([[STORE_ID, GOLDEN_RULE_PROFILE_STATE]]), layersByStore: new Map(),
        savedPrices: [{ storeConnectionId: STORE_ID, productVariantId: row.candidate.productVariantId, overridePriceCents: null, pricingMode: "rules" }],
        candidates: new Map([[row.candidate.productVariantId, row.candidate]]), pricingPolicies: [],
      };
      const listing = { listingId: 1, storeConnectionId: STORE_ID, productVariantId: row.candidate.productVariantId,
        status: "active", externalListingId: null, vendorRetailPriceCents: null, publishedPriceCents: null, platform: "ebay", variantSku: null, variantName: "Size", productName: row.name };

      const classification = classifyListing(facts, listing, row.cost!.unitCostCents!);

      expect(classification.priceCents).toBe(golden.priceCents);
      if (golden.priceCents !== null) expect(classification.followsCost).toBe(golden.basis === "product_cost");
    },
  );

  it.each(cases.filter(([, row]) => row.cost?.status === "available"))(
    "cost-change classifier: an inherit listing takes the golden price when the rules give one, else retail (L1): %s",
    (_name, row, golden) => {
      const classify = (pricingMode: "rules" | "inherit") => classifyListing({
        listings: [], profiles: new Map([[STORE_ID, GOLDEN_RULE_PROFILE_STATE]]), layersByStore: new Map(),
        savedPrices: [{ storeConnectionId: STORE_ID, productVariantId: row.candidate.productVariantId, overridePriceCents: null, pricingMode }],
        candidates: new Map([[row.candidate.productVariantId, row.candidate]]), pricingPolicies: [],
      }, { listingId: 1, storeConnectionId: STORE_ID, productVariantId: row.candidate.productVariantId, status: "active",
        // An earlier push saved this price; inherit never falls back to it.
        externalListingId: null, vendorRetailPriceCents: 4_321, publishedPriceCents: null, platform: "ebay", variantSku: null, variantName: "Size", productName: row.name }, row.cost!.unitCostCents!);

      const inherit = classify("inherit");
      if (golden.priceCents !== null) {
        expect(inherit).toEqual(classify("rules"));
        expect(inherit).toMatchObject({ priceCents: golden.priceCents, followsCost: golden.basis === "product_cost" });
        return;
      }
      const retail = row.candidate.defaultRetailPriceCents;
      const retailUsable = retail !== null && retail > 0 && retail <= MAX_LISTING_PRICE_CENTS;
      expect(inherit).toEqual(retailUsable ? { source: "catalog_default", priceCents: retail, followsCost: false }
        : { source: "unavailable", priceCents: null, followsCost: false });
    },
  );

  it("cost-change classifier: with no profile, inherit is the catalog retail price, not the price an earlier push saved", () => {
    const [, row] = cases[0];
    const classification = classifyListing({
      listings: [], profiles: new Map(), layersByStore: new Map(),
      savedPrices: [{ storeConnectionId: STORE_ID, productVariantId: row.candidate.productVariantId, overridePriceCents: null, pricingMode: "inherit" }],
      candidates: new Map([[row.candidate.productVariantId, row.candidate]]), pricingPolicies: [],
    }, { listingId: 1, storeConnectionId: STORE_ID, productVariantId: row.candidate.productVariantId, status: "active",
      externalListingId: null, vendorRetailPriceCents: 4_321, publishedPriceCents: null, platform: "ebay", variantSku: null, variantName: "Size", productName: row.name }, 809);
    expect(classification).toEqual({ source: "catalog_default", priceCents: row.candidate.defaultRetailPriceCents, followsCost: false });
  });

  it("listing preview and queue: a product's own price prices its sizes in a store with no rules, and only their costs are read", async () => {
    const loadProductCosts = vi.fn(async () => costsFor(GOLDEN_RULE_PRICE_CASES));
    vi.spyOn(PgShellzClubProductCostAdapter, "forTransaction")
      .mockReturnValue({ loadProductCosts } as unknown as PgShellzClubProductCostAdapter);
    const { query, client } = fakeClient(null, { products: [storedProductRow(700, GOLDEN_PRODUCT_RECIPE)] });

    const prices = await loadListingRulePrices(client, { vendorId: VENDOR_ID, storeConnectionId: STORE_ID,
      candidates: GOLDEN_RULE_PRICE_CASES.map((row) => row.candidate) });

    // Product 700 has two sizes: its .ops cost is unknown for one and was never read for the other.
    expect([...prices.keys()]).toEqual([7001, 7002]);
    expect(loadProductCosts).toHaveBeenCalledWith({ vendorId: VENDOR_ID, productVariantIds: [7001, 7002] });
    for (const price of prices.values()) {
      expect(price).toMatchObject({ priceCents: null, ruleName: PRODUCT_PRICE_RULE_NAME, ruleId: "product:700", ruleLevel: "product",
        issue: "pricing_basis_unavailable", basis: "product_cost", profileRevisionId: null });
    }
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("listing preview: the loader uses the layers it is given and reads none itself", async () => {
    const loadProductCosts = vi.fn(async () => costsFor(GOLDEN_RULE_PRICE_CASES));
    vi.spyOn(PgShellzClubProductCostAdapter, "forTransaction")
      .mockReturnValue({ loadProductCosts } as unknown as PgShellzClubProductCostAdapter);
    const { query, client } = fakeClient(profileRow);

    const prices = await loadListingRulePrices(client, { vendorId: VENDOR_ID, storeConnectionId: STORE_ID,
      candidates: GOLDEN_RULE_PRICE_CASES.map((row) => row.candidate), layers: EMPTY_LISTING_SETTING_LAYERS });

    for (const [, row, golden] of cases) {
      expect(pinnedFields(prices.get(row.candidate.productVariantId)!, row.candidate.productVariantId)).toEqual(golden);
    }
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("listing preview and queue: category settings are read only for sizes with a Card Shellz category", async () => {
    const candidate = GOLDEN_CATEGORIZED_CANDIDATE;
    mockGoldenCosts();
    const { query, client } = fakeClient(null, { categories: [storedCategoryRow(4, GOLDEN_CATEGORY_RECIPE)] });

    const prices = await loadListingRulePrices(client, { vendorId: VENDOR_ID, storeConnectionId: STORE_ID, candidates: [candidate] });

    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls[2][0]).toMatch(/FROM dropship\.dropship_category_listing_settings s/);
    expect(query.mock.calls[2][1]).toEqual([VENDOR_ID, STORE_ID, [4]]);
    // The catalog retail price, $9.99, rounded up to .99.
    expect(prices.get(candidate.productVariantId)).toMatchObject({ priceCents: 999, ruleName: CATEGORY_PRICE_RULE_NAME,
      ruleId: "category:4", ruleLevel: "category", basis: "catalog_retail" });
  });

  it("pricing review: a row names the level only for a product's own price, and the other rows are as before", async () => {
    const rows = await goldenReview(goldenLayers({ products: [[100, GOLDEN_PRODUCT_RECIPE]] }));
    // 809 x 1.3 + 25 = 1,076.7, rounded half-up.
    expect(rows.get(1001)).toMatchObject({ priceCents: 1_077, previousPriceCents: 1_077, ruleName: PRODUCT_PRICE_RULE_NAME,
      ruleLevel: "product", basis: "product_cost", basisCents: 809 });
    for (const [, row, golden] of cases.filter(([, row]) => row.candidate.productId !== 100)) {
      const reviewRow = rows.get(row.candidate.productVariantId)!;
      expect("ruleLevel" in reviewRow).toBe(false);
      expect(reviewRow).toMatchObject({ priceCents: golden.priceCents, ruleName: golden.ruleName });
    }
  });

  it("per-size price: a product's own price covers the size in a store with no rules, and the answer names its level", async () => {
    mockGoldenCosts();
    const [covered1001, uncovered2001] = catalogCandidates();
    const { client } = fakeClient(null, { products: [storedProductRow(100, GOLDEN_PRODUCT_RECIPE)] });

    const covered = await perSizePrice(covered1001, client);
    const uncovered = await perSizePrice(uncovered2001, client);

    expect(covered).toMatchObject({ pricingMode: "rules", source: "rules", effectivePriceCents: 1_077, rulePriceCents: 1_077,
      ruleName: PRODUCT_PRICE_RULE_NAME, ruleLevel: "product", rulesConfigured: true, ruleBasis: "product_cost", productCostCents: 809 });
    expect(uncovered).toMatchObject({ pricingMode: "catalog_default", source: "catalog_default", ruleName: null, rulesConfigured: false });
    expect("ruleLevel" in uncovered).toBe(false);
  });
});

describe("the price-change builder gives the golden rule prices (plan PR 9, 6.4, C-money-6)", () => {
  /** The facts' inputs for the golden sizes with the golden profile and costs, nothing saved and no settings. */
  function goldenFactsInputs(candidates: DropshipListingCatalogCandidate[]): ListingSettingsInputs {
    const ebayCategories = prepareEbayCategoryRules(null, null, EMPTY_LISTING_SETTING_LAYERS);
    return {
      store: { vendorId: VENDOR_ID, vendorStatus: "active", entitlementStatus: "active", storeConnectionId: STORE_ID,
        storeStatus: "connected", setupStatus: "ready", platform: "ebay", storeLaunchReady: true },
      candidates, sizesTotalByProductId: candidates.reduce((counts, row) => counts.set(row.productId, (counts.get(row.productId) ?? 0) + 1),
        new Map<number, number>()),
      savedPrices: new Map(), existingListings: new Map(), pricing: GOLDEN_RULE_PROFILE_STATE,
      costs: costsFor(GOLDEN_RULE_PRICE_CASES), pricingPolicies: [], listingConfig: null, policyOverrides: new Map(), shelfAssignments: new Map(),
      ebayCategoryRules: { revisionId: null, profile: null, updatedAt: null },
      ebayCategories: new Map(candidates.map((row) => [row.productVariantId, resolveEbayListingCategory(row, ebayCategories)])),
      content: { revisionId: null, profile: null, updatedAt: null }, contentSettings: new Map(), pausedSince: new Map(),
      layers: EMPTY_LISTING_SETTING_LAYERS, categoryNames: GOLDEN_CATEGORY_NAMES,
      // No category marks: no product is moved (plan PR 9, 10.1).
      categoryMoves: { marks: new Map(), fromCategories: new Map(), fromCategoryNames: new Map() },
    };
  }

  it("for unchanged inputs, before and after equal the facts' price, the golden price and W9's answer, for every golden size", async () => {
    mockGoldenCosts();
    const candidates = catalogCandidates();
    const facts = new Map(buildListingSettingsFacts(goldenFactsInputs(candidates)).sizes.map((size) => [size.price.productVariantId, size.price]));
    const context = rulePriceContextOf(GOLDEN_RULE_PROFILE_STATE, EMPTY_LISTING_SETTING_LAYERS);
    const costs = costsFor(GOLDEN_RULE_PRICE_CASES);

    const changes = buildListingPriceChanges({ before: context, after: context, policies: [], typedInRequest: new Map(),
      sizes: candidates.map((candidate) => ({ candidate, saved: null, existingListingPriceCents: null,
        cost: costs.get(candidate.productVariantId) ?? null })) });

    for (const [index, [, row, golden]] of cases.entries()) {
      const change = changes[index];
      expect(change.productVariantId).toBe(row.candidate.productVariantId);
      const w9 = await perSizePrice(candidates[index], fakeClient(profileRow).client);
      // A size the rules give no price falls to what W9 and the facts give it (no saved setting: the rules own it).
      expect(change.before.priceCents).toBe(facts.get(row.candidate.productVariantId)!.priceCents);
      expect(change.before.priceCents).toBe(w9.effectivePriceCents);
      expect(change.before.priceCents).toBe(golden.priceCents);
      expect(change.after).toEqual({ ...change.before, typed: false });
      expect(change.refusal).toBeNull();
    }
  });
});

describe("product and category prices (recipe version 2)", () => {
  const caseFor = (productVariantId: number) => GOLDEN_RULE_PRICE_CASES.find((row) => row.candidate.productVariantId === productVariantId)!;
  const pinFor = (productVariantId: number) => GOLDEN_RULE_PRICES.find((row) => row.productVariantId === productVariantId)!;
  const resolverWith = (state: PricingProfileState, layers: ListingSettingLayers) => createRulePriceResolver(rulePriceContextOf(state, layers));

  it("prices a size by its product's own price in a store with no pricing profile, with recipe version 2 evidence", () => {
    const row = caseFor(1001);
    const resolver = resolverWith(NO_PRICING_PROFILE_STATE, goldenLayers({ products: [[100, GOLDEN_PRODUCT_RECIPE]] }));

    expect(resolver.covers(row.candidate)).toBe(true);
    expect(resolver.covers(caseFor(2001).candidate)).toBe(false);
    const price = resolver.price(row.candidate, row.cost);
    expect(price).toMatchObject({ priceCents: 1_077, ruleName: PRODUCT_PRICE_RULE_NAME, ruleId: "product:100", ruleLevel: "product",
      issue: null, basis: "product_cost", profileRevisionId: null });
    expect(price.evidenceHash).toBe(v2EvidenceHash(row.candidate, row.cost, price, GOLDEN_PRODUCT_RECIPE));
    // The recipe's key order is the hash's, whatever order the stored recipe has.
    const reordered = { rounding: "cent", flatCents: 25, markupBps: 3_000, basis: "product_cost" } as PricingRecipe;
    expect(resolverWith(NO_PRICING_PROFILE_STATE, goldenLayers({ products: [[100, reordered]] })).price(row.candidate, row.cost).evidenceHash)
      .toBe(price.evidenceHash);
  });

  it("a product's own price beats a hand-picked group, a product group and a tie", () => {
    const resolver = resolverWith(GOLDEN_RULE_PROFILE_STATE, goldenLayers({ products: [[300, GOLDEN_PRODUCT_RECIPE], [600, GOLDEN_PRODUCT_RECIPE]] }));
    // 455 x 1.3 + 25 = 616.5 and 1,000 x 1.3 + 25 = 1,325, rounded half-up.
    for (const [productVariantId, priceCents, ruleId] of [[5001, 617, "product:300"], [3002, 617, "product:300"], [6001, 1_325, "product:600"]] as const) {
      const row = caseFor(productVariantId);
      const price = resolver.price(row.candidate, row.cost);
      expect(price).toMatchObject({ priceCents, ruleName: PRODUCT_PRICE_RULE_NAME, ruleId, ruleLevel: "product", issue: null });
      expect(price.evidenceHash).toBe(v2EvidenceHash(row.candidate, row.cost, price, GOLDEN_PRODUCT_RECIPE));
    }
  });

  it("an older group rule and a tie come before the category price, which comes before the store default", () => {
    const resolver = resolverWith(GOLDEN_RULE_PROFILE_STATE, goldenLayers({ categories: [[4, GOLDEN_CATEGORY_RECIPE]] }));
    // A group rule and a tie keep their pinned result, evidence included: the category id is not in version 1.
    for (const productVariantId of [2001, 6001]) {
      const row = caseFor(productVariantId);
      expect(pinnedFields(resolver.price({ ...row.candidate, categoryId: 4 }, row.cost), productVariantId)).toEqual(pinFor(productVariantId));
    }
    const row = caseFor(1001);
    const candidate = { ...row.candidate, categoryId: 4 };
    const price = resolver.price(candidate, row.cost);
    expect(price).toMatchObject({ priceCents: 999, ruleName: CATEGORY_PRICE_RULE_NAME, ruleId: "category:4", ruleLevel: "category",
      basis: "catalog_retail", profileRevisionId: GOLDEN_RULE_PROFILE_STATE.revisionId });
    expect(price.evidenceHash).toBe(v2EvidenceHash(candidate, row.cost, price, GOLDEN_CATEGORY_RECIPE));
  });

  it("a size whose product has no Card Shellz category never takes a category's price", () => {
    const layers = goldenLayers({ categories: [[4, GOLDEN_CATEGORY_RECIPE]] });
    const noProfile = resolverWith(NO_PRICING_PROFILE_STATE, layers);
    const golden = resolverWith(GOLDEN_RULE_PROFILE_STATE, layers);
    for (const [, row, pin] of cases) {
      expect(noProfile.covers(row.candidate)).toBe(false);
      expect(pinnedFields(golden.price(row.candidate, row.cost), row.candidate.productVariantId)).toEqual(pin);
    }
  });

  it("another product's or category's price leaves every pinned price and its evidence alone", () => {
    const resolver = resolverWith(GOLDEN_RULE_PROFILE_STATE,
      goldenLayers({ products: [[999, GOLDEN_PRODUCT_RECIPE]], categories: [[77, GOLDEN_CATEGORY_RECIPE]] }));
    for (const [, row, pin] of cases) {
      expect(pinnedFields(resolver.price(row.candidate, row.cost), row.candidate.productVariantId)).toEqual(pin);
      expect("ruleLevel" in resolver.priceAtCost(row.candidate, 809)).toBe(false);
    }
  });

  it("moving a product to another category with the same price changes its evidence", () => {
    const row = caseFor(1001);
    const resolver = resolverWith(NO_PRICING_PROFILE_STATE,
      goldenLayers({ categories: [[4, GOLDEN_CATEGORY_RECIPE], [5, GOLDEN_CATEGORY_RECIPE]] }));
    const before = resolver.price({ ...row.candidate, categoryId: 4 }, row.cost);
    const after = resolver.price({ ...row.candidate, categoryId: 5 }, row.cost);
    expect(after.priceCents).toBe(before.priceCents);
    expect(after.ruleId).toBe("category:5");
    expect(after.evidenceHash).not.toBe(before.evidenceHash);
  });
});

// ---------------------------------------------------------------------------
// Pinned product and category prices (plan 4.11, sub-part 8b-G). Each case
// is written out in the fixture; the paths below must all give its one price
// and source, from the same stored rows.
// ---------------------------------------------------------------------------

const v2Cases = GOLDEN_RULE_PRICE_V2_CASES.map((row, index) => [row.name, row, GOLDEN_RULE_PRICES_V2[index]] as const);
/** The cases with a price: every path prices them the same. */
const pricedV2Cases = v2Cases.filter(([, , pin]) => pin.priceCents !== null);
/** The cases with no price (a tie): no path prices them, on the category's price or any other. */
const unpricedV2Cases = v2Cases.filter(([, , pin]) => pin.priceCents === null);
/** The saved price setting of the `inherit` case: its revision and when it was saved. */
const V2_SAVED_REVISION_ID = 77;
const V2_SAVED_AT = "2026-10-05T10:00:00.000Z";

/** The golden size a v2 case prices, in the case's Card Shellz category. */
function v2Size(input: GoldenRulePriceV2Case) {
  const row = GOLDEN_RULE_PRICE_CASES.find((entry) => entry.candidate.productVariantId === input.productVariantId);
  if (!row) throw new Error(`No golden size ${input.productVariantId}.`);
  return { row, candidate: { ...row.candidate, categoryId: input.categoryId }, catalog: catalogCandidate(row, input.categoryId),
    cost: row.cost };
}
function v2State(input: GoldenRulePriceV2Case): PricingProfileState {
  return input.pricingProfile === "golden" ? GOLDEN_RULE_PROFILE_STATE : NO_PRICING_PROFILE_STATE;
}
function v2Layers(input: GoldenRulePriceV2Case): ListingSettingLayers {
  return goldenLayers({ products: input.products, categories: input.categories });
}
function v2Client(input: GoldenRulePriceV2Case) {
  return fakeClient(input.pricingProfile === "golden" ? profileRow : null, {
    products: input.products.map(([productId, price]) => storedProductRow(productId, price)),
    categories: input.categories.map(([categoryId, price]) => storedCategoryRow(categoryId, price)),
  });
}
function v2Saved(input: GoldenRulePriceV2Case): SavedListingPriceRevision | null {
  return input.savedPricingMode === null ? null : { productVariantId: input.productVariantId, revisionId: V2_SAVED_REVISION_ID,
    overridePriceCents: null, pricingMode: input.savedPricingMode, updatedAt: V2_SAVED_AT };
}
/** The cost-change classifier's facts for a case's store, as loadVendorFacts reads them: a profile only when the store has one. */
function v2CostActionFacts(input: GoldenRulePriceV2Case): CostActionVendorFacts {
  const { candidate } = v2Size(input);
  const state = v2State(input);
  return {
    listings: [], profiles: state.profile ? new Map([[STORE_ID, state]]) : new Map(),
    layersByStore: new Map([[STORE_ID, v2Layers(input)]]),
    savedPrices: input.savedPricingMode === null ? [] : [{ storeConnectionId: STORE_ID, productVariantId: candidate.productVariantId,
      overridePriceCents: null, pricingMode: input.savedPricingMode }],
    candidates: new Map([[candidate.productVariantId, candidate]]), pricingPolicies: [],
  };
}
/** The case's size as a live listing the cost-change classifier judges. */
function v2Listing(input: GoldenRulePriceV2Case) {
  return { listingId: 1, storeConnectionId: STORE_ID, productVariantId: input.productVariantId,
    // An earlier push saved this price; the rules own the listing, so it is never used.
    status: "active", externalListingId: null, vendorRetailPriceCents: 4_321, publishedPriceCents: null, platform: "ebay", variantSku: null, variantName: "Size", productName: input.name };
}
/** The listing-settings facts inputs for a case's size alone, with the case's layers and nothing else saved. */
function v2SettingsInputs(input: GoldenRulePriceV2Case): ListingSettingsInputs {
  const { catalog, cost } = v2Size(input);
  const layers = v2Layers(input);
  const saved = v2Saved(input);
  const ebayCategories = prepareEbayCategoryRules(null, null, layers);
  return {
    store: { vendorId: VENDOR_ID, vendorStatus: "active", entitlementStatus: "active", storeConnectionId: STORE_ID,
      storeStatus: "connected", setupStatus: "ready", platform: "ebay", storeLaunchReady: true },
    candidates: [catalog], sizesTotalByProductId: new Map([[catalog.productId, 1]]),
    savedPrices: new Map(saved ? [[saved.productVariantId, saved]] : []), existingListings: new Map(),
    pricing: v2State(input), costs: new Map(cost ? [[catalog.productVariantId, cost]] : []), pricingPolicies: [],
    listingConfig: null, policyOverrides: new Map(), shelfAssignments: new Map(),
    ebayCategoryRules: { revisionId: null, profile: null, updatedAt: null },
    ebayCategories: new Map([[catalog.productVariantId, resolveEbayListingCategory(catalog, ebayCategories)]]),
    content: { revisionId: null, profile: null, updatedAt: null }, contentSettings: new Map(), pausedSince: new Map(),
    layers, categoryNames: GOLDEN_CATEGORY_NAMES,
    // No category marks: no product is moved (plan PR 9, 10.1).
    categoryMoves: { marks: new Map(), fromCategories: new Map(), fromCategoryNames: new Map() },
  };
}
/** A rule price's pinned fields, `ruleLevel` null when it is absent (the resolver test also pins that the key is absent). */
function pinnedV2Fields(price: ListingRulePrice, productVariantId: number): GoldenRulePriceV2 {
  return { ...pinnedFields(price, productVariantId), ruleLevel: price.ruleLevel ?? null };
}
/** The recipe that priced a pinned case: the product's, the category's, or the golden profile's group. */
function winningRecipe(input: GoldenRulePriceV2Case, pin: GoldenRulePriceV2): PricingRecipe {
  if (pin.ruleLevel === "product") return input.products.find(([productId]) => productId === v2Size(input).row.candidate.productId)![1];
  if (pin.ruleLevel === "category") return input.categories.find(([categoryId]) => categoryId === input.categoryId)![1];
  const group = GOLDEN_RULE_PROFILE_STATE.profile!.groups.find((entry) => entry.id === pin.ruleId);
  return group ? group.recipe : GOLDEN_RULE_PROFILE_STATE.profile!.defaultRecipe;
}

/** A later save's time, and the values it changes: every non-price value a product and a category both hold. */
const RESAVED_AT = "2026-10-09T08:00:00.000Z";
const RESAVED_VALUES: Pick<CategoryListingSettingValues, "ebayCategory" | "storeShelf" | "shippingPolicy" | "textBelow"> = {
  ebayCategory: { categoryId: "900500", categoryName: "Card supplies", path: ["Collectibles", "Card supplies"] },
  storeShelf: { mode: "own", shelves: [{ id: "9", name: "X" }] },
  shippingPolicy: { id: "ship-9", name: null },
  textBelow: { mode: "own", text: "Ships the same day." },
};
/** A product's or category's row saved again with the same price: a new revision, later, with other non-price values. */
function resaved<T extends ProductListingSettingRow | CategoryListingSettingRow>(row: T): T {
  return { ...row, revisionId: row.revisionId + 1, updatedAt: RESAVED_AT, values: { ...row.values, ...RESAVED_VALUES } };
}

/** Recipe version 2 written out in full (plan D14): no profile, the winning recipe, the category id. */
function v2EvidenceHash(candidate: RulePriceCandidate, cost: DropshipProductCost | null,
  price: Pick<ListingRulePrice, "priceCents" | "ruleName" | "ruleId" | "issue">, recipe: PricingRecipe): string {
  return pricingHash({ v: 2, productVariantId: candidate.productVariantId, productId: candidate.productId,
    categoryId: candidate.categoryId, catalogRetailCents: candidate.defaultRetailPriceCents, cost,
    price: { priceCents: price.priceCents, ruleName: price.ruleName, ruleId: price.ruleId, issue: price.issue },
    recipe: { basis: recipe.basis, markupBps: recipe.markupBps, flatCents: recipe.flatCents, rounding: recipe.rounding } });
}

describe("pinned product and category prices (recipe version 2)", () => {
  it("has one pinned result per case, each size one of the golden sizes", () => {
    expect(GOLDEN_RULE_PRICES_V2.map((pin) => pin.productVariantId))
      .toEqual(GOLDEN_RULE_PRICE_V2_CASES.map((row) => row.productVariantId));
    for (const row of GOLDEN_RULE_PRICE_V2_CASES) expect(() => v2Size(row)).not.toThrow();
    // The facts name a category's value by its Card Shellz name, so every category with a price has one.
    for (const row of GOLDEN_RULE_PRICE_V2_CASES) {
      for (const [categoryId] of row.categories) expect(GOLDEN_CATEGORY_NAMES.has(categoryId)).toBe(true);
    }
  });

  it.each(v2Cases)("the evidence recipe gives the pinned hash: %s", (_name, row, pin) => {
    const { row: size, candidate, cost } = v2Size(row);
    const expected = pin.ruleLevel === null
      ? legacyEvidenceHash(v2State(row), size, pin)
      : v2EvidenceHash(candidate, cost, pin, winningRecipe(row, pin));
    expect(expected).toBe(pin.evidenceHash);
  });

  it.each(v2Cases)("the shared resolver gives the pinned price, level and evidence: %s", (_name, row, pin) => {
    const { candidate, cost } = v2Size(row);
    const resolver = createRulePriceResolver(rulePriceContextOf(v2State(row), v2Layers(row)));

    const price = resolver.price(candidate, cost);

    expect(pinnedV2Fields(price, candidate.productVariantId)).toEqual(pin);
    // The level is a key only for the new levels, so a store-rule result is byte-identical to before (plan D15).
    expect("ruleLevel" in price).toBe(pin.ruleLevel !== null);
    expect(resolver.covers(candidate)).toBe(true);
    const costCents = cost?.status === "available" ? cost.unitCostCents : null;
    expect(resolver.priceAtCost(candidate, costCents)).toEqual({ priceCents: pin.priceCents, ruleName: pin.ruleName,
      ruleId: pin.ruleId, issue: pin.issue, basis: pin.basis, ...(pin.ruleLevel ? { ruleLevel: pin.ruleLevel } : {}) });
  });

  it("a store default change leaves a product- or category-priced size's evidence alone (plan D14)", () => {
    const changed: PricingProfileState = { ...GOLDEN_RULE_PROFILE_STATE, revisionId: 42,
      profile: { ...GOLDEN_RULE_PROFILE_STATE.profile!, defaultRecipe: { basis: "catalog_retail", markupBps: 1_000, flatCents: 0, rounding: "cent" } } };
    for (const [, row, pin] of v2Cases.filter(([, , entry]) => entry.ruleLevel !== null)) {
      const { candidate, cost } = v2Size(row);
      const price = createRulePriceResolver(rulePriceContextOf(changed, v2Layers(row))).price(candidate, cost);
      expect(pinnedV2Fields(price, candidate.productVariantId)).toEqual({ ...pin, profileRevisionId: 42 });
    }
  });

  it.each(v2Cases.filter(([, , pin]) => pin.ruleLevel !== null))(
    "a save that changes only a non-price value leaves the evidence alone: the recipe is hashed, not the revision (plan D14): %s",
    async (_name, row, pin) => {
      const { candidate, cost } = v2Size(row);
      const products = row.products.map(([productId, price]) => resaved(goldenProductPriceRow(productId, price)));
      const categories = row.categories.map(([categoryId, price]) => resaved(goldenCategoryPriceRow(categoryId, price)));
      // The pins were made from revision 1 of each row.
      for (const entry of [...products, ...categories]) expect(entry.revisionId).toBe(2);
      const layers: ListingSettingLayers = { products: new Map(products.map((entry) => [entry.productId, entry])),
        categories: new Map(categories.map((entry) => [entry.categoryId, entry])) };

      const price = createRulePriceResolver(rulePriceContextOf(v2State(row), layers)).price(candidate, cost);
      expect(pinnedV2Fields(price, candidate.productVariantId)).toEqual(pin);

      // The same rows stored and read back, as the queue's re-check and W9 read them: revision 2, other shelf and all.
      mockGoldenCosts();
      const profile = row.pricingProfile === "golden" ? profileRow : null;
      const stored = { products: products.map(storedProductColumns), categories: categories.map(storedCategoryColumns) };
      const scope = { vendorId: VENDOR_ID, storeConnectionId: STORE_ID, candidates: [candidate] };
      await expect(readListingSettingLayers(fakeClient(profile, stored).client, scope)).resolves.toEqual({
        products: new Map([...layers.products].filter(([productId]) => productId === candidate.productId)),
        categories: new Map([...layers.categories].filter(([categoryId]) => categoryId === candidate.categoryId)),
      });
      const prices = await loadListingRulePrices(fakeClient(profile, stored).client, scope);
      expect(pinnedV2Fields(prices.get(candidate.productVariantId)!, candidate.productVariantId)).toEqual(pin);
    },
  );

  it("one product's price change leaves another product's evidence alone, and changes its own", () => {
    const [, row, pin] = v2Cases[0];
    const toploader = GOLDEN_RULE_PRICE_CASES[3];
    const withToploaderPrice = (markupBps: number) => createRulePriceResolver(rulePriceContextOf(v2State(row), goldenLayers({
      products: [...row.products, [300, { ...GOLDEN_PRODUCT_RECIPE, markupBps }]] })));
    const before = withToploaderPrice(3_000);
    const after = withToploaderPrice(6_000);
    const { candidate, cost } = v2Size(row);

    expect(pinnedV2Fields(before.price(candidate, cost), candidate.productVariantId)).toEqual(pin);
    expect(pinnedV2Fields(after.price(candidate, cost), candidate.productVariantId)).toEqual(pin);
    expect(after.price(toploader.candidate, toploader.cost).evidenceHash)
      .not.toBe(before.price(toploader.candidate, toploader.cost).evidenceHash);
  });

  it("pins a category move as a new rule id and new evidence at the same price, and a profile as no part of it", () => {
    const pinFor = (name: string) => v2Cases.find(([caseName]) => caseName === name)![2];
    const inCategory4 = pinFor("a category's price in a store with no pricing profile");
    const moved = pinFor("the product moved to another category with the same price");
    expect(moved).toMatchObject({ priceCents: inCategory4.priceCents, ruleId: "category:5" });
    expect(moved.evidenceHash).not.toBe(inCategory4.evidenceHash);
    expect(pinFor("a category's price beats the store default").evidenceHash).toBe(inCategory4.evidenceHash);
  });
});

describe("every price path gives the pinned product and category prices", () => {
  it.each(v2Cases)("listing queue: the loader reads the layers itself and gives the pinned price: %s", async (_name, row, pin) => {
    const { loadProductCosts } = mockGoldenCosts();
    const { candidate } = v2Size(row);
    const { query, client } = v2Client(row);

    // The queue's re-check (dropship-listing-preview.repository.ts): no layers given, read under its lock.
    const prices = await loadListingRulePrices(client, { vendorId: VENDOR_ID, storeConnectionId: STORE_ID, candidates: [candidate] });

    expect(pinnedV2Fields(prices.get(candidate.productVariantId)!, candidate.productVariantId)).toEqual(pin);
    // The profile, the product settings, and the category settings only for a size with a Card Shellz category.
    expect(query).toHaveBeenCalledTimes(candidate.categoryId === null ? 2 : 3);
    expect(loadProductCosts).toHaveBeenCalledWith({ vendorId: VENDOR_ID, productVariantIds: [candidate.productVariantId] });
  });

  it.each(v2Cases)("listing preview: the loader with the preview's layers gives the same pinned price: %s", async (_name, row, pin) => {
    mockGoldenCosts();
    const { candidate } = v2Size(row);
    const { query, client } = v2Client(row);

    const prices = await loadListingRulePrices(client, { vendorId: VENDOR_ID, storeConnectionId: STORE_ID, candidates: [candidate],
      layers: v2Layers(row) });

    expect(pinnedV2Fields(prices.get(candidate.productVariantId)!, candidate.productVariantId)).toEqual(pin);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it.each(pricedV2Cases)("per-size price (W9): the answer is the pinned price, by rule, with its level: %s", async (_name, row, pin) => {
    mockGoldenCosts();
    const { catalog } = v2Size(row);

    const answer = await perSizePrice(catalog, v2Client(row).client, v2Saved(row));

    expect(answer).toMatchObject({ pricingMode: row.savedPricingMode ?? "rules", source: "rules", effectivePriceCents: pin.priceCents,
      rulePriceCents: pin.priceCents, ruleName: pin.ruleName, ruleBasis: pin.basis, rulesConfigured: true, pricingIssue: null });
    expect(answer.ruleLevel ?? null).toBe(pin.ruleLevel);
    expect("ruleLevel" in answer).toBe(pin.ruleLevel !== null);
  });

  it.each(pricedV2Cases)("pricing review (W1): the current and the proposed price are the pinned one: %s", async (_name, row, pin) => {
    const { catalog } = v2Size(row);
    const saved = v2Saved(row);
    const rows = await goldenReview(v2Layers(row), { current: v2State(row), candidates: [catalog], saved: saved ? [saved] : [] });

    const reviewRow = rows.get(catalog.productVariantId)!;
    expect(reviewRow).toMatchObject({ previousPriceCents: pin.priceCents, priceCents: pin.priceCents, ruleName: pin.ruleName,
      basis: pin.basis, preserved: false, issues: [] });
    expect(reviewRow.ruleLevel ?? null).toBe(pin.ruleLevel);
    expect(reviewRow.followsStorePricing ?? false).toBe(row.savedPricingMode === "inherit");
  });

  it("pricing review (W1): the golden groups proposed to a store with no pricing profile are refused, and no review is stored (PR 12, D26)", async () => {
    // What this helper proposed before Listing settings PR 12: the full golden profile, its seven groups onto a store with none.
    const [, row] = pricedV2Cases.find(([, entry]) => entry.pricingProfile === "none")!;
    const { catalog } = v2Size(row);
    const { tx, review, stored } = goldenReviewRun(v2Layers(row), { current: NO_PRICING_PROFILE_STATE, candidates: [catalog] });

    const error = await review(GOLDEN_RULE_PROFILE_STATE.profile!).then(() => null, (caught: unknown) => caught);

    expect(error).toMatchObject({ code: "DROPSHIP_LISTING_GROUP_RULES_CLOSED", context: { kind: "pricing",
      addedIds: GOLDEN_RULE_PROFILE_STATE.profile!.groups.map((group) => group.id), changedIds: [], classification: "permanent" } });
    expect(tx.storeReview).not.toHaveBeenCalled();
    expect(stored()).toBeNull();
    // Refused before the selection or the layers were read.
    expect(tx.loadRuleLayers).not.toHaveBeenCalled();
  });

  it.each(pricedV2Cases)("cost-change classifier: the listing is priced by the pinned rule at its cost: %s", (_name, row, pin) => {
    const { cost } = v2Size(row);

    const followsCost = pin.basis === "product_cost";
    expect(classifyListing(v2CostActionFacts(row), v2Listing(row), cost!.unitCostCents!)).toEqual({
      source: followsCost ? "rules_cost" : "rules_retail", priceCents: pin.priceCents, followsCost });
  });

  it.each(pricedV2Cases)("listing-settings facts: the size's price comes from the pinned rule, named by its level: %s", (_name, row, pin) => {
    const { catalog } = v2Size(row);

    const [size] = buildListingSettingsFacts(v2SettingsInputs(row)).sizes;

    const kind = pin.ruleLevel ?? (pin.ruleId === null ? "store_default" : "group");
    // A product is named by its Card Shellz name and a category by its current one (plan D15, D19).
    const name = kind === "product" ? catalog.productName : kind === "category" ? GOLDEN_CATEGORY_NAMES.get(row.categoryId!) : pin.ruleName;
    expect(size.price).toMatchObject({ priceCents: pin.priceCents, source: "rules", issue: null,
      rule: { kind, name, recipe: winningRecipe(row, pin) }, basis: pin.basis });
  });

  it.each(pricedV2Cases)(
    "price-change builder: setting the case's recipes on a store without them gives the facts' and W9's price after the save: %s",
    async (_name, row, pin) => {
      mockGoldenCosts();
      const { catalog, cost } = v2Size(row);
      const saved = v2Saved(row);
      const before = rulePriceContextOf(v2State(row), EMPTY_LISTING_SETTING_LAYERS);
      const after = withRecipes(before, { products: new Map(row.products), categories: new Map(row.categories) });

      const [change] = buildListingPriceChanges({ before, after, policies: [], typedInRequest: new Map(),
        sizes: [{ candidate: catalog, saved, existingListingPriceCents: null, cost }] });

      const [factsAfter] = buildListingSettingsFacts(v2SettingsInputs(row)).sizes;
      const w9After = await perSizePrice(catalog, v2Client(row).client, saved);
      expect(change.after.priceCents).toBe(pin.priceCents);
      expect(change.after.priceCents).toBe(factsAfter.price.priceCents);
      expect(change.after.priceCents).toBe(w9After.effectivePriceCents);
      expect(change.afterRule).toMatchObject({ priceCents: pin.priceCents, ruleId: pin.ruleId });
      // Before is the store without the case's recipes, as the facts read it.
      const [factsBefore] = buildListingSettingsFacts({ ...v2SettingsInputs(row), layers: EMPTY_LISTING_SETTING_LAYERS,
        ebayCategories: new Map([[catalog.productVariantId, resolveEbayListingCategory(catalog,
          prepareEbayCategoryRules(null, null, EMPTY_LISTING_SETTING_LAYERS))]]) }).sizes;
      expect(change.before.priceCents).toBe(factsBefore.price.priceCents);
    },
  );

  it.each(unpricedV2Cases)("no path prices a tie, and none falls through to the category's price: %s", async (_name, row, pin) => {
    mockGoldenCosts();
    const { catalog, cost } = v2Size(row);
    const saved = v2Saved(row);
    // The tie keeps today's pin: no price, no rule, no level.
    expect(pin).toMatchObject({ priceCents: null, ruleId: null, ruleLevel: null, issue: "pricing_rule_priority_conflict" });

    const answer = await perSizePrice(catalog, v2Client(row).client, saved);
    expect(answer).toMatchObject({ source: "unavailable", effectivePriceCents: null, rulePriceCents: null, ruleName: null,
      pricingIssue: pin.issue });
    expect("ruleLevel" in answer).toBe(false);

    const reviewRow = (await goldenReview(v2Layers(row), { current: v2State(row), candidates: [catalog], saved: saved ? [saved] : [] }))
      .get(catalog.productVariantId)!;
    expect(reviewRow).toMatchObject({ previousPriceCents: null, priceCents: null, ruleName: null });
    expect(reviewRow.issues).toContain(pin.issue);
    expect("ruleLevel" in reviewRow).toBe(false);

    expect(classifyListing(v2CostActionFacts(row), v2Listing(row), cost!.unitCostCents!))
      .toEqual({ source: "unavailable", priceCents: null, followsCost: false });

    const [size] = buildListingSettingsFacts(v2SettingsInputs(row)).sizes;
    expect(size.price).toMatchObject({ priceCents: null, source: "none", issue: pin.issue, rule: null });
  });
});
