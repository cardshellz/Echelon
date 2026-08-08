import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { normalizeEbayObservedOffers } from "../../ebay-listing-connector-client";

describe("eBay reviewed listing-change route contract", () => {
  const source = readFileSync(
    resolve(process.cwd(), "server/routes/ebay/ebay-listings.routes.ts"),
    "utf8",
  );

  it("requires a read-only preview before explicit update or replacement", () => {
    expect(source).toContain('mode: z.literal("preview")');
    expect(source).toContain('updateExisting: z.object({');
    expect(source).toContain("preview: ebayListingRebuildPreviewSchema");
    expect(source).toContain('sourceState: z.enum(["active", "withdrawn"])');
    expect(source).toContain("previewListingRebuild");
    expect(source).toContain("updateExistingListing");
    expect(source).toContain("executeListingRebuild");
  });

  it("makes in-place update and replacement mutually exclusive", () => {
    expect(source).toContain("if (value.rebuild && value.updateExisting)");
    expect(source).toContain("Choose either an in-place update or a rebuild, not both.");
  });

  it("never turns an ordinary listing push into a destructive rebuild", () => {
    expect(source).toContain("if (rebuild || updateExisting)");
    expect(source).toContain("connectorResult = await ebayListingConnector.pushListing");
  });

  it("clears only marketplace mappings for variants removed by replacement", () => {
    expect(source).toContain("SET external_product_id = NULL");
    expect(source).toContain("external_variant_id = NULL");
    expect(source).toContain("cl.external_sku = ANY($3::text[])");
    expect(source).not.toContain("SET inventory_quantity = 0");
  });

  it("does not persist a failed read-only preview as a listing sync failure", () => {
    expect(source).toContain('if (rebuild?.mode !== "preview")');
  });
  it("normalizes the real nested eBay listing identity", () => {
    const [offer] = normalizeEbayObservedOffers({
      offers: [{
        offerId: "offer-c750",
        sku: "ARM-ENV-SGL-C750",
        status: "PUBLISHED",
        availableQuantity: 870,
        listing: {
          listingId: "298569307307",
          listingStatus: "ACTIVE",
        },
      }],
    });

    expect(offer).toMatchObject({
      offerId: "offer-c750",
      status: "PUBLISHED",
      listingId: "298569307307",
      availableQuantity: 870,
    });
  });
});
