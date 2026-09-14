import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const productDetailSource = readFileSync(
  join(process.cwd(), "client", "src", "pages", "ProductDetail.tsx"),
  "utf8",
);

describe("product inventory strategy UI contract", () => {
  it("loads the legacy value but only submits it when the operator changed it", () => {
    expect(productDetailSource).toContain(
      "inventoryStrategy: product.inventoryStrategy ?? DEFAULT_PRODUCT_INVENTORY_STRATEGY",
    );
    expect(productDetailSource).toContain("editForm.inventoryStrategy !== persistedInventoryStrategy");
    expect(productDetailSource).toContain("productUpdate.inventoryStrategy = editForm.inventoryStrategy");
  });

  it("renders an accessible, visibly selected strategy control only while legacy is authoritative", () => {
    expect(productDetailSource).toContain('inventoryRuntimeAuthorityQuery.data?.authority === "legacy"');
    expect(productDetailSource).toContain('role="radiogroup"');
    expect(productDetailSource).toContain('role="radio"');
    expect(productDetailSource).toContain("aria-checked={selected}");
    expect(productDetailSource).toContain(
      'border-primary bg-primary/10 text-foreground ring-1 ring-primary',
    );
  });

  it("uses the shared strategy definitions instead of duplicating options", () => {
    expect(productDetailSource).toContain("PRODUCT_INVENTORY_STRATEGY_DEFINITIONS.map");
  });

  it("fails closed while authority is unknown and directs canonical edits to Supply Transformations", () => {
    expect(productDetailSource).toContain("Inventory behavior cannot be edited until live authority is confirmed.");
    expect(productDetailSource).toContain("Legacy inventory behavior is retired for live planning.");
    expect(productDetailSource).toContain('href="/inventory/supply-transformations"');
  });

  it("does not load or render legacy per-product allocation controls under canonical or unknown authority", () => {
    expect(productDetailSource).toContain('inventoryRuntimeAuthorityQuery.data?.authority === "legacy"');
    expect(productDetailSource).toContain("Legacy product allocation is retired");
    expect(productDetailSource).toContain("legacy allocation reads and writes remain disabled");
    expect(productDetailSource).toContain('href="/channels/inventory-exposure"');
  });
});
