import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DropshipListingPriceService,
  saveListingPriceInTransaction,
  type ListingPriceTransaction,
} from "../../application/dropship-listing-price-service";
import type { ListingPricingMode, SaveListingPriceInput } from "../../../../../shared/dropship/listing-price";
import type { DropshipListingCatalogCandidate, DropshipListingStoreContext, DropshipPricingPolicyRecord } from "../../application/dropship-listing-preview-service";
import type { ListingRulePrice } from "../../application/dropship-rule-price";

// W9's save flow, exported so a listing-settings transaction writes a size price
// only through W9's own checks (plan D29). The stub stands in for the transaction
// that tx.sizePrice(id) returns; the checks must run exactly as they do for W9.

const NOW = new Date("2026-10-10T12:00:00.000Z");
const TARGET = Object.freeze({ storeConnectionId: 22, productVariantId: 101 });
// A listing-settings caller passes its own child key and the parent's request hash.
const CHILD_KEY = "ls:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef:size:101";
const PARENT_HASH = "f".repeat(64);
type Catalog = ListingPriceTransaction["catalog"];

describe("saveListingPriceInTransaction", () => {
  let tx: ListingPriceTransaction;
  let context: DropshipListingStoreContext;
  let candidate: DropshipListingCatalogCandidate;

  beforeEach(() => {
    context = { vendorId: 10, vendorStatus: "active", entitlementStatus: "active", storeConnectionId: 22,
      storeStatus: "connected", setupStatus: "complete", platform: "ebay", storeLaunchReady: true };
    candidate = { productId: 7, productVariantId: 101, productLineIds: [], category: "Mailers", productIsActive: true,
      variantIsActive: true, variantUomType: "pack", defaultRetailPriceCents: 899, unitsPerVariant: 1, sku: "MAILER-101",
      productName: "Mailers", variantName: "Pack", title: null, description: null, ebayBrowseCategoryId: null,
      ebayBrowseCategoryName: null, brand: null, gtin: null, mpn: null, condition: null, itemSpecifics: null, imageUrls: [],
      weightGrams: null };
    tx = {
      vendorId: 10,
      catalog: {
        loadStoreContext: vi.fn<Catalog["loadStoreContext"]>(async () => context),
        listCatalogCandidates: vi.fn<Catalog["listCatalogCandidates"]>(async () => [candidate]),
        listCatalogExposureRules: vi.fn<Catalog["listCatalogExposureRules"]>(async () => [{ id: 1, scopeType: "catalog", action: "include" }]),
        listSelectionRules: vi.fn<Catalog["listSelectionRules"]>(async () => [{ id: 1, scopeType: "catalog", action: "include" }]),
        listVariantOverrides: vi.fn<Catalog["listVariantOverrides"]>(async () => []),
        listExistingListings: vi.fn<Catalog["listExistingListings"]>(async () => []),
        listPricingPolicies: vi.fn<Catalog["listPricingPolicies"]>(async () => []),
      },
      loadSaved: vi.fn<ListingPriceTransaction["loadSaved"]>(async () => null),
      loadProductCost: vi.fn<ListingPriceTransaction["loadProductCost"]>(async () => null),
      loadReplay: vi.fn<ListingPriceTransaction["loadReplay"]>(async () => null),
      save: vi.fn<ListingPriceTransaction["save"]>(async (value) => ({ saved: { productVariantId: 101, revisionId: 5,
        overridePriceCents: value.priceCents, pricingMode: value.pricingMode ?? (value.priceCents === null ? "catalog_default" : "fixed"),
        updatedAt: value.now.toISOString() }, idempotentReplay: false })),
    };
  });

  it("refuses inherit that would leave a priced size with no price, before any write", async () => {
    candidate.defaultRetailPriceCents = null;
    vi.mocked(tx.loadSaved).mockResolvedValue(saved({ revisionId: 4, overridePriceCents: 1499, pricingMode: "fixed" }));

    await expect(saveListingPriceInTransaction(tx, TARGET, save({ priceCents: null, pricingMode: "inherit", expectedRevisionId: 4 }), PARENT_HASH, NOW))
      .rejects.toMatchObject({ code: "DROPSHIP_LISTING_PRICE_WOULD_BE_LOST",
        context: expect.objectContaining({ ...TARGET, beforePriceCents: 1499, afterPriceCents: null, pricingMode: "inherit" }) });
    expect(tx.save).not.toHaveBeenCalled();
  });

  it("refuses a typed price outside a blocking Card Shellz limit, before any write", async () => {
    vi.mocked(tx.catalog.listPricingPolicies).mockResolvedValue([limit({ id: 12, floorPriceCents: 1000 })]);

    await expect(saveListingPriceInTransaction(tx, TARGET, save({ priceCents: 999 }), PARENT_HASH, NOW))
      .rejects.toMatchObject({ code: "DROPSHIP_LISTING_PRICE_OUTSIDE_LIMIT",
        context: expect.objectContaining({ afterPriceCents: 999, blockers: ["pricing:below_floor:policy_12"] }) });
    expect(tx.save).not.toHaveBeenCalled();
  });

  it("refuses rules mode when the store has no rule price for the size", async () => {
    await expect(saveListingPriceInTransaction(tx, TARGET, save({ priceCents: null, pricingMode: "rules" }), PARENT_HASH, NOW))
      .rejects.toMatchObject({ code: "DROPSHIP_PRICING_RULES_NOT_CONFIGURED" });
    expect(tx.save).not.toHaveBeenCalled();
  });

  it("returns a replayed key's stored revision without running the price checks again", async () => {
    vi.mocked(tx.loadReplay).mockResolvedValue(saved({ revisionId: 9, overridePriceCents: 999, pricingMode: "fixed" }));
    // A minimum raised after the first save would refuse this price as a fresh save.
    vi.mocked(tx.catalog.listPricingPolicies).mockResolvedValue([limit({ id: 9, floorPriceCents: 1000 })]);

    const result = await saveListingPriceInTransaction(tx, TARGET, save({ priceCents: 999 }), PARENT_HASH, NOW);

    expect(result).toMatchObject({ idempotentReplay: true, price: { ...TARGET, revisionId: 9, effectivePriceCents: 999, source: "override" } });
    expect(tx.loadReplay).toHaveBeenCalledWith({ idempotencyKey: CHILD_KEY, requestHash: PARENT_HASH });
    expect(tx.loadSaved).not.toHaveBeenCalled();
    expect(tx.save).not.toHaveBeenCalled();
  });

  it.each([
    ["unselected", () => { vi.mocked(tx.catalog.listSelectionRules).mockResolvedValue([]); }],
    ["unexposed", () => { vi.mocked(tx.catalog.listCatalogExposureRules).mockResolvedValue([]); }],
    ["missing", () => { vi.mocked(tx.catalog.listCatalogCandidates).mockResolvedValue([]); }],
  ])("refuses a %s size as not available before the replay lookup", async (_case, arrange) => {
    arrange();
    await expect(saveListingPriceInTransaction(tx, TARGET, save({ priceCents: 1499 }), PARENT_HASH, NOW))
      .rejects.toMatchObject({ code: "DROPSHIP_LISTING_PRICE_NOT_AVAILABLE" });
    expect(tx.loadReplay).not.toHaveBeenCalled();
    expect(tx.save).not.toHaveBeenCalled();
  });

  it.each([
    ["DROPSHIP_LISTING_VENDOR_BLOCKED", () => { context.vendorStatus = "suspended"; }],
    ["DROPSHIP_LISTING_ENTITLEMENT_BLOCKED", () => { context.entitlementStatus = "inactive"; }],
    ["DROPSHIP_LISTING_STORE_BLOCKED", () => { context.storeStatus = "paused"; }],
    ["DROPSHIP_STORE_CONNECTION_REQUIRED", () => { vi.mocked(tx.catalog.loadStoreContext).mockResolvedValue(null); }],
  ])("refuses with %s before reading the catalog", async (code, arrange) => {
    arrange();
    await expect(saveListingPriceInTransaction(tx, TARGET, save({ priceCents: 1499 }), PARENT_HASH, NOW))
      .rejects.toMatchObject({ code });
    expect(tx.catalog.listCatalogCandidates).not.toHaveBeenCalled();
    expect(tx.save).not.toHaveBeenCalled();
  });

  it("saves with the caller's key and request hash unchanged and does not mutate its inputs", async () => {
    const input = Object.freeze(save({ priceCents: 1499 }));

    const result = await saveListingPriceInTransaction(tx, TARGET, input, PARENT_HASH, NOW);

    expect(tx.save).toHaveBeenCalledWith({ ...input, requestHash: PARENT_HASH, now: NOW });
    expect(result).toMatchObject({ idempotentReplay: false,
      price: { ...TARGET, revisionId: 5, overridePriceCents: 1499, effectivePriceCents: 1499, source: "override", pricingMode: "fixed" } });
    expect(input).toEqual(save({ priceCents: 1499 }));
    expect(TARGET).toEqual({ storeConnectionId: 22, productVariantId: 101 });
  });

  // A tx built for size 202 paired with a target for size 101: the checks ran on
  // 101, so the write to 202 must not commit. The throw rolls the transaction back.
  it("refuses a save whose transaction wrote another size than the one checked", async () => {
    vi.mocked(tx.save).mockImplementation(async (value) => ({ saved: { productVariantId: 202, revisionId: 5,
      overridePriceCents: value.priceCents, pricingMode: "fixed", updatedAt: value.now.toISOString() }, idempotentReplay: false }));

    await expect(saveListingPriceInTransaction(tx, TARGET, save({ priceCents: 1499 }), PARENT_HASH, NOW))
      .rejects.toMatchObject({ code: "DROPSHIP_LISTING_PRICE_INVARIANT_FAILED",
        context: { ...TARGET, transactionProductVariantId: 202 } });
  });

  it("refuses a replay whose transaction found another size's revision", async () => {
    vi.mocked(tx.loadReplay).mockResolvedValue({ ...saved({ revisionId: 9, overridePriceCents: 999, pricingMode: "fixed" }), productVariantId: 202 });

    await expect(saveListingPriceInTransaction(tx, TARGET, save({ priceCents: 999 }), PARENT_HASH, NOW))
      .rejects.toMatchObject({ code: "DROPSHIP_LISTING_PRICE_INVARIANT_FAILED",
        context: { ...TARGET, transactionProductVariantId: 202 } });
    expect(tx.save).not.toHaveBeenCalled();
  });

  it("is the flow W9's saveForMember runs: same transaction, same answer", async () => {
    tx.loadRulePrice = vi.fn(async () => rulePrice({ priceCents: 1152 }));
    const service = new DropshipListingPriceService({ repository: { execute: async (_request, operation) => operation(tx) },
      clock: { now: () => NOW }, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } });
    const input = { priceCents: null, pricingMode: "rules" as const, expectedRevisionId: null, idempotencyKey: CHILD_KEY };

    const viaService = await service.saveForMember("member-1", TARGET, input);
    const serviceHash = vi.mocked(tx.loadReplay).mock.calls[0][0].requestHash;
    const direct = await saveListingPriceInTransaction(tx, TARGET, input, serviceHash, NOW);

    expect(direct).toEqual(viaService);
    expect(vi.mocked(tx.save).mock.calls[0]).toEqual(vi.mocked(tx.save).mock.calls[1]);
  });
});

function save(overrides: Partial<SaveListingPriceInput> = {}): SaveListingPriceInput {
  return { priceCents: 1499, expectedRevisionId: null, idempotencyKey: CHILD_KEY, ...overrides };
}
function saved(overrides: { revisionId: number; overridePriceCents: number | null; pricingMode: ListingPricingMode }) {
  return { productVariantId: 101, updatedAt: NOW.toISOString(), ...overrides };
}
function limit(overrides: Partial<DropshipPricingPolicyRecord> & { id: number }): DropshipPricingPolicyRecord {
  return { scopeType: "catalog", productLineId: null, productId: null, productVariantId: null, category: null,
    mode: "block_listing_push", floorPriceCents: null, ceilingPriceCents: null, ...overrides };
}
function rulePrice(overrides: Partial<ListingRulePrice> = {}): ListingRulePrice {
  return { priceCents: 1152, ruleName: "Store default rule", ruleId: null, issue: null, basis: "product_cost",
    profileRevisionId: 1, evidenceHash: "a".repeat(64), productCost: null, ...overrides };
}
