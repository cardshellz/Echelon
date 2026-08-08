import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("eBay listing rebuild route contract", () => {
  const source = readFileSync(
    resolve(process.cwd(), "server/routes/ebay/ebay-listings.routes.ts"),
    "utf8",
  );

  it("requires a read-only preview before explicit execution", () => {
    expect(source).toContain('mode: z.literal("preview")');
    expect(source).toContain('mode: z.literal("execute")');
    expect(source).toContain("preview: ebayListingRebuildPreviewSchema");
    expect(source).toContain('sourceState: z.enum(["active", "withdrawn"])');
    expect(source).toContain("previewListingRebuild");
    expect(source).toContain("executeListingRebuild");
  });

  it("never turns an ordinary listing push into a destructive rebuild", () => {
    expect(source).toContain("if (rebuild)");
    expect(source).toContain("} else {\n              connectorResult = await ebayListingConnector.pushListing");
  });

  it("clears only marketplace mappings for removed variants", () => {
    expect(source).toContain("SET external_product_id = NULL");
    expect(source).toContain("external_variant_id = NULL");
    expect(source).toContain("cl.external_sku = ANY($3::text[])");
    expect(source).not.toContain("SET inventory_quantity = 0");
  });

  it("does not persist a failed read-only preview as a listing sync failure", () => {
    expect(source).toContain('if (rebuild?.mode !== "preview")');
  });
});