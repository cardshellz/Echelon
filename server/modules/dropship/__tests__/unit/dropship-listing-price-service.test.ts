import { beforeEach, describe, expect, it, vi } from "vitest";
import { DropshipListingPriceService, type ListingPriceTransaction } from "../../application/dropship-listing-price-service";
import { listingPriceTargetSchema, saveListingPriceInputSchema, resolveListingPrice, MAX_LISTING_PRICE_CENTS } from "../../../../../shared/dropship/listing-price";
import type { DropshipListingCatalogCandidate, DropshipListingStoreContext } from "../../application/dropship-listing-preview-service";

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
      productIsActive: true, variantIsActive: true, defaultRetailPriceCents: 899 } as DropshipListingCatalogCandidate;
    tx = {
      vendorId: 10,
      catalog: {
        loadStoreContext: vi.fn(async () => context),
        listCatalogCandidates: vi.fn(async () => [candidate]),
        listCatalogExposureRules: vi.fn(async () => [{ id: 1, scopeType: "catalog", action: "include" }]),
        listSelectionRules: vi.fn(async () => [{ id: 1, scopeType: "catalog", action: "include" }]),
        listVariantOverrides: vi.fn(async () => []), listExistingListings: vi.fn(async () => []),
      },
      loadSaved: vi.fn(async () => null),
      save: vi.fn(async (value) => ({ saved: { productVariantId: 101, revisionId: 1,
        overridePriceCents: value.priceCents, updatedAt: value.now.toISOString() }, idempotentReplay: false })),
    };
    service = new DropshipListingPriceService({ repository: { execute: async (_request, operation) => operation(tx) },
      clock: { now: () => now }, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } });
  });
  it("loads catalog default without creating a setting or requiring launch readiness", async () => {
    expect(await service.getForMember("member-1", target)).toEqual({ ...target, revisionId: null,
      overridePriceCents: null, effectivePriceCents: 899, defaultPriceCents: 899, source: "catalog_default", updatedAt: null,
      pricingMode: "catalog_default", ruleName: null, pricingIssue: null, rulePriceCents: null, rulesConfigured: false });
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
  it("returns unavailable when reset has no valid catalog price, without resurrecting old listing", async () => {
    expect(resolveListingPrice({ saved: { overridePriceCents: null }, existingListingPriceCents: 999, defaultPriceCents: null }))
      .toEqual({ effectivePriceCents: null, source: "unavailable" });
  });
  it.each([0, -1, 1.1, Number.MAX_SAFE_INTEGER])("does not advertise invalid inherited catalog price %s", (defaultPriceCents) => {
    expect(resolveListingPrice({ saved: null, existingListingPriceCents: null, defaultPriceCents }))
      .toEqual({ effectivePriceCents: null, source: "unavailable" });
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
