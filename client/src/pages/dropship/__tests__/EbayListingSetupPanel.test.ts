import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import type { DropshipEbayListingSetupResponse } from "@/lib/dropship-ops-surface";
import { ebayListingSetupQueryKey } from "@/lib/dropship-ebay-listing-query-sync";
import { buildEbayListingSetupDraft, EbayListingSetupPanel } from "../EbayListingSetupPanel";

describe("EbayListingSetupPanel", () => {
  it("keeps cached setup and a visible retry action when a later read fails", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.stubGlobal("React", React);
    try {
      client.setQueryData(ebayListingSetupQueryKey(44), setup({ complete: true }));
      await expect(client.fetchQuery({
        queryKey: ebayListingSetupQueryKey(44),
        queryFn: async () => { throw new Error("Temporary setup outage"); },
      })).rejects.toThrow("Temporary setup outage");
      const markup = renderToStaticMarkup(React.createElement(QueryClientProvider, { client },
        React.createElement(EbayListingSetupPanel, {
          storeConnectionId: 44, storeName: "Test store", onConfigurationChange: () => undefined,
        }),
      ));
      expect(markup).toContain("Temporary setup outage");
      expect(markup).toContain("Showing the last loaded setup");
      expect(markup).toContain("Refresh options");
      expect(markup).toContain("Card Shellz fulfillment capabilities");
    } finally {
      client.clear();
      vi.unstubAllGlobals();
    }
  });

  it("prefills only unambiguous missing selections", () => {
    const draft = buildEbayListingSetupDraft(setup({
      selection: {
        merchantLocationKey: null,
        fulfillmentPolicyId: null,
        returnPolicyId: null,
        paymentPolicyId: null,
      },
      options: {
        merchantLocations: [{ id: "warehouse-main", name: "Main warehouse" }],
        fulfillmentPolicies: [
          policyOption("fulfillment-standard", "Standard"),
          policyOption("fulfillment-fast", "Fast"),
        ],
        returnPolicies: [{ id: "return-30", name: "Thirty days" }],
        paymentPolicies: [{ id: "payment-managed", name: "Managed payments" }],
      },
    }));

    expect(draft).toEqual({
      fulfillmentPolicyId: "",
      returnPolicyId: "return-30",
      paymentPolicyId: "payment-managed",
    });
  });

  it("preserves a valid existing choice when multiple choices are available", () => {
    const draft = buildEbayListingSetupDraft(setup({
      selection: {
        merchantLocationKey: "warehouse-west",
        fulfillmentPolicyId: "fulfillment-fast",
        returnPolicyId: "return-30",
        paymentPolicyId: "payment-managed",
      },
      options: {
        merchantLocations: [
          { id: "warehouse-east", name: "East" },
          { id: "warehouse-west", name: "West" },
        ],
        fulfillmentPolicies: [
          policyOption("fulfillment-standard", "Standard"),
          policyOption("fulfillment-fast", "Fast"),
        ],
        returnPolicies: [{ id: "return-30", name: "Thirty days" }],
        paymentPolicies: [{ id: "payment-managed", name: "Managed payments" }],
      },
    }));

    expect(draft.fulfillmentPolicyId).toBe("fulfillment-fast");
  });

  it("does not prefill an incompatible fulfillment policy", () => {
    const draft = buildEbayListingSetupDraft(setup({
      options: {
        merchantLocations: [{ id: "warehouse-main", name: "Main warehouse" }],
        fulfillmentPolicies: [{
          ...policyOption("fulfillment-fast", "Fast"),
          compatible: false,
          compatibilityIssues: [{
            code: "handling_time_too_short",
            message: "Handling time is too short.",
          }],
        }],
        returnPolicies: [{ id: "return-30", name: "Thirty days" }],
        paymentPolicies: [{ id: "payment-managed", name: "Managed payments" }],
      },
    }));

    expect(draft.fulfillmentPolicyId).toBe("");
  });

  it("keeps setup and authorization recovery inline on Catalog", () => {
    const source = readFileSync(
      join(process.cwd(), "client", "src", "pages", "dropship", "EbayListingSetupPanel.tsx"),
      "utf8",
    );
    const catalogSource = readFileSync(
      join(process.cwd(), "client", "src", "pages", "dropship", "DropshipPortalCatalog.tsx"),
      "utf8",
    );

    expect(source).toContain("eBay listing setup");
    expect(source).toContain("Card Shellz fulfillment capabilities");
    expect(source).toContain('label="Allowed carriers"');
    expect(source).not.toContain('label="Connected carriers"');
    expect(source).toContain("Card Shellz controls the physical inventory location");
    expect(source).toContain("managedLocationNeedsReconciliation");
    expect(source).toContain("Save setup to reconcile it automatically");
    expect(source).not.toContain('label="Inventory location"');
    expect(source).toContain("max-h-64 overflow-y-auto");
    expect(source).toContain("/api/dropship/ebay/listing-setup/");
    expect(source).toContain("<EbayStoreCategoryAuthorizationRecovery");
    expect(catalogSource).toContain("<EbayListingSetupPanel");
  });
});

function setup(
  overrides: Partial<DropshipEbayListingSetupResponse>,
): DropshipEbayListingSetupResponse {
  return {
    storeConnectionId: 44,
    marketplaceId: "EBAY_US",
    complete: false,
    missingFields: [],
    fulfillmentCapability: {
      marketplaceId: "EBAY_US",
      requiredHandlingTimeBusinessDays: 1,
      destinationCountry: "US",
      destinationRegions: ["CA", "NY"],
      destinationCoverageComplete: true,
      supportedServices: [{
        carrier: "USPS",
        ebayServiceCode: "USPSParcel",
        serviceName: "USPS Ground Advantage",
        shipStationCarrierCode: "usps",
        shipStationServiceCode: "usps_ground_advantage",
      }],
      evidenceHash: "capability-hash",
      source: {
        omsChannelId: 103,
        originWarehouseId: 1,
        rateBookId: 34,
        rateBookCode: "dropship-vendor-default",
        rateTableId: 5,
        serviceLevelId: 7,
        fulfillmentRoutingRevision: 4,
      },
    },
    selection: {
      merchantLocationKey: null,
      fulfillmentPolicyId: null,
      returnPolicyId: null,
      paymentPolicyId: null,
    },
    options: {
      merchantLocations: [],
      fulfillmentPolicies: [],
      returnPolicies: [],
      paymentPolicies: [],
    },
    ...overrides,
  };
}

function policyOption(id: string, name: string) {
  return {
    id,
    name,
    compatible: true,
    compatibilityIssues: [],
  };
}
