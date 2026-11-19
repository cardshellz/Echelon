import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ContentProfileState, SaveContentProfileInput } from "../../../../../shared/dropship/listing-content";
import type { PricingProfile, PricingProfileState, ReviewPricingRulesInput } from "../../../../../shared/dropship/pricing-rules";
import { DropshipListingContentService, type ContentTransaction } from "../../application/dropship-listing-content-service";
import type { DropshipListingCatalogCandidate, DropshipListingPreviewRepository } from "../../application/dropship-listing-preview-service";
import { EMPTY_LISTING_SETTING_LAYERS } from "../../application/dropship-listing-setting-layers";
import type { ListingPriceCatalogReader } from "../../application/dropship-listing-price-service";
import type { DropshipProductCost } from "../../application/dropship-product-cost";
import { DropshipPricingRulesService, type PricingRulesTransaction, type StoredPricingReview } from "../../application/dropship-pricing-rules-service";
import { pricingHash } from "../../application/dropship-rule-price";
import { DropshipError } from "../../domain/errors";
import { DROPSHIP_LISTING_GROUP_RULES_CLOSED, GROUP_RULES_CLOSED_MESSAGE } from "../../domain/older-group-rules-edit";
import { contentCandidate } from "../fixtures/listing-content.fixture";

/**
 * Listing settings PR 12 (plan D9-D10, 6.4 T2-T3): W1 (the store price review and its apply) and W4 (the description
 * templates save) refuse a new or changed older group with the permanent 422 code, after their replay probe and
 * revision check, writing nothing; unchanged and fewer groups still save. Type-checked (plan 6.1, TESTS6): the older
 * W1/W4 service tests are in the frozen tsc exclusions.
 */

const NOW = new Date("2026-10-18T09:00:00.000Z");
const STAMP = NOW.toISOString();
const STORE = 22;
const REVIEW_ID = "4e2f7a0c-3b8d-4f6e-9a1c-2d5b7e9f0a13";
const RECIPE = { basis: "product_cost" as const, markupBps: 3_000, flatCents: 100, rounding: "cent" as const };
const TOPLOADERS = { id: "toploaders", name: "Toploaders", priority: 1, scope: { type: "category" as const, category: "Toploaders" },
  recipe: { basis: "catalog_retail" as const, markupBps: 2_000, flatCents: 0, rounding: "up_99" as const } };
const SLEEVES = { ...TOPLOADERS, id: "sleeves", name: "Sleeves", priority: 2, scope: { type: "category" as const, category: "Sleeves" } };
const COST: DropshipProductCost = { status: "available", unitCostCents: 809, planId: "ops-plan", source: "variant_fixed_price",
  overrideId: "cost-1", issue: null, retailPriceCents: null, discountBps: null };

async function refusal(promise: Promise<unknown>): Promise<DropshipError> {
  const error = await promise.then(() => null, (caught: unknown) => caught);
  if (!(error instanceof DropshipError)) throw new Error(`Expected a DropshipError, got ${String(error)}`);
  return error;
}

describe("W1 store price review and apply refuse a new or changed older group (T2)", () => {
  let state: PricingProfileState;
  let stored: StoredPricingReview | null;
  let tx: PricingRulesTransaction;
  let service: DropshipPricingRulesService;
  // One size the Toploaders group prices, so a review prices it.
  const candidates: DropshipListingCatalogCandidate[] = [{ ...contentCandidate(), category: "Toploaders" }];

  beforeEach(() => {
    state = { revisionId: 3, updatedAt: STAMP, profile: { defaultRecipe: RECIPE, groups: [TOPLOADERS, SLEEVES] } };
    stored = null;
    const catalog = {
      loadStoreContext: vi.fn(async () => ({ vendorId: 10, vendorStatus: "active", entitlementStatus: "active", storeStatus: "connected" })),
      listCatalogExposureRules: vi.fn(async () => [{ id: 1, scopeType: "catalog", action: "include" }]),
      listPickedVariantIds: vi.fn(async (_vendorId: number, ids: readonly number[]) => new Set(ids)),
      listCatalogCandidates: vi.fn(async (ids: number[]) => candidates.filter((row) => ids.includes(row.productVariantId))),
      listVariantOverrides: vi.fn(async () => []), listExistingListings: vi.fn(async () => []),
      listSavedListingPrices: vi.fn(async () => []), listPricingPolicies: vi.fn(async () => []),
    } as unknown as DropshipListingPreviewRepository;
    tx = {
      vendorId: 10, catalog,
      costs: { loadProductCosts: vi.fn(async ({ productVariantIds }: { productVariantIds: readonly number[] }) =>
        new Map(productVariantIds.map((id) => [id, COST]))) },
      listVariantIds: vi.fn(async (afterId: number, limit: number) => candidates.map((row) => row.productVariantId)
        .filter((id) => id > afterId).slice(0, limit)),
      listProductLines: vi.fn(async () => []),
      loadProfile: vi.fn(async () => state),
      loadRuleLayers: vi.fn(async () => EMPTY_LISTING_SETTING_LAYERS),
      lockSelection: vi.fn(async () => undefined),
      storeReview: vi.fn(async (review: StoredPricingReview) => { stored = review; }),
      loadReview: vi.fn(async () => stored),
      findApplication: vi.fn(async () => null),
      applyReview: vi.fn(async () => 4),
    };
    service = new DropshipPricingRulesService({ repository: { execute: async (_member, _store, operation) => operation(tx) },
      clock: { now: () => NOW }, newId: () => REVIEW_ID, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } });
  });

  const review = (profile: PricingProfile, expectedRevisionId: number | null = 3) =>
    service.reviewForMember("member-1", STORE, { expectedRevisionId, profile, releaseFixedOverrides: false });

  it("refuses a review that adds a group, before reading the selection, and stores no review", async () => {
    const extra = { ...TOPLOADERS, id: "mailers", name: "Mailers", scope: { type: "category" as const, category: "Mailers" } };
    const error = await refusal(review({ defaultRecipe: RECIPE, groups: [TOPLOADERS, SLEEVES, extra] }));
    expect(error).toMatchObject({ code: DROPSHIP_LISTING_GROUP_RULES_CLOSED, message: GROUP_RULES_CLOSED_MESSAGE,
      context: { storeConnectionId: STORE, kind: "pricing", addedIds: ["mailers"], changedIds: [], reordered: false,
        retryable: false, classification: "permanent" } });
    expect(tx.storeReview).not.toHaveBeenCalled();
    expect(tx.listVariantIds).not.toHaveBeenCalled();
    expect(tx.costs.loadProductCosts).not.toHaveBeenCalled();
  });

  it("refuses a review that changes a group's recipe", async () => {
    const error = await refusal(review({ defaultRecipe: RECIPE, groups: [{ ...TOPLOADERS, recipe: { ...TOPLOADERS.recipe, markupBps: 2_500 } }, SLEEVES] }));
    expect(error.context).toMatchObject({ kind: "pricing", addedIds: [], changedIds: ["toploaders"] });
    expect(tx.storeReview).not.toHaveBeenCalled();
  });

  it("checks the revision first: a stale review that adds a group is stale, not refused", async () => {
    const error = await refusal(review({ defaultRecipe: RECIPE, groups: [TOPLOADERS, SLEEVES, { ...SLEEVES, id: "new" }] }, 2));
    expect(error.code).toBe("DROPSHIP_PRICING_REVIEW_STALE");
    expect(tx.storeReview).not.toHaveBeenCalled();
  });

  it("reviews the stored groups unchanged in any order, with a new store default", async () => {
    const result = await review({ defaultRecipe: { ...RECIPE, markupBps: 5_000 }, groups: [SLEEVES, TOPLOADERS] });
    expect(result.summary.total).toBe(1);
    expect(tx.storeReview).toHaveBeenCalledTimes(1);
  });

  it("reviews and applies a removal of every group", async () => {
    const result = await review({ defaultRecipe: RECIPE, groups: [] });
    expect(tx.storeReview).toHaveBeenCalledTimes(1);
    await expect(service.applyForMember("member-1", STORE, { reviewId: result.reviewId, reviewHash: result.reviewHash, idempotencyKey: "apply-1" }))
      .resolves.toEqual({ revisionId: 4, idempotentReplay: false });
    expect(tx.applyReview).toHaveBeenCalledTimes(1);
  });

  it("refuses to apply a review stored before PR 12 that adds a group, and applies nothing", async () => {
    // As if reviewed before the refusal existed: the stored input holds a group the store does not.
    const input: ReviewPricingRulesInput = { expectedRevisionId: 3, releaseFixedOverrides: false,
      profile: { defaultRecipe: RECIPE, groups: [TOPLOADERS, SLEEVES, { ...SLEEVES, id: "old-tab" }] } };
    stored = { id: REVIEW_ID, input, rows: [], hash: pricingHash({ input, rows: [] }), createdAt: NOW };
    const error = await refusal(service.applyForMember("member-1", STORE, { reviewId: REVIEW_ID, reviewHash: stored.hash, idempotencyKey: "apply-2" }));
    expect(error.context).toMatchObject({ kind: "pricing", addedIds: ["old-tab"] });
    expect(tx.applyReview).not.toHaveBeenCalled();
    // The replay probe ran first, then the selection lock, then the refusal.
    expect(tx.findApplication).toHaveBeenCalledTimes(1);
    expect(tx.lockSelection).toHaveBeenCalledTimes(1);
  });

  it("replays an apply committed before the deploy from its record, without checking the groups", async () => {
    vi.mocked(tx.findApplication).mockResolvedValue({ revisionId: 9 });
    const input: ReviewPricingRulesInput = { expectedRevisionId: 3, releaseFixedOverrides: false,
      profile: { defaultRecipe: RECIPE, groups: [{ ...SLEEVES, id: "old-tab" }] } };
    stored = { id: REVIEW_ID, input, rows: [], hash: pricingHash({ input, rows: [] }), createdAt: NOW };
    await expect(service.applyForMember("member-1", STORE, { reviewId: REVIEW_ID, reviewHash: stored.hash, idempotencyKey: "apply-3" }))
      .resolves.toEqual({ revisionId: 9, idempotentReplay: true });
    expect(tx.loadReview).not.toHaveBeenCalled();
    expect(tx.loadProfile).not.toHaveBeenCalled();
    expect(tx.applyReview).not.toHaveBeenCalled();
  });

  it("refuses any group on a store with no pricing profile, and reviews a first profile with none", async () => {
    state = { revisionId: null, updatedAt: null, profile: null };
    expect((await refusal(review({ defaultRecipe: RECIPE, groups: [TOPLOADERS] }, null))).context).toMatchObject({ addedIds: ["toploaders"] });
    await expect(review({ defaultRecipe: RECIPE, groups: [] }, null)).resolves.toMatchObject({ summary: { total: 1 } });
  });
});

describe("W4 description templates save refuses a new or changed older group (T3)", () => {
  const MAILERS = { id: "mailers", name: "Mailers", priority: 1, scope: { type: "category" as const, category: "Mailers" },
    template: { introduction: "Mailers ship flat.", footer: "" } };
  const BINDERS = { ...MAILERS, id: "binders", name: "Binders", priority: 2, scope: { type: "category" as const, category: "Binders" } };
  let state: ContentProfileState;
  let replay: boolean;
  let tx: ContentTransaction;
  let service: DropshipListingContentService;

  beforeEach(() => {
    state = { revisionId: 5, updatedAt: STAMP, profile: { defaultTemplate: { introduction: "", footer: "" }, groups: [MAILERS, BINDERS] } };
    replay = false;
    const catalog = { loadStoreContext: vi.fn(async () => ({ vendorId: 10, vendorStatus: "active", entitlementStatus: "active",
      storeStatus: "connected" })) } as unknown as ListingPriceCatalogReader;
    tx = {
      vendorId: 10, catalog,
      loadProfile: vi.fn(async () => state),
      loadSaved: vi.fn(async () => null),
      findReplay: vi.fn(async () => replay),
      saveProfile: vi.fn(async (input: SaveContentProfileInput) => {
        state = { revisionId: (state.revisionId ?? 0) + 1, updatedAt: STAMP, profile: input.profile };
      }),
      saveListing: vi.fn(async () => undefined),
      loadListingSettingLayers: vi.fn(async () => EMPTY_LISTING_SETTING_LAYERS),
    };
    service = new DropshipListingContentService({ repository: { execute: async (_input, operation) => operation(tx) },
      clock: { now: () => NOW }, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } });
  });

  const save = (groups: NonNullable<ContentProfileState["profile"]>["groups"], expectedRevisionId: number | null = 5,
    idempotencyKey = "ls-text:1") =>
    service.saveProfile("member-1", STORE, { expectedRevisionId, idempotencyKey,
      profile: { defaultTemplate: { introduction: "Ships from Card Shellz.", footer: "" }, groups } });

  it("refuses a save that adds a group and saves nothing", async () => {
    const error = await refusal(save([MAILERS, BINDERS, { ...MAILERS, id: "sleeves", name: "Sleeves" }]));
    expect(error).toMatchObject({ code: DROPSHIP_LISTING_GROUP_RULES_CLOSED, message: GROUP_RULES_CLOSED_MESSAGE,
      context: { storeConnectionId: STORE, kind: "description", addedIds: ["sleeves"], changedIds: [], reordered: false,
        retryable: false, classification: "permanent" } });
    expect(tx.saveProfile).not.toHaveBeenCalled();
  });

  it("refuses a save that changes a group's text", async () => {
    const error = await refusal(save([{ ...MAILERS, template: { introduction: "Other words.", footer: "" } }, BINDERS]));
    expect(error.context).toMatchObject({ changedIds: ["mailers"] });
    expect(tx.saveProfile).not.toHaveBeenCalled();
  });

  it("replays a save committed before the deploy, whatever its groups, before any check", async () => {
    replay = true;
    const result = await save([MAILERS, BINDERS, { ...MAILERS, id: "old-tab" }]);
    expect(result).toEqual({ state, idempotentReplay: true });
    expect(tx.saveProfile).not.toHaveBeenCalled();
  });

  it("checks the revision first: a stale save that adds a group is a version conflict", async () => {
    const error = await refusal(save([MAILERS, BINDERS, { ...MAILERS, id: "sleeves" }], 4));
    expect(error.code).toBe("DROPSHIP_CONTENT_VERSION_CONFLICT");
    expect(tx.saveProfile).not.toHaveBeenCalled();
  });

  it("saves the stored groups unchanged in any order, and saves a removal", async () => {
    await expect(save([BINDERS, MAILERS])).resolves.toMatchObject({ idempotentReplay: false, state: { revisionId: 6 } });
    await expect(save([BINDERS], 6, "ls-text:2")).resolves.toMatchObject({ state: { revisionId: 7, profile: { groups: [BINDERS] } } });
    expect(tx.saveProfile).toHaveBeenCalledTimes(2);
  });
});
