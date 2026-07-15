import { describe, expect, it } from "vitest";
import { parseSupplierSetupDeepLink } from "../supplierSetupDeepLink";

describe("parseSupplierSetupDeepLink", () => {
  it("parses an exact supplier-remediation target", () => {
    expect(parseSupplierSetupDeepLink(
      "?setupProductId=175&setupVariantId=390&vendorId=7&vendorProductId=701" +
      "&recommendationId=175%3A390%3A90&setupAction=verify_supplier_cost&returnTo=%2Fpurchasing",
    )).toEqual({
      productId: 175,
      productVariantId: 390,
      vendorId: 7,
      vendorProductId: 701,
      recommendationId: "175:390:90",
      action: "verify_supplier_cost",
      returnTo: "/purchasing",
    });
  });

  it("requires a positive product id and ignores invalid optional identifiers", () => {
    expect(parseSupplierSetupDeepLink("?setupProductId=0")).toBeNull();
    expect(parseSupplierSetupDeepLink(
      "setupProductId=175&setupVariantId=-1&vendorId=abc&vendorProductId=1.5",
    )).toMatchObject({
      productId: 175,
      productVariantId: null,
      vendorId: null,
      vendorProductId: null,
    });
  });

  it("prevents external or protocol-relative return destinations", () => {
    expect(parseSupplierSetupDeepLink("?setupProductId=1&returnTo=https%3A%2F%2Fevil.example")?.returnTo)
      .toBe("/purchasing");
    expect(parseSupplierSetupDeepLink("?setupProductId=1&returnTo=%2F%2Fevil.example")?.returnTo)
      .toBe("/purchasing");
    expect(parseSupplierSetupDeepLink("?setupProductId=1&returnTo=%2Fsettings")?.returnTo)
      .toBe("/purchasing");
    expect(parseSupplierSetupDeepLink("?setupProductId=1&returnTo=%2Freorder-analysis")?.returnTo)
      .toBe("/reorder-analysis");
  });
});
