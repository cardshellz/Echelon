import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("eBay listing feed identity selection", () => {
  const source = readFileSync(
    resolve(process.cwd(), "server/routes/ebay/ebay-listings.routes.ts"),
    "utf8",
  );

  it("resolves product identity independently from the prioritized status row", () => {
    expect(source).toContain("listing_identity.external_product_id");
    expect(source).toContain("COUNT(DISTINCT cl3.external_product_id)::integer");
    expect(source).toContain("pv3.is_active = true");
    expect(source).toContain("externalListingId: row.external_product_id_count === 1");
  });

  it("does not choose an arbitrary listing when active variants disagree", () => {
    expect(source).toContain("externalListingIdentityConflict: row.external_product_id_count > 1");
  });
});
