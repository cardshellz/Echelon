import { describe, expect, it } from "vitest";
import {
  buildQueryUrl,
  buildListingPreviewRequest,
  buildListingPushRequest,
  buildVariantSelectionReplacement,
  buildStoreConnectionOAuthStartInput,
  formatCents,
  formatStatus,
  listingPreviewPushableCount,
  normalizePortalReturnPath,
  normalizeShopifyShopDomainInput,
  riskSeverityTone,
  sectionStatusTone,
} from "../dropship-ops-surface";
import type {
  DropshipCatalogRow,
  DropshipListingPreviewResult,
  DropshipVendorSelectionRule,
} from "../dropship-ops-surface";

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

  it("builds listing preview requests from selected catalog rows only", () => {
    expect(buildListingPreviewRequest({
      storeConnectionId: 12,
      rows: [
        makeCatalogRow({ productVariantId: 42, selectionDecision: makeSelectionDecision(true) }),
        makeCatalogRow({ productVariantId: 42, selectionDecision: makeSelectionDecision(true) }),
        makeCatalogRow({ productVariantId: 99, selectionDecision: makeSelectionDecision(false) }),
      ],
    })).toEqual({
      storeConnectionId: 12,
      productVariantIds: [42],
    });
  });

  it("builds listing push requests from non-blocked preview rows only", () => {
    const preview = makeListingPreview({
      rows: [
        makeListingPreviewRow({ productVariantId: 42, previewStatus: "ready" }),
        makeListingPreviewRow({ productVariantId: 99, previewStatus: "warning" }),
        makeListingPreviewRow({ productVariantId: 100, previewStatus: "blocked" }),
      ],
    });

    expect(listingPreviewPushableCount(preview)).toBe(2);
    expect(buildListingPushRequest({
      storeConnectionId: 12,
      preview,
      idempotencyKey: "push-1",
    })).toEqual({
      storeConnectionId: 12,
      productVariantIds: [42, 99],
      idempotencyKey: "push-1",
    });
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
    selectionDecision: makeSelectionDecision(false),
    ...overrides,
  };
}

function makeSelectionDecision(selected: boolean): DropshipCatalogRow["selectionDecision"] {
  return {
    selected,
    reason: selected ? "selected" : "missing_vendor_include_rule",
    marketplaceQuantity: selected ? 5 : 0,
    quantityCapApplied: false,
    autoConnectNewSkus: selected,
    autoListNewSkus: false,
  };
}

function makeListingPreview(overrides: Partial<DropshipListingPreviewResult>): DropshipListingPreviewResult {
  return {
    vendorId: 1,
    storeConnectionId: 12,
    platform: "ebay",
    generatedAt: "2026-05-03T12:00:00.000Z",
    rows: [],
    summary: {
      total: 0,
      ready: 0,
      blocked: 0,
      warning: 0,
    },
    ...overrides,
  };
}

function makeListingPreviewRow(
  overrides: Partial<DropshipListingPreviewResult["rows"][number]>,
): DropshipListingPreviewResult["rows"][number] {
  return {
    productVariantId: 1,
    productId: 10,
    sku: "SKU",
    title: "Listing",
    platform: "ebay",
    listingMode: "live",
    currentListingStatus: "not_listed",
    previewStatus: "ready",
    blockers: [],
    warnings: [],
    marketplaceQuantity: 5,
    priceCents: 1299,
    previewHash: "hash",
    ...overrides,
  };
}
