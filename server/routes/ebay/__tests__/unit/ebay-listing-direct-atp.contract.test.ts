import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("eBay listing direct ATP contract", () => {
  const routeSource = readFileSync(
    resolve(process.cwd(), "server/routes/ebay/ebay-listings.routes.ts"),
    "utf8",
  );
  const helperSource = readFileSync(
    resolve(process.cwd(), "server/routes/ebay/ebay-sync-helpers.ts"),
    "utf8",
  );

  it("never derives eBay listing quantities from the shared sibling pool", () => {
    expect(routeSource).not.toContain("atpService.getAtpPerVariant(");
    expect(helperSource).not.toContain("atpService.getAtpPerVariant(");
  });

  it("uses direct per-SKU ATP in both route and helper sync paths", () => {
    expect(routeSource.match(/atpService\.getDirectVariantAtp\(/g)).toHaveLength(4);
    expect(helperSource.match(/atpService\.getDirectVariantAtp\(/g)).toHaveLength(1);
  });
});