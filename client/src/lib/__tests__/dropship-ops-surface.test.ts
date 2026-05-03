import { describe, expect, it } from "vitest";
import {
  buildQueryUrl,
  buildStoreConnectionOAuthStartInput,
  formatCents,
  formatStatus,
  normalizePortalReturnPath,
  normalizeShopifyShopDomainInput,
  riskSeverityTone,
  sectionStatusTone,
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
});
