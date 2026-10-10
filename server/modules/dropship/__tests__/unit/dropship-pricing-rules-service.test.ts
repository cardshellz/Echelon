import { beforeEach, describe, expect, it, vi } from "vitest";
import { DropshipPricingRulesService, type PricingRulesTransaction, type StoredPricingReview } from "../../application/dropship-pricing-rules-service";
import type { DropshipListingCatalogCandidate, DropshipListingPreviewRepository } from "../../application/dropship-listing-preview-service";
import type { DropshipProductCost } from "../../application/dropship-product-cost";
import { RETAIL_FALLBACK_RULE_NAME, type PricingProfileState } from "../../../../../shared/dropship/pricing-rules";
import type { SavedListingPriceRevision } from "../../../../../shared/dropship/listing-price";
import { pricingHash } from "../../application/dropship-rule-price";

const now = new Date("2026-09-07T12:00:00.000Z");
const reviewId = "02892196-a1f2-4e72-823a-32188b9cb234";
const profile = { defaultRecipe: { basis: "product_cost" as const, markupBps: 3000, flatCents: 100, rounding: "cent" as const }, groups: [] };
const input = { profile, expectedRevisionId: null, releaseFixedOverrides: false };
const cost: DropshipProductCost = { status: "available", unitCostCents: 809, planId: "ops-plan", source: "variant_fixed_price", overrideId: "cost-1", issue: null, retailPriceCents: null, discountBps: null };

describe("store pricing review and approval", () => {
  let tx: PricingRulesTransaction;
  let service: DropshipPricingRulesService;
  let candidates: DropshipListingCatalogCandidate[];
  let state: PricingProfileState;
  let stored: StoredPricingReview | null;
  let settings: SavedListingPriceRevision[];
  let currentCost: DropshipProductCost;
  beforeEach(() => {
    candidates = Array.from({ length: 1000 }, (_, index) => ({ productId: 7, productVariantId: index + 1,
      productName: "Mailers", variantName: `Pack ${index + 1}`, title: `Mailer ${index + 1}`, sku: `SKU-${index + 1}`,
      productLineIds: [2], category: "Mailers", productIsActive: true, variantIsActive: true, variantUomType: "pack",
      defaultRetailPriceCents: 899, unitsPerVariant: 50 } as DropshipListingCatalogCandidate));
    state = { profile: null, revisionId: null, updatedAt: null }; stored = null; settings = []; currentCost = cost;
    const catalog = {
      loadStoreContext: vi.fn(async () => ({ vendorId: 10, vendorStatus: "onboarding", entitlementStatus: "active", storeStatus: "needs_reauth" })),
      listCatalogExposureRules: vi.fn(async () => [{ id: 1, scopeType: "catalog", action: "include" }]),
      listSelectionRules: vi.fn(async () => [{ id: 2, scopeType: "catalog", action: "include", isActive: true }]),
      listCatalogCandidates: vi.fn(async (ids: number[]) => candidates.filter((row) => ids.includes(row.productVariantId))),
      listVariantOverrides: vi.fn(async () => []), listExistingListings: vi.fn(async () => []),
      listSavedListingPrices: vi.fn(async () => settings), listPricingPolicies: vi.fn(async () => []),
    } as unknown as DropshipListingPreviewRepository;
    tx = { vendorId: 10, catalog, costs: { loadProductCosts: vi.fn(async ({ productVariantIds }) => new Map(productVariantIds.map((id) => [id, currentCost]))) },
      listVariantIds: vi.fn(async (afterId, limit) => candidates.filter((row) => row.productVariantId > afterId).slice(0, limit).map((row) => row.productVariantId)),
      listProductLines: vi.fn(async () => [{ id: 2, name: "Mailing supplies" }]),
      loadProfile: vi.fn(async () => state), storeReview: vi.fn(async (review) => { stored = review; }),
      loadReview: vi.fn(async () => stored), findApplication: vi.fn(async () => null), applyReview: vi.fn(async () => 1) };
    service = new DropshipPricingRulesService({ repository: { execute: async (_member, _store, operation) => operation(tx) },
      clock: { now: () => now }, newId: () => reviewId, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } });
  });
  async function review() { return service.reviewForMember("member-1", 22, input); }
  async function apply() {
    const result = await review();
    return service.applyForMember("member-1", 22, { reviewId: result.reviewId, reviewHash: result.reviewHash, idempotencyKey: "apply-1" });
  }
  it("reviews all 1,000 selected listings and returns only a 50-row page", async () => {
    const result = await review();
    expect(result.summary).toEqual({ total: 1000, changed: 1000, preserved: 0, blocked: 0 });
    expect(result.rows).toHaveLength(50); expect(stored!.rows).toHaveLength(1000);
    expect(result.rows[0]).toMatchObject({ previousPriceCents: 899, priceCents: 1152, productCostCents: 809 });
    expect(tx.catalog.listCatalogCandidates).toHaveBeenCalledTimes(4);
    expect(tx.costs.loadProductCosts).toHaveBeenCalledTimes(1);
    const last = await service.reviewPageForMember("member-1", 22, reviewId, 19);
    expect(last.rows[49].productVariantId).toBe(1000);
    expect(tx.applyReview).not.toHaveBeenCalled();
  });
  it("preserves fixed overrides while explicitly adopting catalog-default settings", async () => {
    settings = [{ productVariantId: 1, revisionId: 7, overridePriceCents: 999, updatedAt: now.toISOString() },
      { productVariantId: 2, revisionId: 8, overridePriceCents: null, updatedAt: now.toISOString() }];
    const result = await review();
    expect(result.rows[0]).toMatchObject({ preserved: true, priceCents: 999 });
    expect(result.rows[1]).toMatchObject({ preserved: false, priceCents: 1152 });
    expect(result.summary.preserved).toBe(1);
  });
  it("replaces a price an earlier push saved on the listing; only a typed price is preserved", async () => {
    vi.mocked(tx.catalog.listExistingListings).mockResolvedValue([
      { productVariantId: 1, listingId: 1, vendorRetailPriceCents: 999, status: "live", quantityCap: null, externalListingId: null },
      { productVariantId: 2, listingId: 2, vendorRetailPriceCents: 999, status: "live", quantityCap: null, externalListingId: null },
    ]);
    settings = [{ productVariantId: 2, revisionId: 7, overridePriceCents: 1299, updatedAt: now.toISOString() }];
    const result = await review();
    expect(result.rows[0]).toMatchObject({ preserved: false, previousPriceCents: 999, priceCents: 1152, ruleName: "Store default rule" });
    expect(result.rows[1]).toMatchObject({ preserved: true, previousPriceCents: 1299, priceCents: 1299, ruleName: "Fixed override preserved" });
    expect(result.summary.preserved).toBe(1);
  });
  it("does not preserve an inherit setting, and takes its previous price from the shared resolver", async () => {
    vi.mocked(tx.catalog.listExistingListings).mockResolvedValue([
      { productVariantId: 1, listingId: 1, vendorRetailPriceCents: 999, status: "live", quantityCap: null, externalListingId: null },
    ]);
    settings = [{ productVariantId: 1, revisionId: 7, overridePriceCents: null, pricingMode: "inherit", updatedAt: now.toISOString() }];
    // No rules yet: the inherit size was on the retail price ($8.99), never the $9.99 an earlier push saved.
    const first = await review();
    expect(first.rows[0]).toMatchObject({ preserved: false, previousPriceCents: 899, priceCents: 1152, ruleName: "Store default rule",
      settingRevisionId: 7, followsStorePricing: true, basis: "product_cost" });
    expect(first.rows[1]).not.toHaveProperty("followsStorePricing");
    expect(first.summary.preserved).toBe(0);
    // With rules in force, its previous price is the current rule price.
    state = { profile: { ...profile, defaultRecipe: { ...profile.defaultRecipe, markupBps: 0, flatCents: 0 } }, revisionId: 3, updatedAt: now.toISOString() };
    const second = await service.reviewForMember("member-1", 22, { ...input, expectedRevisionId: 3 });
    expect(second.rows[0]).toMatchObject({ preserved: false, previousPriceCents: 809, priceCents: 1152 });
  });
  it("prices an inherit size the rules cannot price at retail, without blocking the apply", async () => {
    candidates = candidates.slice(0, 2);
    currentCost = { ...cost, status: "unavailable", unitCostCents: null, issue: "source_read_failed" };
    settings = [{ productVariantId: 1, revisionId: 7, overridePriceCents: null, pricingMode: "inherit", updatedAt: now.toISOString() }];
    const result = await review();
    expect(result.rows[0]).toMatchObject({ preserved: false, previousPriceCents: 899, priceCents: 899, issues: [],
      ruleName: "Retail price (no rule prices this size)", basis: "catalog_retail", basisCents: 899, followsStorePricing: true,
      retailFallbackIssue: "pricing_basis_unavailable" });
    // A size without the inherit setting still has no price and blocks.
    expect(result.rows[1]).toMatchObject({ priceCents: null, issues: ["pricing_basis_unavailable", "vendor_retail_price_required"] });
    expect(result.summary.blocked).toBe(1);
  });
  it("prices an inherit size at retail when a blocking Card Shellz limit refuses the new rule price, and applies (L1)", async () => {
    // The new rule price is $11.52, above a $10.00 blocking maximum; the $8.99 retail price is under it.
    candidates = candidates.slice(0, 1);
    vi.mocked(tx.catalog.listPricingPolicies).mockResolvedValue([{ id: 9, scopeType: "catalog", productLineId: null, productId: null,
      productVariantId: null, category: null, mode: "block_listing_push", floorPriceCents: null, ceilingPriceCents: 1000 }]);
    settings = [{ productVariantId: 1, revisionId: 7, overridePriceCents: null, pricingMode: "inherit", updatedAt: now.toISOString() }];
    const result = await review();
    expect(result.rows[0]).toMatchObject({ preserved: false, previousPriceCents: 899, priceCents: 899, issues: [], warnings: [],
      ruleName: RETAIL_FALLBACK_RULE_NAME, basis: "catalog_retail", basisCents: 899, followsStorePricing: true,
      retailFallbackIssue: "pricing_rule_outside_limit" });
    expect(result.summary.blocked).toBe(0);
    await expect(service.applyForMember("member-1", 22, { reviewId, reviewHash: result.reviewHash, idempotencyKey: "apply-1" }))
      .resolves.toMatchObject({ revisionId: 1, idempotentReplay: false });
    // Without the inherit setting, the same size takes the rule price and the limit blocks it.
    settings = [];
    const rules = await review();
    expect(rules.rows[0]).toMatchObject({ priceCents: 1152, issues: ["pricing:above_ceiling:policy_9"] });
    expect(rules.rows[0]).not.toHaveProperty("retailFallbackIssue");
  });
  it("keeps an inherit size blocked when the limit refuses the rule price and the retail price too", async () => {
    candidates = candidates.slice(0, 1);
    vi.mocked(tx.catalog.listPricingPolicies).mockResolvedValue([{ id: 9, scopeType: "catalog", productLineId: null, productId: null,
      productVariantId: null, category: null, mode: "block_listing_push", floorPriceCents: null, ceilingPriceCents: 800 }]);
    settings = [{ productVariantId: 1, revisionId: 7, overridePriceCents: null, pricingMode: "inherit", updatedAt: now.toISOString() }];
    const result = await review();
    expect(result.rows[0]).toMatchObject({ priceCents: 899, followsStorePricing: true, issues: ["pricing:above_ceiling:policy_9"] });
    await expect(service.applyForMember("member-1", 22, { reviewId, reviewHash: result.reviewHash, idempotencyKey: "apply-1" }))
      .rejects.toMatchObject({ code: "DROPSHIP_PRICING_REVIEW_BLOCKED" });
  });
  it("keeps an inherit size blocked when neither the rules nor a retail price can price it", async () => {
    candidates = [{ ...candidates[0], defaultRetailPriceCents: null }];
    currentCost = { ...cost, status: "unavailable", unitCostCents: null, issue: "source_read_failed" };
    settings = [{ productVariantId: 1, revisionId: 7, overridePriceCents: null, pricingMode: "inherit", updatedAt: now.toISOString() }];
    const result = await review();
    expect(result.rows[0]).toMatchObject({ priceCents: null, followsStorePricing: true,
      issues: ["pricing_basis_unavailable", "vendor_retail_price_required"] });
    await expect(service.applyForMember("member-1", 22, { reviewId, reviewHash: result.reviewHash, idempotencyKey: "apply-1" }))
      .rejects.toMatchObject({ code: "DROPSHIP_PRICING_REVIEW_BLOCKED" });
  });
  it("hands the apply the inherit marker so the size is not re-saved as rules-only", async () => {
    candidates = candidates.slice(0, 2);
    settings = [{ productVariantId: 1, revisionId: 7, overridePriceCents: null, pricingMode: "inherit", updatedAt: now.toISOString() }];
    await apply();
    const reviewed = vi.mocked(tx.applyReview).mock.calls[0][0];
    expect(reviewed.rows.map((row) => row.followsStorePricing ?? false)).toEqual([true, false]);
  });
  it("can explicitly release fixed overrides in the reviewed request", async () => {
    settings = [{ productVariantId: 1, revisionId: 7, overridePriceCents: 999, updatedAt: now.toISOString() }];
    const result = await service.reviewForMember("member-1", 22, { ...input, releaseFixedOverrides: true });
    expect(result.rows[0]).toMatchObject({ preserved: false, previousPriceCents: 999, priceCents: 1152 });
  });
  it("does not fabricate a price from a missing cost", async () => {
    currentCost = { ...cost, status: "unavailable", unitCostCents: null, issue: "source_read_failed" };
    const result = await review();
    expect(result.summary.blocked).toBe(1000); expect(result.rows[0].priceCents).toBeNull();
    await expect(service.applyForMember("member-1", 22, { reviewId, reviewHash: result.reviewHash, idempotencyKey: "apply-1" }))
      .rejects.toMatchObject({ code: "DROPSHIP_PRICING_REVIEW_BLOCKED" });
    expect(tx.applyReview).not.toHaveBeenCalled();
  });
  it.each(["cost", "setting", "population", "profile"])("rejects stale %s evidence before any application write", async (change) => {
    const result = await review();
    if (change === "cost") currentCost = { ...cost, unitCostCents: 810 };
    if (change === "setting") settings = [{ productVariantId: 1, revisionId: 9, overridePriceCents: 899, updatedAt: now.toISOString() }];
    if (change === "population") candidates = candidates.slice(1);
    if (change === "profile") state = { profile, revisionId: 1, updatedAt: now.toISOString() };
    await expect(service.applyForMember("member-1", 22, { reviewId, reviewHash: result.reviewHash, idempotencyKey: "apply-1" }))
      .rejects.toMatchObject({ code: "DROPSHIP_PRICING_REVIEW_STALE" });
    expect(tx.applyReview).not.toHaveBeenCalled();
  });
  it("applies only the immutable reviewed payload, with no publication dependency", async () => {
    expect(await apply()).toEqual({ revisionId: 1, idempotentReplay: false });
    expect(tx.applyReview).toHaveBeenCalledWith(stored, expect.objectContaining({ reviewId, idempotencyKey: "apply-1" }), now);
    expect(tx.applyReview).toHaveBeenCalledTimes(1);
  });
  it("replays a committed operation before rereading changed source data", async () => {
    vi.mocked(tx.findApplication).mockResolvedValue({ revisionId: 12 });
    expect(await service.applyForMember("member-1", 22, { reviewId, reviewHash: "a".repeat(64), idempotencyKey: "apply-1" }))
      .toEqual({ revisionId: 12, idempotentReplay: true });
    expect(tx.costs.loadProductCosts).not.toHaveBeenCalled(); expect(tx.applyReview).not.toHaveBeenCalled();
  });
  it("fails authorization before reading costs or catalog selections", async () => {
    vi.mocked(tx.catalog.loadStoreContext).mockResolvedValue(null);
    await expect(review()).rejects.toMatchObject({ code: "DROPSHIP_STORE_CONNECTION_REQUIRED" });
    expect(tx.listVariantIds).not.toHaveBeenCalled(); expect(tx.costs.loadProductCosts).not.toHaveBeenCalled();
  });
  it("says what each reviewed price is built from: the basis, its amount and the size", async () => {
    const result = await review();
    expect(result.rows[0]).toMatchObject({ sizeName: "Pack 1", basis: "product_cost", basisCents: 809,
      productCostCents: 809, priceCents: 1152, warnings: [] });
  });
  it("shows the reference retail amount a retail-based price is built from", async () => {
    const retail = { defaultRecipe: { basis: "catalog_retail" as const, markupBps: 2000, flatCents: 0, rounding: "cent" as const }, groups: [] };
    candidates[0] = { ...candidates[0], defaultRetailPriceCents: 1249 };
    const result = await service.reviewForMember("member-1", 22, { ...input, profile: retail });
    // 1249 x 1.2 = 1498.8, rounded half-up once: $14.99. The cost column still shows the .ops cost.
    expect(result.rows[0]).toMatchObject({ basis: "catalog_retail", basisCents: 1249, priceCents: 1499, productCostCents: 809 });
  });
  it("names a missing reference retail instead of inventing an amount", async () => {
    const retail = { defaultRecipe: { basis: "catalog_retail" as const, markupBps: 2000, flatCents: 0, rounding: "cent" as const }, groups: [] };
    candidates[0] = { ...candidates[0], defaultRetailPriceCents: null };
    const result = await service.reviewForMember("member-1", 22, { ...input, profile: retail });
    expect(result.rows[0]).toMatchObject({ basis: "catalog_retail", basisCents: null, priceCents: null,
      issues: expect.arrayContaining(["pricing_basis_unavailable"]) });
  });
  it("gives a kept fixed price no basis and no notes, since applying does not change it", async () => {
    settings = [{ productVariantId: 1, revisionId: 7, overridePriceCents: 999, updatedAt: now.toISOString() }];
    const result = await review();
    expect(result.rows[0]).toMatchObject({ preserved: true, priceCents: 999, basis: null, basisCents: null, warnings: [], issues: [] });
  });
  it("warns about a price below the .ops cost without blocking the apply", async () => {
    const retail = { defaultRecipe: { basis: "catalog_retail" as const, markupBps: 0, flatCents: 0, rounding: "cent" as const }, groups: [] };
    currentCost = { ...cost, unitCostCents: 950 };
    const result = await service.reviewForMember("member-1", 22, { ...input, profile: retail });
    expect(result.rows[0]).toMatchObject({ priceCents: 899, productCostCents: 950, warnings: ["price_below_product_cost"], issues: [] });
    expect(result.summary.blocked).toBe(0);
    expect(await service.applyForMember("member-1", 22, { reviewId: result.reviewId, reviewHash: result.reviewHash, idempotencyKey: "apply-1" }))
      .toEqual({ revisionId: 1, idempotentReplay: false });
  });
  it("reports a warn-only price limit as a warning and a blocking limit as an issue", async () => {
    const limit = { scopeType: "catalog" as const, productLineId: null, productId: null, productVariantId: null, category: null, floorPriceCents: null, ceilingPriceCents: 1000 };
    vi.mocked(tx.catalog.listPricingPolicies).mockResolvedValue([{ ...limit, id: 5, mode: "warn_only" }]);
    const warned = await review();
    expect(warned.rows[0]).toMatchObject({ priceCents: 1152, warnings: ["pricing:above_ceiling:policy_5"], issues: [] });
    expect(warned.summary.blocked).toBe(0);
    vi.mocked(tx.catalog.listPricingPolicies).mockResolvedValue([{ ...limit, id: 6, mode: "block_listing_push" }]);
    const blocked = await review();
    expect(blocked.rows[0]).toMatchObject({ warnings: [], issues: ["pricing:above_ceiling:policy_6"] });
  });
  it("asks for a fresh review instead of applying one stored before rows carried the basis", async () => {
    await review();
    const legacyRows = stored!.rows.map(({ sizeName: _size, basis: _basis, basisCents: _amount, warnings: _warnings, ...row }) => row);
    stored = { ...stored!, rows: legacyRows, hash: pricingHash({ input: stored!.input, rows: legacyRows }) };
    await expect(service.applyForMember("member-1", 22, { reviewId, reviewHash: stored.hash, idempotencyKey: "apply-1" }))
      .rejects.toMatchObject({ code: "DROPSHIP_PRICING_REVIEW_STALE" });
    expect(tx.applyReview).not.toHaveBeenCalled();
  });
  it("cannot loop forever on a broken cursor", async () => {
    vi.mocked(tx.listVariantIds).mockResolvedValue([1]);
    await expect(review()).rejects.toThrow("cursor did not advance");
  });
  it("paginates searchable scope choices without returning the whole catalog", async () => {
    const result = await service.targetsForMember("member-1", 22, { type: "listings", search: "SKU-", page: 19 });
    expect(result.total).toBe(1000); expect(result.rows).toHaveLength(50);
    expect(await service.targetsForMember("member-1", 22, { type: "product_line" })).toEqual({ total: 1, rows: [{ id: "2", name: "Mailing supplies" }] });
  });
});
