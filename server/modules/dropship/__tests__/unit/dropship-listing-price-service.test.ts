import { beforeEach, describe, expect, it, vi } from "vitest";
import { DropshipListingPriceService, type ListingPriceTransaction } from "../../application/dropship-listing-price-service";
import { listingPriceTargetSchema, saveListingPriceInputSchema, resolveListingPrice, MAX_LISTING_PRICE_CENTS } from "../../../../../shared/dropship/listing-price";
import type { DropshipListingCatalogCandidate, DropshipListingStoreContext, DropshipPricingPolicyRecord } from "../../application/dropship-listing-preview-service";
import type { DropshipProductCost } from "../../application/dropship-product-cost";
import type { ListingRulePrice } from "../../application/dropship-rule-price";

const now = new Date("2026-09-06T15:00:00.000Z");
const target = { storeConnectionId: 22, productVariantId: 101 };
const input = { priceCents: 1499, expectedRevisionId: null, idempotencyKey: "price-test" };

describe("listing price local draft authority", () => {
  let tx: ListingPriceTransaction;
  let service: DropshipListingPriceService;
  let context: DropshipListingStoreContext;
  beforeEach(() => {
    context = { vendorId: 10, vendorStatus: "onboarding", entitlementStatus: "active",
      storeConnectionId: 22, storeStatus: "connected", setupStatus: "incomplete", platform: "ebay", storeLaunchReady: false };
    const candidate = { productId: 7, productVariantId: 101, productLineIds: [], category: "Mailers",
      productIsActive: true, variantIsActive: true, variantUomType: "pack", defaultRetailPriceCents: 899 } as DropshipListingCatalogCandidate;
    tx = {
      vendorId: 10,
      catalog: {
        loadStoreContext: vi.fn(async () => context),
        listCatalogCandidates: vi.fn(async () => [candidate]),
        listCatalogExposureRules: vi.fn(async () => [{ id: 1, scopeType: "catalog", action: "include" }]),
        listSelectionRules: vi.fn(async () => [{ id: 1, scopeType: "catalog", action: "include" }]),
        listVariantOverrides: vi.fn(async () => []), listExistingListings: vi.fn(async () => []),
        listPricingPolicies: vi.fn(async () => []),
      },
      loadSaved: vi.fn(async () => null),
      loadProductCost: vi.fn(async () => null),
      loadReplay: vi.fn(async () => null),
      save: vi.fn(async (value) => ({ saved: { productVariantId: 101, revisionId: 1,
        overridePriceCents: value.priceCents, updatedAt: value.now.toISOString() }, idempotentReplay: false })),
    };
    service = new DropshipListingPriceService({ repository: { execute: async (_request, operation) => operation(tx) },
      clock: { now: () => now }, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } });
  });
  it("loads catalog default without creating a setting or requiring launch readiness", async () => {
    expect(await service.getForMember("member-1", target)).toEqual({ ...target, revisionId: null,
      overridePriceCents: null, effectivePriceCents: 899, defaultPriceCents: 899, source: "catalog_default", updatedAt: null,
      pricingMode: "catalog_default", ruleName: null, pricingIssue: null, rulePriceCents: null, rulesConfigured: false,
      ruleBasis: null, productCostCents: null });
    expect(tx.save).not.toHaveBeenCalled();
  });
  it.each(["connected", "needs_reauth", "refresh_failed"] as const)("saves local price while store is %s", async (status) => {
    context.storeStatus = status;
    const result = await service.saveForMember("member-1", target, input);
    expect(result.price).toMatchObject({ revisionId: 1, overridePriceCents: 1499, effectivePriceCents: 1499, source: "override" });
    expect(tx.save).toHaveBeenCalledWith(expect.objectContaining({ ...input, now, requestHash: expect.stringMatching(/^[a-f0-9]{64}$/) }));
  });
  it.each(["disconnected", "paused", "grace_period"] as const)("rejects store status %s", async (status) => {
    context.storeStatus = status;
    await expect(service.saveForMember("member-1", target, input)).rejects.toMatchObject({ code: "DROPSHIP_LISTING_STORE_BLOCKED" });
    expect(tx.save).not.toHaveBeenCalled();
  });
  it("rejects missing ownership without catalog reads or writes", async () => {
    vi.mocked(tx.catalog.loadStoreContext).mockResolvedValue(null);
    await expect(service.getForMember("member-1", target)).rejects.toMatchObject({ code: "DROPSHIP_STORE_CONNECTION_REQUIRED" });
    expect(tx.catalog.listCatalogCandidates).not.toHaveBeenCalled();
  });
  it("rejects inactive vendor and entitlement before any price access", async () => {
    context.vendorStatus = "suspended";
    await expect(service.saveForMember("member-1", target, input)).rejects.toMatchObject({ code: "DROPSHIP_LISTING_VENDOR_BLOCKED" });
    context.vendorStatus = "active"; context.entitlementStatus = "inactive";
    await expect(service.saveForMember("member-1", target, input)).rejects.toMatchObject({ code: "DROPSHIP_LISTING_ENTITLEMENT_BLOCKED" });
    expect(tx.save).not.toHaveBeenCalled();
  });
  it.each(["missing", "unexposed", "unselected", "disabled"])("rejects %s variant", async (mode) => {
    if (mode === "missing") vi.mocked(tx.catalog.listCatalogCandidates).mockResolvedValue([]);
    if (mode === "unexposed") vi.mocked(tx.catalog.listCatalogExposureRules).mockResolvedValue([]);
    if (mode === "unselected") vi.mocked(tx.catalog.listSelectionRules).mockResolvedValue([]);
    if (mode === "disabled") vi.mocked(tx.catalog.listVariantOverrides).mockResolvedValue([{ productVariantId: 101, enabledOverride: false }]);
    await expect(service.saveForMember("member-1", target, input)).rejects.toMatchObject({ code: "DROPSHIP_LISTING_PRICE_NOT_AVAILABLE" });
    expect(tx.save).not.toHaveBeenCalled();
  });
  it("reset ignores an old applied listing price and remains revisioned", async () => {
    vi.mocked(tx.catalog.listExistingListings).mockResolvedValue([{ productVariantId: 101, listingId: 1,
      vendorRetailPriceCents: 999, status: "live", quantityCap: null, externalListingId: null }]);
    expect((await service.getForMember("member-1", target)).source).toBe("saved_listing");
    const saved = await service.saveForMember("member-1", target, { ...input, priceCents: null });
    expect(saved.price).toMatchObject({ revisionId: 1, overridePriceCents: null, effectivePriceCents: 899, source: "catalog_default" });
  });
  it("hands a listing whose only price an earlier push saved to the store's rules", async () => {
    vi.mocked(tx.catalog.listExistingListings).mockResolvedValue([{ productVariantId: 101, listingId: 1,
      vendorRetailPriceCents: 999, status: "live", quantityCap: null, externalListingId: null }]);
    const rule: ListingRulePrice = { priceCents: 1152, ruleName: "Store default rule", ruleId: null, issue: null, basis: "product_cost",
      profileRevisionId: 1, evidenceHash: "a".repeat(64), productCost: null };
    tx.loadRulePrice = vi.fn(async () => rule);
    expect(await service.getForMember("member-1", target)).toMatchObject({
      effectivePriceCents: 1152, source: "rules", pricingMode: "rules", ruleName: "Store default rule", rulePriceCents: 1152, rulesConfigured: true,
    });
  });
  it("returns unavailable when reset has no valid catalog price, without resurrecting old listing", async () => {
    expect(resolveListingPrice({ saved: { overridePriceCents: null }, existingListingPriceCents: 999, defaultPriceCents: null }))
      .toEqual({ effectivePriceCents: null, source: "unavailable" });
  });
  it.each([0, -1, 1.1, Number.MAX_SAFE_INTEGER])("does not advertise invalid inherited catalog price %s", (defaultPriceCents) => {
    expect(resolveListingPrice({ saved: null, existingListingPriceCents: null, defaultPriceCents }))
      .toEqual({ effectivePriceCents: null, source: "unavailable" });
  });
  it("reports the .ops cost and what the store's rule starts from", async () => {
    vi.mocked(tx.loadProductCost).mockResolvedValue(cost(612));
    expect(await service.getForMember("member-1", target)).toMatchObject({ productCostCents: 612, ruleBasis: null });
    // With rules, the cost comes with the rule price; it is not read twice.
    tx.loadRulePrice = vi.fn(async () => rulePrice({ productCost: cost(700), basis: "catalog_retail" }));
    vi.mocked(tx.loadProductCost).mockClear();
    expect(await service.getForMember("member-1", target)).toMatchObject({ productCostCents: 700, ruleBasis: "catalog_retail" });
    expect(tx.loadProductCost).not.toHaveBeenCalled();
    // An unknown cost is shown as unknown, never as zero.
    tx.loadRulePrice = vi.fn(async () => rulePrice({ productCost: { ...cost(0), status: "unavailable", unitCostCents: null } }));
    expect(await service.getForMember("member-1", target)).toMatchObject({ productCostCents: null });
  });
  it("hashes target, price and optimistic revision, but not retry key or time", async () => {
    await service.saveForMember("member-1", target, input);
    await service.saveForMember("member-1", target, { ...input, idempotencyKey: "another-key" });
    await service.saveForMember("member-1", target, { ...input, expectedRevisionId: 2 });
    const calls = vi.mocked(tx.save).mock.calls;
    expect(calls[0][0].requestHash).toBe(calls[1][0].requestHash);
    expect(calls[0][0].requestHash).not.toBe(calls[2][0].requestHash);
  });
});

describe("listing price strict contracts", () => {
  it.each([0, -1, 1.01, NaN, Infinity, Number.MAX_SAFE_INTEGER, MAX_LISTING_PRICE_CENTS + 1, "999"])("rejects invalid cents %s", (priceCents) => {
    expect(saveListingPriceInputSchema.safeParse({ ...input, priceCents }).success).toBe(false);
  });
  it.each([1, MAX_LISTING_PRICE_CENTS, null])("accepts integer boundary or reset %s", (priceCents) => {
    expect(saveListingPriceInputSchema.safeParse({ ...input, priceCents }).success).toBe(true);
  });
  it("rejects missing revision, unknown authority and invalid id/key", () => {
    expect(saveListingPriceInputSchema.safeParse({ priceCents: 999, idempotencyKey: "key" }).success).toBe(false);
    expect(saveListingPriceInputSchema.safeParse({ ...input, vendorId: 99 }).success).toBe(false);
    expect(saveListingPriceInputSchema.safeParse({ ...input, idempotencyKey: " secret " }).success).toBe(false);
    expect(listingPriceTargetSchema.safeParse({ ...target, storeConnectionId: 0 }).success).toBe(false);
  });
});

describe("a price save never leaves a size without a price it can be listed at", () => {
  let tx: ListingPriceTransaction;
  let service: DropshipListingPriceService;
  let candidate: DropshipListingCatalogCandidate;
  beforeEach(() => {
    const context: DropshipListingStoreContext = { vendorId: 10, vendorStatus: "active", entitlementStatus: "active",
      storeConnectionId: 22, storeStatus: "connected", setupStatus: "complete", platform: "ebay", storeLaunchReady: true };
    candidate = { productId: 7, productVariantId: 101, productLineIds: [], category: "Mailers",
      productIsActive: true, variantIsActive: true, variantUomType: "pack", defaultRetailPriceCents: 899 } as DropshipListingCatalogCandidate;
    tx = {
      vendorId: 10,
      catalog: {
        loadStoreContext: vi.fn(async () => context),
        listCatalogCandidates: vi.fn(async () => [candidate]),
        listCatalogExposureRules: vi.fn(async () => [{ id: 1, scopeType: "catalog", action: "include" }]),
        listSelectionRules: vi.fn(async () => [{ id: 1, scopeType: "catalog", action: "include" }]),
        listVariantOverrides: vi.fn(async () => []), listExistingListings: vi.fn(async () => []),
        listPricingPolicies: vi.fn(async () => []),
      },
      loadSaved: vi.fn(async () => null),
      loadProductCost: vi.fn(async () => null),
      loadReplay: vi.fn(async () => null),
      save: vi.fn(async (value) => ({ saved: { productVariantId: 101, revisionId: 2, overridePriceCents: value.priceCents,
        pricingMode: value.pricingMode ?? (value.priceCents === null ? "catalog_default" : "fixed"), updatedAt: value.now.toISOString() },
        idempotentReplay: false })),
    };
    service = new DropshipListingPriceService({ repository: { execute: async (_request, operation) => operation(tx) },
      clock: { now: () => now }, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } });
  });

  it("refuses a typed price below a blocking Card Shellz minimum and names the minimum", async () => {
    vi.mocked(tx.catalog.listPricingPolicies).mockResolvedValue([limit({ id: 12, floorPriceCents: 1000 })]);
    await expect(service.saveForMember("member-1", target, { ...input, priceCents: 999 })).rejects.toMatchObject({
      code: "DROPSHIP_LISTING_PRICE_OUTSIDE_LIMIT",
      message: "That price is below the Card Shellz minimum of $10.00 for this item. Enter a price Card Shellz allows.",
      context: expect.objectContaining({ ...target, afterPriceCents: 999, blockers: ["pricing:below_floor:policy_12"] }),
    });
    expect(tx.save).not.toHaveBeenCalled();
  });

  it("refuses a typed price above a blocking maximum, using the lowest maximum that applies", async () => {
    vi.mocked(tx.catalog.listPricingPolicies).mockResolvedValue([
      limit({ id: 3, ceilingPriceCents: 5000 }), limit({ id: 4, ceilingPriceCents: 4000 })]);
    await expect(service.saveForMember("member-1", target, { ...input, priceCents: 6000 })).rejects.toMatchObject({
      code: "DROPSHIP_LISTING_PRICE_OUTSIDE_LIMIT",
      message: "That price is above the Card Shellz maximum of $40.00 for this item. Enter a price Card Shellz allows.",
    });
    expect(tx.save).not.toHaveBeenCalled();
  });

  it.each(["warn_only", "block_order_acceptance", "off"] as const)("saves a price that breaks only a %s limit", async (mode) => {
    vi.mocked(tx.catalog.listPricingPolicies).mockResolvedValue([limit({ id: 5, floorPriceCents: 1000, mode })]);
    const result = await service.saveForMember("member-1", target, { ...input, priceCents: 999 });
    expect(result.price).toMatchObject({ effectivePriceCents: 999, source: "override" });
  });

  it("saves a typed price inside every limit, at the limit itself", async () => {
    vi.mocked(tx.catalog.listPricingPolicies).mockResolvedValue([limit({ id: 6, floorPriceCents: 1000, ceilingPriceCents: 2000 })]);
    await expect(service.saveForMember("member-1", target, { ...input, priceCents: 1000 })).resolves.toMatchObject({
      price: expect.objectContaining({ effectivePriceCents: 1000 }) });
    await expect(service.saveForMember("member-1", target, { ...input, priceCents: 2000, idempotencyKey: "price-test-2" }))
      .resolves.toMatchObject({ price: expect.objectContaining({ effectivePriceCents: 2000 }) });
  });

  it("refuses to drop a typed price to a catalog default that is missing", async () => {
    candidate.defaultRetailPriceCents = null;
    vi.mocked(tx.loadSaved).mockResolvedValue(saved({ revisionId: 4, overridePriceCents: 1499, pricingMode: "fixed" }));
    await expect(service.saveForMember("member-1", target, { ...input, priceCents: null, expectedRevisionId: 4 })).rejects.toMatchObject({
      code: "DROPSHIP_LISTING_PRICE_WOULD_BE_LOST",
      message: "This size would be left with no price, so it could not be listed and a live listing would stop getting stock updates. Type an exact price instead.",
      context: expect.objectContaining({ beforePriceCents: 1499, afterPriceCents: null }),
    });
    expect(tx.save).not.toHaveBeenCalled();
  });

  it("refuses to move a usable price to a catalog default below a blocking minimum", async () => {
    vi.mocked(tx.catalog.listPricingPolicies).mockResolvedValue([limit({ id: 7, floorPriceCents: 900 })]);
    vi.mocked(tx.loadSaved).mockResolvedValue(saved({ revisionId: 4, overridePriceCents: 1499, pricingMode: "fixed" }));
    await expect(service.saveForMember("member-1", target, { ...input, priceCents: null, expectedRevisionId: 4 })).rejects.toMatchObject({
      code: "DROPSHIP_LISTING_PRICE_WOULD_BE_LOST",
      message: "This size would move to $8.99, below the Card Shellz minimum of $9.00 for this item, so it could not be listed and a live listing would stop getting stock updates. Type an exact price instead.",
    });
  });

  it("refuses to hand a usable price to rules that cannot price the size", async () => {
    tx.loadRulePrice = vi.fn(async () => rulePrice({ priceCents: null, issue: "pricing_basis_unavailable" }));
    vi.mocked(tx.loadSaved).mockResolvedValue(saved({ revisionId: 4, overridePriceCents: 1499, pricingMode: "fixed" }));
    await expect(service.saveForMember("member-1", target, { ...input, priceCents: null, pricingMode: "rules", expectedRevisionId: 4 }))
      .rejects.toMatchObject({ code: "DROPSHIP_LISTING_PRICE_WOULD_BE_LOST" });
    expect(tx.save).not.toHaveBeenCalled();
  });

  it("lets a size that has no price today stay without one", async () => {
    candidate.defaultRetailPriceCents = null;
    await expect(service.saveForMember("member-1", target, { ...input, priceCents: null })).resolves.toMatchObject({
      price: expect.objectContaining({ effectivePriceCents: null, source: "unavailable" }) });
    expect(tx.save).toHaveBeenCalledTimes(1);
  });

  it("lets a size already outside a limit move to another price outside it, unless the vendor types it", async () => {
    vi.mocked(tx.catalog.listPricingPolicies).mockResolvedValue([limit({ id: 8, floorPriceCents: 1000 })]);
    vi.mocked(tx.loadSaved).mockResolvedValue(saved({ revisionId: 4, overridePriceCents: 950, pricingMode: "fixed" }));
    await expect(service.saveForMember("member-1", target, { ...input, priceCents: null, expectedRevisionId: 4 })).resolves.toMatchObject({
      price: expect.objectContaining({ effectivePriceCents: 899, source: "catalog_default" }) });
    await expect(service.saveForMember("member-1", target, { ...input, priceCents: 960, expectedRevisionId: 4, idempotencyKey: "price-test-3" }))
      .rejects.toMatchObject({ code: "DROPSHIP_LISTING_PRICE_OUTSIDE_LIMIT" });
  });

  it("returns a retried save's first result without checking it again", async () => {
    vi.mocked(tx.loadReplay).mockResolvedValue(saved({ revisionId: 9, overridePriceCents: 999, pricingMode: "fixed" }));
    // The minimum went up after the first save; the retry still reports what was saved.
    vi.mocked(tx.catalog.listPricingPolicies).mockResolvedValue([limit({ id: 9, floorPriceCents: 1000 })]);
    const result = await service.saveForMember("member-1", target, { ...input, priceCents: 999 });
    expect(result).toMatchObject({ idempotentReplay: true, price: { revisionId: 9, effectivePriceCents: 999 } });
    expect(tx.loadReplay).toHaveBeenCalledWith({ idempotencyKey: input.idempotencyKey, requestHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(tx.catalog.listPricingPolicies).not.toHaveBeenCalled();
    expect(tx.save).not.toHaveBeenCalled();
  });

  it("leaves an out-of-date request to the save's version check", async () => {
    vi.mocked(tx.catalog.listPricingPolicies).mockResolvedValue([limit({ id: 10, floorPriceCents: 1000 })]);
    vi.mocked(tx.loadSaved).mockResolvedValue(saved({ revisionId: 5, overridePriceCents: 1499, pricingMode: "fixed" }));
    await service.saveForMember("member-1", target, { ...input, priceCents: 999, expectedRevisionId: 4 });
    expect(tx.save).toHaveBeenCalledWith(expect.objectContaining({ expectedRevisionId: 4 }));
  });
});

function limit(overrides: Partial<DropshipPricingPolicyRecord> & { id: number }): DropshipPricingPolicyRecord {
  return { scopeType: "catalog", productLineId: null, productId: null, productVariantId: null, category: null,
    mode: "block_listing_push", floorPriceCents: null, ceilingPriceCents: null, ...overrides };
}
function saved(overrides: { revisionId: number; overridePriceCents: number | null; pricingMode: "fixed" | "catalog_default" | "rules" }) {
  return { productVariantId: 101, updatedAt: now.toISOString(), ...overrides };
}
function cost(unitCostCents: number): DropshipProductCost {
  return { status: "available", unitCostCents, planId: "plan-1", source: "variant_fixed_price", overrideId: null, issue: null,
    retailPriceCents: null, discountBps: null };
}
function rulePrice(overrides: Partial<ListingRulePrice> = {}): ListingRulePrice {
  return { priceCents: 1152, ruleName: "Store default rule", ruleId: null, issue: null, basis: "product_cost",
    profileRevisionId: 1, evidenceHash: "a".repeat(64), productCost: null, ...overrides };
}
