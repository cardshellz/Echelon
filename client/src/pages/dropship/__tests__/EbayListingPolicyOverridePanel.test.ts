import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ebayListingPolicyQueryKey } from "@/lib/dropship-ebay-listing-query-sync";
import type { DropshipCatalogRow, DropshipEbayListingPolicyOverrideResponse } from "@/lib/dropship-ops-surface";
import { EbayListingPolicyOverridePanel } from "../EbayListingPolicyOverridePanel";

afterEach(() => vi.unstubAllGlobals());

describe("compact listing policy panel rendering", () => {
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
    const rows = Array.from({ length: 10000 }, (_, index) => ({
      productVariantId: index + 1,
      productName: `Product ${index + 1}`,
      variantName: "Pack of 50",
      variantSku: `SKU-${index + 1}`,
    } as DropshipCatalogRow));
    try {
      const markup = renderToStaticMarkup(React.createElement(QueryClientProvider, { client },
        React.createElement(EbayListingPolicyOverridePanel, { storeConnectionId: 1, rows, onConfigurationChange: () => {} })));
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
