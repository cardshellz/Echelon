import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import type { DropshipEbayListingSetupResponse } from "@/lib/dropship-ops-surface";
import { DropshipApiError } from "@/lib/dropship-ops-surface";
import { ebayListingSetupQueryKey } from "@/lib/dropship-ebay-listing-query-sync";
import {
  buildEbayListingSetupDraft,
  EbayListingSetupPanel,
  ListingSetupError,
  listingSetupHasUnsavedPolicy,
  suggestedListingSetupFields,
} from "../EbayListingSetupPanel";

vi.mock("../EbayStoreCategoryAuthorizationRecovery", () => ({
  EbayStoreCategoryAuthorizationRecovery: () => React.createElement("button", null, "Start customer consent"),
}));

describe("EbayListingSetupPanel", () => {
  it.each([
    { code: "DROPSHIP_EBAY_LISTING_SETUP_ACCESS_DENIED", title: "eBay listing access needs support.", consent: false },
    { code: "DROPSHIP_EBAY_LISTING_SETUP_PERMISSION_REQUIRED", title: "eBay listing authorization needs attention.", consent: true },
    { code: "DROPSHIP_EBAY_TOKEN_REFRESH_FAILED", title: "eBay listing setup is unavailable.", consent: false },
  ])("shows the correct recovery action for $code", ({ code, title, consent }) => {
    vi.stubGlobal("React", React);
    try {
      const markup = renderToStaticMarkup(React.createElement(ListingSetupError, {
        error: new DropshipApiError({ status: 403, code, message: "Temporary access failure" }),
        storeConnectionId: 44, storeName: "Test store",
      }));
      expect(markup).toContain(title);
      expect(markup.includes("Start customer consent")).toBe(consent);
      expect(markup).not.toContain("Echelon");
      if (code.endsWith("ACCESS_DENIED")) expect(markup).toContain("Do not keep reauthorizing");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([
    { code: "DROPSHIP_EBAY_TOKEN_REFRESH_FAILED", title: "Temporary setup outage", consent: false },
    { code: "DROPSHIP_EBAY_LISTING_SETUP_PERMISSION_REQUIRED", title: "eBay listing authorization needs attention.", consent: true },
    { code: "DROPSHIP_EBAY_LISTING_SETUP_ACCESS_DENIED", title: "eBay listing access needs support.", consent: false },
  ])("keeps cached setup and the correct recovery action for $code", async ({ code, title, consent }) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.stubGlobal("React", React);
    try {
      client.setQueryData(ebayListingSetupQueryKey(44), setup({ complete: true }));
      await expect(client.fetchQuery({
        queryKey: ebayListingSetupQueryKey(44),
        queryFn: async () => { throw new DropshipApiError({ status: 403, code, message: "Temporary setup outage" }); },
      })).rejects.toThrow("Temporary setup outage");
      const markup = renderToStaticMarkup(React.createElement(QueryClientProvider, { client },
        React.createElement(EbayListingSetupPanel, {
          storeConnectionId: 44, storeName: "Test store", onConfigurationChange: () => undefined,
        }),
      ));
      expect(markup).toContain(title);
      expect(markup.includes("Start customer consent")).toBe(consent);
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

  it("marks a policy Card Shellz filled in as a suggestion until the vendor saves or changes it", () => {
    const response = setup({
      selection: { merchantLocationKey: null, fulfillmentPolicyId: null, returnPolicyId: "return-30", paymentPolicyId: null },
      options: {
        merchantLocations: [{ id: "warehouse-main", name: "Main warehouse" }],
        fulfillmentPolicies: [policyOption("fulfillment-standard", "Standard"), policyOption("fulfillment-fast", "Fast")],
        returnPolicies: [{ id: "return-30", name: "Thirty days" }],
        paymentPolicies: [{ id: "payment-managed", name: "Managed payments" }],
      },
    });
    const draft = buildEbayListingSetupDraft(response);
    // Payment was filled in (one choice, none saved); return is the saved choice; fulfillment is open.
    expect([...suggestedListingSetupFields(response, draft)]).toEqual(["paymentPolicyId"]);
    // Once the vendor picks something else, it is their change, not a suggestion.
    expect([...suggestedListingSetupFields(response, { ...draft, paymentPolicyId: "" })]).toEqual([]);
  });

  it("counts a policy as unsaved only when the draft holds one that is not saved", () => {
    const twoOfEach = {
      merchantLocations: [{ id: "warehouse-main", name: "Main warehouse" }],
      fulfillmentPolicies: [policyOption("fulfillment-standard", "Standard"), policyOption("fulfillment-fast", "Fast")],
      returnPolicies: [{ id: "return-30", name: "Thirty days" }, { id: "return-60", name: "Sixty days" }],
      paymentPolicies: [{ id: "payment-managed", name: "Managed payments" }, { id: "payment-other", name: "Other" }],
    };
    const nothingSaved = setup({
      selection: { merchantLocationKey: null, fulfillmentPolicyId: null, returnPolicyId: null, paymentPolicyId: null },
      options: twoOfEach,
    });
    // Nothing saved and several choices: the fields open empty, which is nothing to lose.
    expect(listingSetupHasUnsavedPolicy(nothingSaved, buildEbayListingSetupDraft(nothingSaved))).toBe(false);
    // Nothing saved and no choices at all: the same.
    const noChoices = setup({
      selection: nothingSaved.selection,
      options: { merchantLocations: [], fulfillmentPolicies: [], returnPolicies: [], paymentPolicies: [] },
    });
    expect(listingSetupHasUnsavedPolicy(noChoices, buildEbayListingSetupDraft(noChoices))).toBe(false);
    // A saved policy eBay no longer offers opens empty; the vendor has changed nothing.
    const withdrawn = setup({
      selection: { merchantLocationKey: null, fulfillmentPolicyId: "fulfillment-gone", returnPolicyId: "return-30", paymentPolicyId: "payment-managed" },
      options: twoOfEach,
    });
    expect(buildEbayListingSetupDraft(withdrawn).fulfillmentPolicyId).toBe("");
    expect(listingSetupHasUnsavedPolicy(withdrawn, buildEbayListingSetupDraft(withdrawn))).toBe(false);
    // Picking a policy that is not saved is unsaved; picking the saved one again is not.
    expect(listingSetupHasUnsavedPolicy(withdrawn, { ...buildEbayListingSetupDraft(withdrawn), fulfillmentPolicyId: "fulfillment-fast" })).toBe(true);
    expect(listingSetupHasUnsavedPolicy(withdrawn, { ...buildEbayListingSetupDraft(withdrawn), returnPolicyId: "return-60" })).toBe(true);
    expect(listingSetupHasUnsavedPolicy(withdrawn, { ...buildEbayListingSetupDraft(withdrawn), returnPolicyId: "return-30" })).toBe(false);
    // A policy Card Shellz filled in (one choice, none saved) is unsaved until saved.
    const oneChoice = setup({
      selection: nothingSaved.selection,
      options: { ...twoOfEach, paymentPolicies: [{ id: "payment-managed", name: "Managed payments" }] },
    });
    expect(listingSetupHasUnsavedPolicy(oneChoice, buildEbayListingSetupDraft(oneChoice))).toBe(true);
    // Once saved, the same draft is not.
    const saved = setup({ selection: { ...nothingSaved.selection, paymentPolicyId: "payment-managed" }, options: oneChoice.options });
    expect(listingSetupHasUnsavedPolicy(saved, buildEbayListingSetupDraft(oneChoice))).toBe(false);
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
