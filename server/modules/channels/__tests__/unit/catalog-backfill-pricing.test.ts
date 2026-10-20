import { beforeEach, describe, expect, it, vi } from "vitest";
import { channelFeeds, channelListings, productVariants } from "@shared/schema";
import { createCatalogBackfillService, type BackfillResult } from "../../catalog-backfill.service";

const owners = vi.hoisted(() => ({
  savePrice: vi.fn(),
  createPricingService: vi.fn(),
  updateVariant: vi.fn(),
  createVariant: vi.fn(),
}));
vi.mock("../../channel-pricing.service", () => ({
  createChannelPricingService: owners.createPricingService,
}));
vi.mock("../../../catalog/catalog.storage", () => ({
  productMethods: { updateProductVariant: owners.updateVariant, createProductVariant: owners.createVariant },
}));
vi.mock("../../../catalog", () => ({ createSharedProductPhotoImporter: vi.fn() }));

const variant = {
  id: 1001, title: "Each", sku: "TEST-001", price: "0.29", compare_at_price: "19.99" as string | null,
  barcode: null, weight: null, weight_unit: null, inventory_item_id: 2001,
  requires_shipping: true, position: 1, option1: null, option2: null, option3: null,
};
const catalogVariant = {
  id: 11, productId: 34, sku: "TEST-001", salesEligibility: "sellable",
  requiresShipping: true, trackInventory: true,
};

interface VariantBackfillStep {
  processVariant(
    productId: number, shopifyProductId: string, source: typeof variant, channelId: number,
    isDryRun: boolean, result: BackfillResult, backfillPricing: boolean,
    unitsPerVariant: number, hierarchyLevel: number,
  ): Promise<unknown>;
}

function counters(): BackfillResult {
  return {
    success: true, dryRun: false,
    products: { total: 0, created: 0, updated: 0, skipped: 0 },
    variants: { total: 0, created: 0, updated: 0, skipped: 0 },
    feeds: { created: 0, updated: 0 }, listings: { created: 0, updated: 0 },
    pricing: { created: 0, updated: 0 }, assets: { created: 0 },
    inventory: { imported: 0, skipped: 0, noShopifyData: 0 },
    errors: [], mappingConflicts: [], mappings: [], reconciliation: [],
  };
}

function fixture() {
  const writes: unknown[] = [];
  const db = {
    select: vi.fn(() => ({
      from: (table: unknown) => ({
        where: () => ({ limit: async () => table === productVariants ? [catalogVariant] : [] }),
      }),
    })),
    insert: vi.fn((table: unknown) => {
      writes.push(table);
      return { values: vi.fn(async () => undefined) };
    }),
    update: vi.fn(),
    delete: vi.fn(),
    execute: vi.fn(),
    transaction: vi.fn(),
  };
  const service = createCatalogBackfillService(db) as unknown as VariantBackfillStep;
  const result = counters();
  const run = (source = variant, dryRun = false, pricing = true) =>
    service.processVariant(34, "3001", source, 5, dryRun, result, pricing, 1, 0);
  return { db, writes, result, run };
}

beforeEach(() => {
  vi.clearAllMocks();
  owners.createPricingService.mockReturnValue({ savePrice: owners.savePrice });
  owners.savePrice.mockResolvedValue({ price: { id: 70 }, created: true });
  owners.updateVariant.mockResolvedValue(catalogVariant);
});

describe("Shopify catalog backfill pricing handoff", () => {
  it.each([
    ["0.29", "19.99", 29, 1999],
    ["0.00", "0.00", 0, 0],
    ["90071992547409.91", null, Number.MAX_SAFE_INTEGER, null],
  ] as const)("preserves exact cents for price %s and compare-at %s", async (price, compareAt, cents, compareCents) => {
    const { db, writes, result, run } = fixture();
    await run({ ...variant, price, compare_at_price: compareAt });

    expect(owners.updateVariant).toHaveBeenCalledWith(11, expect.objectContaining({
      priceCents: cents, compareAtPriceCents: compareCents,
    }), db);
    expect(owners.createPricingService).toHaveBeenCalledWith(db);
    expect(owners.savePrice).toHaveBeenCalledExactlyOnceWith(
      5, 11, { price: cents, compareAtPrice: compareCents },
      "service:shopify_catalog_backfill", expect.any(Date),
    );
    // Currency and cost remain the pricing owner's responsibility. The importer
    // must not overwrite them or retain a parallel direct pricing writer.
    expect(writes).toEqual([channelFeeds, channelListings]);
    expect(result.pricing).toEqual({ created: 1, updated: 0 });
  });

  it("counts an existing/no-op owner result as updated, preserving the import report contract", async () => {
    owners.savePrice.mockResolvedValue({ price: { id: 70 }, created: false });
    const { result, run } = fixture();
    await run();
    expect(result.pricing).toEqual({ created: 0, updated: 1 });
  });

  it.each(["", "1.001", "1e2", "-1.00", "12junk", "90071992547409.92"])(
    "rejects invalid price %j before any variant or channel mutation", async price => {
      const { db, result, run } = fixture();
      await expect(run({ ...variant, price })).rejects.toMatchObject({
        code: "CHANNEL_PRICING_VALUE_INVALID",
        context: { shopifyVariantId: "1001", sku: "TEST-001", field: "price" },
      });
      expect(db.select).not.toHaveBeenCalled();
      expect(db.insert).not.toHaveBeenCalled();
      expect(db.update).not.toHaveBeenCalled();
      expect(owners.updateVariant).not.toHaveBeenCalled();
      expect(owners.createVariant).not.toHaveBeenCalled();
      expect(owners.savePrice).not.toHaveBeenCalled();
      expect(result.pricing).toEqual({ created: 0, updated: 0 });
    },
  );

  it.each(["", "0.001", "20invalid", "-1.00", "90071992547409.92"])(
    "rejects invalid supplied compare-at %j instead of clearing or rounding it", async compareAt => {
      const { db, run } = fixture();
      await expect(run({ ...variant, compare_at_price: compareAt })).rejects.toMatchObject({
        code: "CHANNEL_PRICING_VALUE_INVALID",
        context: { field: "compare_at_price" },
      });
      expect(db.select).not.toHaveBeenCalled();
      expect(owners.updateVariant).not.toHaveBeenCalled();
      expect(owners.savePrice).not.toHaveBeenCalled();
    },
  );

  it("does not count a rejected pricing transaction as saved", async () => {
    const failure = new Error("pricing audit unavailable");
    owners.savePrice.mockRejectedValue(failure);
    const { result, run } = fixture();
    await expect(run()).rejects.toBe(failure);
    expect(result.pricing).toEqual({ created: 0, updated: 0 });
  });

  it.each([
    { dryRun: true, pricing: true },
    { dryRun: false, pricing: false },
  ])("does not call the pricing owner for $dryRun dry-run / $pricing pricing", async ({ dryRun, pricing }) => {
    const { result, run } = fixture();
    await run(variant, dryRun, pricing);
    expect(owners.createPricingService).not.toHaveBeenCalled();
    expect(owners.savePrice).not.toHaveBeenCalled();
    expect(result.pricing).toEqual({ created: 0, updated: 0 });
  });
});
