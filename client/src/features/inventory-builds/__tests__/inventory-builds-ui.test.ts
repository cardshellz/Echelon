import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}

describe("Inventory Builds UI contract", () => {
  const builds = source("client/src/pages/Builds.tsx");
  const app = source("client/src/App.tsx");
  const shell = source("client/src/components/layout/AppShell.tsx");
  const relationships = source("client/src/features/inventory-builds/ProductBuildRelationships.tsx");
  const productDetail = source("client/src/pages/ProductDetail.tsx");

  it("uses the established SKU-search identifier contract", () => {
    expect(builds).toContain("productVariantId: number");
    expect(builds).toContain("outputVariant?.productVariantId");
    expect(builds).toContain("component.variant?.productVariantId");
    expect(builds).not.toContain("variant.variantId");
  });

  it("requires an explicit confirmation before posting a released build", () => {
    expect(builds).toContain("setExecuteOrder(order)");
    expect(builds).toContain("Verify the physical build is complete before continuing.");
    expect(builds).toContain('action: "execute"');
  });

  it("creates build orders with a stable command idempotency key", () => {
    expect(builds).toContain("crypto.randomUUID()");
    expect(builds).toContain('"Idempotency-Key": orderCommandKey');
  });

  it("exposes the protected page from Inventory navigation", () => {
    expect(app).toContain('import Builds from "@/pages/Builds"');
    expect(app).toContain('<Route path="/inventory/builds">');
    expect(shell).toContain('{ label: "Builds", icon: PackageCheck, href: "/inventory/builds" }');
  });
  it("shows catalog variant build relationships and deep-links to recipes", () => {
    expect(relationships).toContain("/api/inventory/build-relationships/products/");
    expect(relationships).toContain('href="/inventory/builds?tab=recipes"');
    expect(productDetail).toContain("<ProductBuildRelationships");
    expect(builds).toContain('new URLSearchParams(search).get("tab") === "recipes"');
    expect(builds).toContain("value={activeBuildsTab}");
  });

});
