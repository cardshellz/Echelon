import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}

describe("Inventory Builds UI contract", () => {
  const builds = source("client/src/pages/Builds.tsx");
  const builder = source("client/src/pages/BuildRecipeCreate.tsx");
  const recipeModel = source("client/src/features/inventory-builds/build-recipe-model.ts");
  const variantSelector = source("client/src/features/inventory-builds/BuildVariantSelector.tsx");
  const variantClient = source("client/src/features/catalog/create-product-variant.ts");
  const app = source("client/src/App.tsx");
  const shell = source("client/src/components/layout/AppShell.tsx");
  const relationships = source("client/src/features/inventory-builds/ProductBuildRelationships.tsx");
  const productDetail = source("client/src/pages/ProductDetail.tsx");
  const variants = source("client/src/pages/Variants.tsx");

  it("uses the established SKU-search identifier contract", () => {
    expect(recipeModel).toContain("productVariantId: number");
    expect(builder).toContain("outputVariant?.productVariantId");
    expect(builder).toContain("component.variant?.productVariantId");
    expect(builder).not.toContain("variant.variantId");
  });

  it("requires explicit recipe classification and shows conservation evidence", () => {
    expect(recipeModel).toContain('export type RecipeType = "conversion" | "assembly"');
    expect(recipeModel).toContain("Base units conserved.");
    expect(recipeModel).toContain("Each component variant can only be added once.");
    expect(recipeModel).toContain("The output variant cannot also be a component.");
    expect(builder).toContain("<ToggleGroup");
    expect(builder).toContain('value="conversion"');
    expect(builder).toContain('value="assembly"');
    expect(builder).toContain("evidence?.valid");
  });

  it("authors recipes on a dedicated page and creates missing variants in context", () => {
    expect(builds).toContain('navigate("/inventory/builds/recipes/new")');
    expect(builds).not.toContain("<Dialog open={recipeOpen}");
    expect(builder).toContain("<BuildVariantSelector");
    expect(variantSelector).toContain("Create and select");
    expect(variantSelector).toContain("createProductVariant");
    expect(variantSelector).toContain("onChange({");
  });

  it("shares the typed variant creation client across catalog and Builds", () => {
    expect(variantClient).toContain("export async function createProductVariant");
    expect(productDetail).toContain("createProductVariant(product?.productId ?? 0");
    expect(variants).toContain("createProductVariant(Number(data.productId)");
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

  it("exposes protected build routes from Inventory navigation", () => {
    expect(app).toContain('import Builds from "@/pages/Builds"');
    expect(app).toContain('import BuildRecipeCreate from "@/pages/BuildRecipeCreate"');
    expect(app).toContain('<Route path="/inventory/builds/recipes/new">');
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