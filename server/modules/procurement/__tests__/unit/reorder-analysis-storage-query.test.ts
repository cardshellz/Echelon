import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const STORAGE_SRC = readFileSync(
  resolve(__dirname, "../../procurement.storage.ts"),
  "utf8",
);

describe("catalog dimensions in reorder analysis query", () => {
  it("selects the denormalized product category", () => {
    expect(STORAGE_SRC).toMatch(/p\.category AS product_category/);
  });

  it("aggregates active product-line names with an empty-array fallback", () => {
    expect(STORAGE_SRC).toMatch(
      /COALESCE\(pl_agg\.product_line_names, ARRAY\[\]::text\[\]\) AS product_line_names/,
    );
    expect(STORAGE_SRC).toMatch(/ARRAY_AGG\(pl\.name ORDER BY pl\.sort_order, pl\.name\)/);
    expect(STORAGE_SRC).toMatch(/FROM catalog\.product_line_products plp/);
    expect(STORAGE_SRC).toMatch(/JOIN catalog\.product_lines pl ON pl\.id = plp\.product_line_id/);
    expect(STORAGE_SRC).toMatch(/pl\.is_active = true/);
  });
});

describe("earliest inbound ETA in reorder analysis query", () => {
  it("exposes the open-PO earliest expected date per product", () => {
    expect(STORAGE_SRC).toMatch(/on_order\.earliest_expected/);
    expect(STORAGE_SRC).toMatch(
      /MIN\(COALESCE\(pol\.expected_delivery_date, po\.expected_delivery_date, po\.confirmed_delivery_date\)\) AS earliest_expected/,
    );
  });
});
