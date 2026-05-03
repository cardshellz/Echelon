import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildQueryUrl,
  buildListingPreviewRequest,
  buildListingPushRequest,
  buildAutoReloadConfigInput,
  buildStripeFundingSetupSessionInput,
  buildStripeWalletFundingSessionInput,
  buildVariantSelectionReplacement,
  buildAdminCatalogExposurePreviewUrl,
  buildAdminOrderIntakeUrl,
  buildAdminOrderOpsActionInput,
  buildCatalogExposureRuleInput,
  catalogExposureRecordToInput,
  catalogExposureRuleKey,
  buildStoreConnectionOAuthStartInput,
  formatCents,
  formatStatus,
  fetchJson,
  listingPreviewPushableCount,
  normalizePortalReturnPath,
  normalizeShopifyShopDomainInput,
  parseDollarInputToCents,
  queryErrorMessage,
  riskSeverityTone,
  sectionStatusTone,
} from "../dropship-ops-surface";
import type {
  DropshipCatalogRow,
  DropshipListingPreviewResult,
  DropshipVendorSelectionRule,
} from "../dropship-ops-surface";

describe("dropship ops surface client helpers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("formats integer cents without floating point display drift", () => {
    expect(formatCents(0)).toBe("$0.00");
    expect(formatCents(123456)).toBe("$1,234.56");
    expect(formatCents(-987)).toBe("-$9.87");
  });

  it("surfaces common API error body shapes", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      json: async () => ({ error: "Unauthorized dropship session." }),
    } as Response)));

    await expect(fetchJson("/api/dropship/orders")).rejects.toThrow("Unauthorized dropship session.");
  });

  it("falls back to explicit query error messages", () => {
    expect(queryErrorMessage(new Error("Store connection failed."), "Fallback")).toBe("Store connection failed.");
    expect(queryErrorMessage({ code: "UNKNOWN" }, "Fallback")).toBe("Fallback");
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

  it("builds admin catalog exposure preview URLs with explicit filters", () => {
    expect(buildAdminCatalogExposurePreviewUrl({
      search: " pack ",
      exposedOnly: true,
      includeInactiveCatalog: false,
    })).toBe("/api/dropship/admin/catalog/preview?search=pack&exposedOnly=true&includeInactiveCatalog=false&page=1&limit=50");
  });

  it("builds admin order intake URLs without forcing default status filters", () => {
    expect(buildAdminOrderIntakeUrl({
      search: " EXT-1 ",
      status: "default",
    })).toBe("/api/dropship/admin/order-intake?search=EXT-1&page=1&limit=50");
    expect(buildAdminOrderIntakeUrl({
      search: "",
      status: "failed",
      page: 2,
      limit: 25,
    })).toBe("/api/dropship/admin/order-intake?statuses=failed&page=2&limit=25");
    expect(buildAdminOrderIntakeUrl({
      search: "",
      status: "all",
    })).toBe("/api/dropship/admin/order-intake?statuses=received%2Cprocessing%2Caccepted%2Crejected%2Cretrying%2Cfailed%2Cpayment_hold%2Ccancelled%2Cexception&page=1&limit=50");
  });

  it("builds admin order ops action bodies with required reason guardrails", () => {
    expect(buildAdminOrderOpsActionInput({
      idempotencyKey: "retry-intake-1",
      reason: " repaired config ",
      requireReason: false,
    })).toEqual({
      idempotencyKey: "retry-intake-1",
      reason: "repaired config",
    });
    expect(buildAdminOrderOpsActionInput({
      idempotencyKey: "retry-intake-2",
      reason: " ",
      requireReason: false,
    })).toEqual({
      idempotencyKey: "retry-intake-2",
    });
    expect(() => buildAdminOrderOpsActionInput({
      idempotencyKey: "short",
      reason: "valid",
      requireReason: false,
    })).toThrow();
    expect(() => buildAdminOrderOpsActionInput({
      idempotencyKey: "exception-intake-1",
      reason: " ",
      requireReason: true,
    })).toThrow();
  });

  it("builds catalog exposure rule inputs with exact scope targets", () => {
    expect(buildCatalogExposureRuleInput({
      scopeType: "variant",
      action: "exclude",
      productVariantId: "42",
      category: "ignored",
      priority: "200",
      notes: "  hold for review ",
    })).toEqual({
      scopeType: "variant",
      action: "exclude",
      productLineId: null,
      productId: null,
      productVariantId: 42,
      category: null,
      priority: 200,
      startsAt: null,
      endsAt: null,
      notes: "hold for review",
      metadata: {},
    });
    expect(buildCatalogExposureRuleInput({
      scopeType: "category",
      action: "include",
      category: " Supplies ",
    })).toEqual(expect.objectContaining({
      scopeType: "category",
      action: "include",
      category: "Supplies",
    }));
    expect(() => buildCatalogExposureRuleInput({
      scopeType: "product_line",
      action: "include",
      productLineId: "",
    })).toThrow();
  });

  it("dedupes catalog exposure rules by scope, action, and normalized target", () => {
    expect(catalogExposureRuleKey(buildCatalogExposureRuleInput({
      scopeType: "category",
      action: "include",
      category: " Supplies ",
    }))).toBe(catalogExposureRuleKey(buildCatalogExposureRuleInput({
      scopeType: "category",
      action: "include",
      category: "supplies",
    })));
  });

  it("preserves catalog exposure effective windows when loading records into draft rules", () => {
    expect(catalogExposureRecordToInput({
      id: 1,
      revisionId: 2,
      scopeType: "catalog",
      action: "include",
      productLineId: null,
      productId: null,
      productVariantId: null,
      category: null,
      priority: 0,
      startsAt: "2026-05-01T00:00:00.000Z",
      endsAt: "2026-06-01T00:00:00.000Z",
      isActive: true,
      notes: " launch ",
      metadata: { source: "test" },
    })).toEqual({
      scopeType: "catalog",
      action: "include",
      productLineId: null,
      productId: null,
      productVariantId: null,
      category: null,
      priority: 0,
      startsAt: "2026-05-01T00:00:00.000Z",
      endsAt: "2026-06-01T00:00:00.000Z",
      notes: "launch",
      metadata: { source: "test" },
    });
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

  it("parses dollar input to integer cents without floating point math", () => {
    expect(parseDollarInputToCents("$1,234.56", "amount")).toBe(123456);
    expect(parseDollarInputToCents("25", "amount")).toBe(2500);
    expect(parseDollarInputToCents("25.5", "amount")).toBe(2550);
    expect(() => parseDollarInputToCents("25.555", "amount")).toThrow();
    expect(() => parseDollarInputToCents("-1", "amount")).toThrow();
  });

  it("builds auto-reload config input with integer cents and guardrails", () => {
    expect(buildAutoReloadConfigInput({
      enabled: true,
      fundingMethodId: "99",
      minimumBalance: "$50.00",
      maxSingleReload: "250.00",
      paymentHoldTimeoutMinutes: "2880",
    })).toEqual({
      enabled: true,
      fundingMethodId: 99,
      minimumBalanceCents: 5000,
      maxSingleReloadCents: 25000,
      paymentHoldTimeoutMinutes: 2880,
    });
    expect(buildAutoReloadConfigInput({
      enabled: false,
      fundingMethodId: "",
      minimumBalance: "0",
      maxSingleReload: "",
      paymentHoldTimeoutMinutes: "2880",
    })).toEqual({
      enabled: false,
      fundingMethodId: null,
      minimumBalanceCents: 0,
      maxSingleReloadCents: null,
      paymentHoldTimeoutMinutes: 2880,
    });
    expect(() => buildAutoReloadConfigInput({
      enabled: true,
      fundingMethodId: "",
      minimumBalance: "50",
      maxSingleReload: "250",
      paymentHoldTimeoutMinutes: "2880",
    })).toThrow();
    expect(() => buildAutoReloadConfigInput({
      enabled: true,
      fundingMethodId: "99",
      minimumBalance: "250",
      maxSingleReload: "50",
      paymentHoldTimeoutMinutes: "2880",
    })).toThrow();
  });

  it("builds Stripe funding setup session input with relative return path guardrails", () => {
    expect(buildStripeFundingSetupSessionInput({
      rail: "stripe_card",
      returnTo: "/wallet",
    })).toEqual({
      rail: "stripe_card",
      returnTo: "/wallet",
    });
    expect(buildStripeFundingSetupSessionInput({
      rail: "stripe_ach",
      returnTo: "/dropship-portal/wallet?tab=funding",
    })).toEqual({
      rail: "stripe_ach",
      returnTo: "/dropship-portal/wallet?tab=funding",
    });
    expect(() => buildStripeFundingSetupSessionInput({
      rail: "manual",
      returnTo: "/wallet",
    })).toThrow();
    expect(() => buildStripeFundingSetupSessionInput({
      rail: "stripe_card",
      returnTo: "https://attacker.example/wallet",
    })).toThrow();
  });

  it("builds Stripe wallet funding session input with integer cents", () => {
    expect(buildStripeWalletFundingSessionInput({
      fundingMethodId: "99",
      amount: "$250.00",
      returnTo: "/wallet",
    })).toEqual({
      fundingMethodId: 99,
      amountCents: 25000,
      returnTo: "/wallet",
    });
    expect(() => buildStripeWalletFundingSessionInput({
      fundingMethodId: "",
      amount: "250",
      returnTo: "/wallet",
    })).toThrow();
    expect(() => buildStripeWalletFundingSessionInput({
      fundingMethodId: "99",
      amount: "250.555",
      returnTo: "/wallet",
    })).toThrow();
    expect(() => buildStripeWalletFundingSessionInput({
      fundingMethodId: "99",
      amount: "250",
      returnTo: "https://attacker.example/wallet",
    })).toThrow();
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
