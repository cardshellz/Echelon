import { describe, expect, it } from "vitest";
import {
  describeAssignment,
  findDuplicateAssignments,
  slugifyRateBookCode,
} from "../../domain/rate-book-admin";

describe("slugifyRateBookCode", () => {
  it("derives a stable machine code from an operator name", () => {
    expect(slugifyRateBookCode("Dropship Vendor Fulfillment Rates")).toBe("dropship-vendor-fulfillment-rates");
    expect(slugifyRateBookCode("  Shopify Retail (2026)! ")).toBe("shopify-retail-2026");
  });

  it("returns an empty string when nothing survives slugification", () => {
    expect(slugifyRateBookCode("***")).toBe("");
    expect(slugifyRateBookCode("   ")).toBe("");
  });

  it("stays within the column limit without a trailing dash", () => {
    const code = slugifyRateBookCode(`${"a".repeat(79)} b`);
    expect(code.length).toBeLessThanOrEqual(80);
    expect(code.endsWith("-")).toBe(false);
  });
});

describe("findDuplicateAssignments", () => {
  it("accepts distinct channel/purpose/warehouse scopes", () => {
    expect(findDuplicateAssignments([
      { pricingChannel: "shopify", ratePurpose: "customer_checkout", originWarehouseId: null },
      { pricingChannel: "internal", ratePurpose: "customer_checkout", originWarehouseId: null },
      { pricingChannel: "shopify", ratePurpose: "customer_checkout", originWarehouseId: 4 },
    ])).toEqual([]);
  });

  it("flags the same scope listed twice", () => {
    const duplicates = findDuplicateAssignments([
      { pricingChannel: "dropship", ratePurpose: "vendor_fulfillment_charge", originWarehouseId: null },
      { pricingChannel: "dropship", ratePurpose: "vendor_fulfillment_charge", originWarehouseId: null },
    ]);
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]).toContain("dropship / vendor_fulfillment_charge / all warehouses");
  });
});

describe("describeAssignment", () => {
  it("names the warehouse scope explicitly", () => {
    expect(describeAssignment({
      pricingChannel: "shopify",
      ratePurpose: "customer_checkout",
      originWarehouseId: 12,
    })).toBe("shopify / customer_checkout / warehouse 12");
  });
});
