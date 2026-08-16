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

  it("requires explicit recipe classification and shows conservation evidence", () => {
    expect(builds).toContain('type RecipeType = "conversion" | "assembly"');
    expect(builds).toContain("productId: number");
    expect(builds).toContain("unitsPerVariant: number");
    expect(builds).toContain("<ToggleGroup");
    expect(builds).toContain('value="conversion"');
    expect(builds).toContain('value="assembly"');
    expect(builds).toContain("recipeType,");
    expect(builds).toContain("Base units conserved.");
    expect(builds).toContain("recipeEvidence?.valid");
    expect(builds).toContain("Each component variant can only be added once.");
    expect(builds).toContain("The output variant cannot also be a component.");
  });
  it("posts explicit partial run quantities with a stable idempotency key", () => {
    expect(builds).toContain("openExecuteDialog(order)");
    expect(builds).toContain("Post only the quantity physically completed.");
    expect(builds).toContain('"Idempotency-Key": executeCommandKey');
    expect(builds).toContain("buildsCompleted: Number(executeBuilds)");
    expect(builds).toContain("executeBuildCount <= executeOrder.remainingBuilds");
  });

  it("exposes reasoned cancellation and only server-approved reversal", () => {
    expect(builds).toContain("cancelReason");
    expect(builds).toContain("reason: cancelReason");
    expect(builds).toContain("order.runs.find((run) => run.canReverse)");
    expect(builds).toContain('"Idempotency-Key": reverseCommandKey');
    expect(builds).toContain("reason: reverseReason");
  });

  it("shows consumed and reserved component progress", () => {
    expect(builds).toContain("component.consumedQty");
    expect(builds).toContain("component.plannedQty");
    expect(builds).toContain("component.reservedQty");
    expect(builds).toContain("order.remainingBuilds");
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
