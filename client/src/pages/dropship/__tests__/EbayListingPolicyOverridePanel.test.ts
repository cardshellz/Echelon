import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ebayListingPolicyQueryKey, ebayListingSetupQueryKey } from "@/lib/dropship-ebay-listing-query-sync";
import type { DropshipCatalogRow, DropshipEbayListingPolicyOverrideResponse } from "@/lib/dropship-ops-surface";
import { DropshipApiError } from "@/lib/dropship-ops-surface";
import { EbayListingPolicyOverridePanel } from "../EbayListingPolicyOverridePanel";

vi.mock("../EbayStoreCategoryAuthorizationRecovery", () => ({
  EbayStoreCategoryAuthorizationRecovery: ({ storeName }: { storeName: string }) => React.createElement("button", null, `Authorize ${storeName}`),
}));

afterEach(() => vi.unstubAllGlobals());

describe("compact listing policy panel rendering", () => {
  it.each([
    { code: "DROPSHIP_EBAY_LISTING_SETUP_PERMISSION_REQUIRED", consent: true },
    { code: "DROPSHIP_EBAY_LISTING_SETUP_ACCESS_DENIED", consent: false },
  ])("shows deliberate consent only for a revoked grant while policies are cached: $code", async ({ code, consent }) => {
    vi.stubGlobal("React", React);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    try {
      client.setQueryData(ebayListingPolicyQueryKey(1), {
        storeConnectionId: 1, defaults: { fulfillmentPolicyId: null, returnPolicyId: null, paymentPolicyId: null },
        options: { fulfillmentPolicies: [], returnPolicies: [], paymentPolicies: [] }, assignments: [],
        fetchedAt: "2026-09-05T12:00:00Z",
      });
      await expect(client.fetchQuery({
        queryKey: ebayListingPolicyQueryKey(1),
        queryFn: async () => { throw new DropshipApiError({ status: 403, code, message: "Access failed" }); },
      })).rejects.toThrow("Access failed");
      const markup = renderToStaticMarkup(React.createElement(QueryClientProvider, { client },
        React.createElement(EbayListingPolicyOverridePanel, { storeConnectionId: 1, storeName: "Target store", rows: [], onConfigurationChange: () => {} })));
      expect(markup.includes("Authorize Target store")).toBe(consent);
      expect(markup).toContain("The values below are from the last successful load");
      if (!consent) expect(markup).toContain("Do not keep reauthorizing");
    } finally {
      client.clear();
    }
  });

  it("mounts only one page of summaries and no per-row policy dropdowns for 10,000 listings", () => {
    vi.stubGlobal("React", React);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const data: DropshipEbayListingPolicyOverrideResponse = {
      storeConnectionId: 1,
      defaults: { fulfillmentPolicyId: "ground", returnPolicyId: "returns", paymentPolicyId: "payments" },
      options: {
        fulfillmentPolicies: [{ id: "ground", name: "Ground Advantage", compatible: true, compatibilityIssues: [] }],
        returnPolicies: [{ id: "returns", name: "30 day returns" }],
        paymentPolicies: [{ id: "payments", name: "Managed payments" }],
      },
      assignments: [],
      fetchedAt: "2026-09-05T12:00:00.000Z",
    };
    client.setQueryData(ebayListingPolicyQueryKey(1), data);
    client.setQueryData(ebayListingSetupQueryKey(1), { storeConnectionId: 1, options: data.options });
    const rows = Array.from({ length: 10000 }, (_, index) => ({
      productVariantId: index + 1,
      productName: `Product ${index + 1}`,
      variantName: "Pack of 50",
      variantSku: `SKU-${index + 1}`,
    } as DropshipCatalogRow));
    try {
      const markup = renderToStaticMarkup(React.createElement(QueryClientProvider, { client },
        React.createElement(EbayListingPolicyOverridePanel, { storeConnectionId: 1, storeName: "Test store", rows, onConfigurationChange: () => {} })));
      expect(markup.match(/aria-label="Edit policies for SKU-/g)).toHaveLength(50);
      expect(markup).toContain("Page 1 of 200");
      expect(markup).toContain("1–50 of 10000 matching");
      expect(markup).toContain("Check listings on this page");
      expect(markup).toContain("Refresh policies");
      expect(markup).toContain("Ground Advantage");
      expect(markup).toContain("Store default");
      expect(markup).not.toContain("Edit policies for SKU-51");
      expect(markup).not.toContain("listing override");
      // Only the shared policy filter is a combobox; editing controls are lazy.
      expect(markup.match(/role="combobox"/g)).toHaveLength(1);
    } finally {
      client.clear();
    }
  });
});

describe("saved policy view during a live eBay outage", () => {
  it("keeps saved IDs visible, blocks editing, and never calls them missing or requests reauth for a 503", async () => {
    vi.stubGlobal("React", React);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0, retryOnMount: false } } });
    try {
      client.setQueryData(ebayListingPolicyQueryKey(1), { storeConnectionId: 1, verification: "not_checked",
        defaults: { fulfillmentPolicyId: "saved-ground", returnPolicyId: "saved-return", paymentPolicyId: "saved-payment" },
        assignments: [], fetchedAt: "2026-09-08T12:00:00Z" });
      await expect(client.fetchQuery({ queryKey: ebayListingSetupQueryKey(1), queryFn: async () => {
        throw new DropshipApiError({ status: 502, code: "DROPSHIP_EBAY_LISTING_SETUP_UNAVAILABLE", message: "Provider unavailable.",
          context: { resource: "fulfillmentPolicies", status: 503, diagnosticReference: "test-reference", retryable: true } });
      } })).rejects.toThrow();
      const markup = renderToStaticMarkup(React.createElement(QueryClientProvider, { client },
        React.createElement(EbayListingPolicyOverridePanel, { storeConnectionId: 1, storeName: "Store", rows: [{
          productVariantId: 1, productName: "Armalope", variantName: "Pack of 50", variantSku: "ARM-50",
        } as DropshipCatalogRow], onConfigurationChange: () => {} })));
      expect(markup.includes("Saved policy (saved-ground)")).toBe(true);
      expect(markup.includes("Saved policies are shown below")).toBe(true);
      expect(markup.includes("test-reference")).toBe(true);
      expect(markup.includes('aria-label="Edit policies for ARM-50" disabled=""')).toBe(true);
      expect(markup.includes("Unavailable policy (")).toBe(false);
      expect(markup.includes("Authorize Store")).toBe(false);
    } finally { client.clear(); }
  });
});
