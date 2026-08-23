import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const productDetailSource = readFileSync(
  join(process.cwd(), "client", "src", "pages", "ProductDetail.tsx"),
  "utf8",
);

describe("product inventory strategy UI contract", () => {
  it("loads and persists the product-level strategy", () => {
    expect(productDetailSource).toContain(
      "inventoryStrategy: product.inventoryStrategy ?? DEFAULT_PRODUCT_INVENTORY_STRATEGY",
    );
    expect(productDetailSource).toContain(
      "inventoryStrategy: editForm.inventoryStrategy",
    );
  });

  it("renders an accessible, visibly selected strategy control", () => {
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
});
