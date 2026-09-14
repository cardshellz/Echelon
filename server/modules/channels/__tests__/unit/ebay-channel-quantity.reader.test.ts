import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { EbayChannelQuantityReader } from "../../adapters/ebay/ebay-channel-quantity.reader";

describe("EbayChannelQuantityReader", () => {
  it("requests the exact direct-eBay channel target and maps published quantities", async () => {
    const readProduct = vi.fn().mockResolvedValue({
      authority: "canonical",
      productId: 10,
      rows: [
        { productVariantId: 101, quantity: 8, publicationTargetIds: [11] },
        { productVariantId: 102, quantity: 0, publicationTargetIds: [11] },
      ],
    });
    const legacyAtp = { getAtpPerVariant: vi.fn() };
    const reader = new EbayChannelQuantityReader({ readProduct } as never, legacyAtp as never);

    await expect(reader.getAtpPerVariant(10, 67)).resolves.toEqual([
      { productVariantId: 101, atpUnits: 8 },
      { productVariantId: 102, atpUnits: 0 },
    ]);
    expect(readProduct).toHaveBeenCalledWith({
      productId: 10,
      channelId: 67,
      target: { destinationKind: "channel_connection", providerKey: "ebay" },
      triggeredBy: "ebay_listing_quantity_read",
    }, expect.any(Function));
  });

  it("adapts legacy ATP without adding another formula", async () => {
    const legacyRows = [{
      productVariantId: 101,
      sku: "SKU-101",
      name: "Each",
      unitsPerVariant: 1,
      salesEligibility: "sellable",
      atpUnits: 12,
      atpBase: 12,
    }];
    const legacyAtp = { getAtpPerVariant: vi.fn().mockResolvedValue(legacyRows) };
    const readProduct = vi.fn(async (_input, legacyReader) => ({
      authority: "legacy",
      productId: 10,
      rows: (await legacyReader()).map((row: { productVariantId: number; quantity: number }) => ({
        ...row,
        publicationTargetIds: [],
      })),
    }));
    const reader = new EbayChannelQuantityReader({ readProduct } as never, legacyAtp as never);

    await expect(reader.getAtpPerVariant(10, 67)).resolves.toEqual([
      { productVariantId: 101, atpUnits: 12 },
    ]);
    expect(legacyAtp.getAtpPerVariant).toHaveBeenCalledWith(10);
  });

  it("routes the live eBay test-listing quantity through the shared channel reader", () => {
    const source = readFileSync(
      resolve(process.cwd(), "server/routes/ebay-settings.routes.ts"),
      "utf8",
    );
    const routeStart = source.search(
      /app\.post\(\s*"\/api\/ebay\/listings\/test",\s*requirePermission\("channels", "edit"\),/,
    );
    expect(routeStart).toBeGreaterThanOrEqual(0);
    const route = source.slice(routeStart);

    expect(route).toContain('requirePermission("channels", "edit")');
    expect(route).toContain("ebayChannelQuantityReader.getAtpPerVariant(product.id)");
    expect(route).toContain("row.productVariantId === testVariant.id");
    expect(route).toContain("?.atpUnits ?? 0");
    expect(route).not.toContain("offer.payload.availableQuantity = 1");
  });
});
