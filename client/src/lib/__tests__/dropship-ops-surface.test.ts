import { describe, expect, it } from "vitest";
import {
  buildQueryUrl,
  buildVariantSelectionReplacement,
  buildStoreConnectionOAuthStartInput,
  formatCents,
  formatStatus,
  normalizePortalReturnPath,
  normalizeShopifyShopDomainInput,
  riskSeverityTone,
  sectionStatusTone,
} from "../dropship-ops-surface";
import type { DropshipCatalogRow, DropshipVendorSelectionRule } from "../dropship-ops-surface";

describe("dropship ops surface client helpers", () => {
  it("formats integer cents without floating point display drift", () => {
    expect(formatCents(0)).toBe("$0.00");
    expect(formatCents(123456)).toBe("$1,234.56");
    expect(formatCents(-987)).toBe("-$9.87");
  });

  it("normalizes API status tokens for display", () => {
    expect(formatStatus("attention_required")).toBe("Attention Required");
    expect(formatStatus("payment_hold")).toBe("Payment Hold");
    expect(formatStatus(null)).toBe("Unknown");
  });

  it("keeps status and severity tones explicit", () => {
    expect(sectionStatusTone("ready")).toContain("emerald");
    expect(sectionStatusTone("attention_required")).toContain("amber");
    expect(sectionStatusTone("coming_soon")).toContain("zinc");
    expect(riskSeverityTone("error")).toContain("rose");
    expect(riskSeverityTone("warning")).toContain("amber");
    expect(riskSeverityTone("info")).toContain("zinc");
  });

  it("builds query URLs without empty filters", () => {
    expect(buildQueryUrl("/api/dropship/orders", {
      search: "",
      statuses: "accepted",
      page: 1,
      selectedOnly: false,
      vendorId: undefined,
    })).toBe("/api/dropship/orders?statuses=accepted&page=1&selectedOnly=false");
  });

  it("builds store OAuth start payloads with platform-specific fields", () => {
    expect(buildStoreConnectionOAuthStartInput({
      platform: "ebay",
      shopDomain: "ignored",
      returnTo: " /onboarding ",
    })).toEqual({
      platform: "ebay",
      returnTo: "/onboarding",
    });
    expect(buildStoreConnectionOAuthStartInput({
      platform: "shopify",
      shopDomain: "Vendor-Test",
      returnTo: "/onboarding",
    })).toEqual({
      platform: "shopify",
      shopDomain: "vendor-test.myshopify.com",
      returnTo: "/onboarding",
    });
  });

  it("keeps portal return paths relative", () => {
    expect(normalizePortalReturnPath("/settings")).toBe("/settings");
    expect(() => normalizePortalReturnPath("https://attacker.example")).toThrow();
    expect(() => normalizePortalReturnPath("//attacker.example")).toThrow();
    expect(() => normalizePortalReturnPath(`/${"x".repeat(501)}`)).toThrow();
  });

  it("normalizes Shopify shop domains before OAuth start", () => {
    expect(normalizeShopifyShopDomainInput("https://Vendor-Test.myshopify.com/")).toBe("vendor-test.myshopify.com");
    expect(normalizeShopifyShopDomainInput("Vendor-Test")).toBe("vendor-test.myshopify.com");
    expect(normalizeShopifyShopDomainInput(" ")).toBe("");
  });

  it("builds variant include replacements without carrying stale variant overrides", () => {
    const replacement = buildVariantSelectionReplacement({
      existingRules: [
        makeSelectionRule({ id: 1, scopeType: "catalog", action: "include" }),
        makeSelectionRule({ id: 2, scopeType: "variant", action: "exclude", productVariantId: 42 }),
        makeSelectionRule({ id: 3, scopeType: "variant", action: "include", productVariantId: 99 }),
      ],
      rows: [makeCatalogRow({ productVariantId: 42 })],
      action: "include",
    });

    expect(replacement).toEqual([
      expect.objectContaining({ scopeType: "catalog", action: "include" }),
      expect.objectContaining({ scopeType: "variant", action: "include", productVariantId: 99 }),
      expect.objectContaining({ scopeType: "variant", action: "include", productVariantId: 42 }),
    ]);
    expect(replacement.some((rule) => rule.action === "exclude" && rule.productVariantId === 42)).toBe(false);
  });

  it("builds variant exclude replacements for visible deselection", () => {
    const replacement = buildVariantSelectionReplacement({
      existingRules: [makeSelectionRule({ id: 1, scopeType: "catalog", action: "include" })],
      rows: [makeCatalogRow({ productVariantId: 42 }), makeCatalogRow({ productVariantId: 42 })],
      action: "exclude",
    });

    expect(replacement).toEqual([
      expect.objectContaining({ scopeType: "catalog", action: "include" }),
      expect.objectContaining({ scopeType: "variant", action: "exclude", productVariantId: 42 }),
    ]);
  });
});

function makeSelectionRule(overrides: Partial<DropshipVendorSelectionRule>): DropshipVendorSelectionRule {
  return {
    scopeType: "variant",
    action: "include",
    productLineId: null,
    productId: null,
    productVariantId: 1,
    category: null,
    autoConnectNewSkus: true,
    autoListNewSkus: false,
    priority: 0,
    isActive: true,
    ...overrides,
  };
}

function makeCatalogRow(overrides: Partial<DropshipCatalogRow>): DropshipCatalogRow {
  return {
    productId: 10,
    productVariantId: 1,
    productSku: "SKU",
    productName: "Product",
    variantSku: "VARIANT",
    variantName: "Variant",
    category: null,
    productLineNames: [],
    unitsPerVariant: 1,
    selectionDecision: {
      selected: false,
      reason: "missing_vendor_include_rule",
      marketplaceQuantity: 0,
      quantityCapApplied: false,
      autoConnectNewSkus: false,
      autoListNewSkus: false,
    },
    ...overrides,
  };
}
