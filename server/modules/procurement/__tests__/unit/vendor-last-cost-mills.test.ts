import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { resolveSupplierCost } from "../../purchasing-recommendation.engine";

describe("vendor last-purchase mills", () => {
  it("uses exact last-paid mills for legacy supplier mappings", () => {
    expect(resolveSupplierCost({
      estimatedCostMills: 100,
      estimatedCostCents: 1,
      unitCostCents: null,
      pricingBasis: "legacy_unknown",
      lastCostMills: 48,
      lastCostCents: 0,
      lastPurchasedAt: "2026-07-01T00:00:00.000Z",
      quotedAt: null,
      quotedAtDate: null,
      quoteValidUntil: null,
      asOf: new Date("2026-07-16T00:00:00.000Z"),
      currentDate: "2026-07-16",
    })).toMatchObject({
      estimatedCostMills: 48,
      estimatedCostCents: 0,
      costSource: "last_purchase_cost",
      costQuality: "current",
    });
  });

  it("continues to prefer a verified explicit supplier quote", () => {
    expect(resolveSupplierCost({
      estimatedCostMills: 12_345,
      estimatedCostCents: 123,
      unitCostCents: null,
      pricingBasis: "per_piece",
      lastCostMills: 11_000,
      lastCostCents: 110,
      lastPurchasedAt: "2026-07-01T00:00:00.000Z",
      quotedAt: "2026-07-10T00:00:00.000Z",
      quotedAtDate: "2026-07-10",
      quoteValidUntil: "2026-08-10",
      asOf: new Date("2026-07-16T00:00:00.000Z"),
      currentDate: "2026-07-16",
    })).toMatchObject({
      estimatedCostMills: 12_345,
      costSource: "vendor_unit_cost_mills",
      costQuality: "current",
    });
  });

  it("adds and validates the exact last-cost column in migration 144", () => {
    const migration = readFileSync(
      join(process.cwd(), "migrations", "144_vendor_product_last_cost_mills.sql"),
      "utf8",
    );
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS last_cost_mills bigint");
    expect(migration).toContain("vendor_products_last_cost_precision_chk");
    expect(migration).toContain("floor((last_cost_mills::numeric + 50) / 100)");
    expect(migration).toContain("VALIDATE CONSTRAINT vendor_products_last_cost_precision_chk");
  });
});
