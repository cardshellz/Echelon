import { describe, expect, it } from "vitest";
import { decideDropshipStockPublicationSelection } from "../../domain/stock-publication-selection";
import { stockPublicationSelectionSchema } from "../../../../../shared/types/stock-publication-selection";

type Input = Parameters<typeof decideDropshipStockPublicationSelection>[0];
const now = new Date("2026-10-12T12:00:00Z");
function input(overrides: Partial<Input> = {}): Input {
  return {
    productVariantId: 101,
    candidate: { productId: 20, productVariantId: 101, productLineIds: [3], category: "Supplies",
      productIsActive: true, variantIsActive: true, variantUomType: "pack",
      requiresShipping: true, trackInventory: true, salesEligibility: "sellable" },
    rules: [{ id: 1, scopeType: "catalog", action: "include" }],
    picked: true,
    override: null,
    listing: { id: 50, productVariantId: 101, status: "active", externalListingId: "listing-1",
      externalOfferId: "offer-1", livePushItemId: null },
    config: { listingMode: "live", inventoryMode: "managed_quantity_sync", isActive: true },
    storePaused: false, now, ...overrides,
  };
}
const decide = (value: Partial<Input> = {}) => decideDropshipStockPublicationSelection(input(value));

describe("Dropship listing intent owns stock selection", () => {
  it.each(["active", "queued", "pushing", "failed", "blocked", "drift_detected"])(
    "retains selected provider duty while status is %s", status => {
      expect(decide({ listing: { ...input().listing!, status } })).toMatchObject({ action: "publish", blockers: [] });
    });

  it("treats a saved live push as publication intent even before IDs exist", () => {
    expect(decide({ listing: { ...input().listing!, status: "failed", externalListingId: null,
      externalOfferId: null, livePushItemId: 77 } })).toMatchObject({ action: "publish", reason: "saved_live_push" });
  });

  it.each([null, "failed", "preview_ready", "not_listed"])(
    "allows a selected unpublished %s candidate to preview ATP without authorizing publication", status => {
      const listing = status === null ? null : { ...input().listing!, status, externalListingId: null, externalOfferId: null };
      expect(decide({ listing })).toMatchObject({ action: "read_only", reason: "selected_catalog_preview" });
    });

  it("does not make a pick alone into a saved publish command", () => {
    expect(decide({ listing: null, picked: true }).action).toBe("read_only");
  });

  // PLAN-B v4.1 §7.2: between PR B and PR C a removed (unpicked) size keeps today's zero duty and reason.
  it("zeroes a retained listing the vendor no longer picks, with the retained not-picked reason", () => {
    expect(decide({ picked: false })).toMatchObject({ action: "zero", reason: "missing_vendor_include_rule", listingSelected: false });
    expect(decide({ picked: false, listing: null })).toMatchObject({ action: "none", reason: "missing_vendor_include_rule" });
    expect(decide({ picked: true })).toMatchObject({ action: "publish", reason: "selected_existing_listing", listingSelected: true });
  });

  it("excludes archived members immediately while the shared listing lifecycle owns removal", () => {
    const value = input();
    value.candidate!.variantIsActive = false;
    expect(decideDropshipStockPublicationSelection(value)).toMatchObject({ action: "none", blockers: [] });
  });

  it.each(["vendor_unpick", "vendor_override", "admin_rule", "internal_variant", "untracked_variant"])(
    "retains zero duty for %s deselection", reason => {
      const value = input();
      if (reason === "vendor_unpick") value.picked = false;
      if (reason === "vendor_override") value.override = { productVariantId: 101, enabledOverride: false };
      if (reason === "admin_rule") value.rules = [...value.rules,
        { id: 4, scopeType: "product", action: "exclude", productId: 20 }];
      if (reason === "internal_variant") value.candidate!.salesEligibility = "internal_only";
      if (reason === "untracked_variant") value.candidate!.trackInventory = false;
      expect(decideDropshipStockPublicationSelection(value).action).toBe("zero");
    });

  it("keeps deselection zero duty after managed sync is disabled", () => {
    expect(decide({ picked: false, config: { ...input().config!, inventoryMode: "disabled" } }).action).toBe("zero");
    expect(decide({ picked: false, listing: null }).action).toBe("none");
  });

  it.each(["listing", "store", "config"])("zeroes a retained %s pause", source => {
    const value = input();
    if (source === "listing") value.listing!.status = "paused";
    if (source === "store") value.storePaused = true;
    if (source === "config") value.config!.isActive = false;
    expect(decideDropshipStockPublicationSelection(value).action).toBe("zero");
  });

  it("never resurrects ended listings from historical selection", () => {
    expect(decide({ listing: { ...input().listing!, status: "ended" } })).toMatchObject({ action: "none", reason: "listing_ended" });
    expect(decide({ listing: { ...input().listing!, status: "ended", livePushItemId: 78 } }).action).toBe("publish");
  });

  it.each(["draft_first", "manual_only"] as const)("does not turn %s configuration into live consent", listingMode => {
    const config = { ...input().config!, listingMode };
    expect(decide({ config }).action).toBe("zero");
    expect(decide({ config, listing: null }).action).toBe("read_only");
  });

  it.each(["manual_quantity", "disabled"] as const)("does not assign positive stock with %s mode", inventoryMode => {
    const config = { ...input().config!, inventoryMode };
    expect(decide({ config }).action).toBe("zero");
    expect(decide({ config, listing: null }).action).toBe("read_only");
    expect(decide({ config, listing: { ...input().listing!, externalListingId: null,
      externalOfferId: null, livePushItemId: 77 } }).action).toBe("zero");
  });

  it("honors effective catalog rules and does not mutate inputs", () => {
    const value = input({ rules: [{ id: 1, scopeType: "catalog", action: "include",
      endsAt: new Date("2026-10-12T12:00:01Z") }] });
    const before = structuredClone(value);
    expect(decideDropshipStockPublicationSelection(value).action).toBe("publish");
    expect(decideDropshipStockPublicationSelection({ ...value, now: new Date("2026-10-12T12:00:01Z") }).action).toBe("zero");
    expect(value).toEqual(before);
  });

  it("reports missing catalog identity without silently dropping a retained listing", () => {
    expect(decide({ candidate: null })).toMatchObject({ action: "zero", blockers: [{ code: "DROPSHIP_STOCK_CATALOG_IDENTITY_MISSING" }] });
    expect(decide({ candidate: null, listing: null }).action).toBe("none");
  });
});

// eBay sync-back owner rule 1 (plan v4 SB29): the listing's vendor limit travels on a publish decision only.
describe("the vendor's quantity limit on a publish decision", () => {
  const withLimit = (vendorQuantityLimit: number | null | undefined, patch: Partial<NonNullable<Input["listing"]>> = {}) =>
    decide({ listing: { ...input().listing!, vendorQuantityLimit, ...patch } });

  it("carries the limit on a publish, 0 included", () => {
    expect(withLimit(5)).toMatchObject({ action: "publish", publishLimitUnits: 5 });
    expect(withLimit(0)).toMatchObject({ action: "publish", publishLimitUnits: 0 });
  });

  it("is exactly today's decision without a limit", () => {
    expect(withLimit(null)).toEqual(decide());
    expect(withLimit(undefined)).toEqual(decide());
    expect(decide()).not.toHaveProperty("publishLimitUnits");
  });

  it("never carries a limit on a zero, read-only or ended decision", () => {
    expect(withLimit(5, { status: "paused" })).toMatchObject({ action: "zero" });
    expect(withLimit(5, { status: "paused" })).not.toHaveProperty("publishLimitUnits");
    expect(withLimit(5, { status: "ended" })).not.toHaveProperty("publishLimitUnits");
    expect(withLimit(5, { status: "preview_ready", externalListingId: null, externalOfferId: null })).not.toHaveProperty("publishLimitUnits");
  });

  it("the shared contract refuses a limit on anything but a publish, and a limit that is not a whole number of units", () => {
    const selection = (variant: Record<string, unknown>) => stockPublicationSelectionSchema.safeParse({ productId: 20, fingerprint: "a".repeat(64),
      variants: [{ productVariantId: 101, action: "publish", reason: "selected_existing_listing", blockers: [], ...variant }] });
    expect(selection({ publishLimitUnits: 5 }).success).toBe(true);
    expect(selection({}).success).toBe(true);
    expect(selection({ action: "zero", publishLimitUnits: 5 }).success).toBe(false);
    expect(selection({ publishLimitUnits: -1 }).success).toBe(false);
    expect(selection({ publishLimitUnits: 2.5 }).success).toBe(false);
  });
});
