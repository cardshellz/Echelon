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
          { id: "fulfillment-standard", name: "Standard" },
          { id: "fulfillment-fast", name: "Fast" },
        ],
        returnPolicies: [{ id: "return-30", name: "Thirty days" }],
        paymentPolicies: [{ id: "payment-managed", name: "Managed payments" }],
      },
    }));

    expect(draft).toEqual({
      merchantLocationKey: "warehouse-main",
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
          { id: "fulfillment-standard", name: "Standard" },
          { id: "fulfillment-fast", name: "Fast" },
        ],
        returnPolicies: [{ id: "return-30", name: "Thirty days" }],
        paymentPolicies: [{ id: "payment-managed", name: "Managed payments" }],
      },
    }));

    expect(draft.merchantLocationKey).toBe("warehouse-west");
    expect(draft.fulfillmentPolicyId).toBe("fulfillment-fast");
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
    expect(source).toContain("Echelon fills in any unambiguous value automatically");
    expect(source).toContain("Search inventory locations");
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
