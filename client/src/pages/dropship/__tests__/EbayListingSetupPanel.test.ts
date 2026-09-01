import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DropshipEbayListingSetupResponse } from "@/lib/dropship-ops-surface";
import { buildEbayListingSetupDraft } from "../EbayListingSetupPanel";

describe("EbayListingSetupPanel", () => {
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
        ebayServiceCode: "USPSGround",
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
