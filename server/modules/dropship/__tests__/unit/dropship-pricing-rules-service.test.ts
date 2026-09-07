import { beforeEach, describe, expect, it, vi } from "vitest";
import { DropshipPricingRulesService, type PricingRulesTransaction, type StoredPricingReview } from "../../application/dropship-pricing-rules-service";
import type { DropshipListingCatalogCandidate, DropshipListingPreviewRepository } from "../../application/dropship-listing-preview-service";
import type { DropshipProductCost } from "../../application/dropship-product-cost";
import type { PricingProfileState } from "../../../../../shared/dropship/pricing-rules";
import type { SavedListingPriceRevision } from "../../../../../shared/dropship/listing-price";

const now = new Date("2026-09-07T12:00:00.000Z");
const reviewId = "02892196-a1f2-4e72-823a-32188b9cb234";
const profile = { defaultRecipe: { basis: "product_cost" as const, markupBps: 3000, flatCents: 100, rounding: "cent" as const }, groups: [] };
const input = { profile, expectedRevisionId: null, releaseFixedOverrides: false };
const cost: DropshipProductCost = { status: "available", unitCostCents: 809, planId: "ops-plan", source: "variant_fixed_price", overrideId: "cost-1", issue: null };

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
      productLineIds: [2], category: "Mailers", productIsActive: true, variantIsActive: true,
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
