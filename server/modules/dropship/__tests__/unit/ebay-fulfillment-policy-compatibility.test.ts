import { describe, expect, it } from "vitest";
import {
  evaluateDropshipEbayFulfillmentPolicyCompatibility,
  type DropshipEbayFulfillmentCapability,
  type DropshipEbayFulfillmentPolicy,
} from "../../domain/ebay-fulfillment-policy-compatibility";

describe("evaluateDropshipEbayFulfillmentPolicyCompatibility", () => {
  it("accepts a domestic policy whose operational promises fit current capabilities", () => {
    const result = evaluateDropshipEbayFulfillmentPolicyCompatibility({
      capability: capability(),
      policy: policy(),
    });

    expect(result).toEqual({ compatible: true, issues: [] });
  });

  it("does not evaluate vendor-owned shipping charges", () => {
    const input = policy();
    (input.shippingOptions[0] as unknown as Record<string, unknown>).shippingCost = {
      currency: "USD",
      value: "99.99",
    };

    expect(evaluateDropshipEbayFulfillmentPolicyCompatibility({
      capability: capability(),
      policy: input,
    }).compatible).toBe(true);
  });

  it("rejects handling time shorter than the OMS fulfillment SLA", () => {
    const input = policy();
    input.handlingTime = { value: 0, unit: "DAY" };

    expect(issueCodes(input)).toContain("handling_time_too_short");
  });

  it("fails closed when eBay omits the policy marketplace", () => {
    const input = policy();
    input.marketplaceId = null;

    expect(issueCodes(input)).toContain("marketplace_missing");
  });

  it("rejects every domestic service not backed by a connected carrier mapping", () => {
    const input = policy();
    input.shippingOptions[0].shippingServiceCodes.push("VendorOnlyCourier");

    expect(issueCodes(input)).toContain(
      "shipping_service_unsupported:VendorOnlyCourier",
    );
  });

  it("rejects direct international, local-pickup, freight, and pickup/drop-off promises", () => {
    const input = policy();
    input.localPickup = true;
    input.freightShipping = true;
    input.pickupDropOff = true;
    input.shippingOptions.push({
      optionType: "INTERNATIONAL",
      shippingServiceCodes: ["FedExInternationalEconomy"],
    });

    expect(issueCodes(input)).toEqual(expect.arrayContaining([
      "international_direct_shipping_unsupported",
      "local_pickup_unsupported",
      "freight_shipping_unsupported",
      "pickup_drop_off_unsupported",
    ]));
  });

  it("fails closed on an international option even when eBay omits its services", () => {
    const input = policy();
    input.shippingOptions.push({
      optionType: "INTERNATIONAL",
      shippingServiceCodes: [],
    });

    expect(issueCodes(input)).toContain("international_direct_shipping_unsupported");
  });

  it("fails closed when Card Shellz destination coverage is incomplete", () => {
    const inputCapability = capability();
    inputCapability.destinationCoverageComplete = false;

    expect(evaluateDropshipEbayFulfillmentPolicyCompatibility({
      capability: inputCapability,
      policy: policy(),
    })).toMatchObject({
      compatible: false,
      issues: [{ code: "destination_coverage_incomplete" }],
    });
  });

  function issueCodes(input: DropshipEbayFulfillmentPolicy): string[] {
    return evaluateDropshipEbayFulfillmentPolicyCompatibility({
      capability: capability(),
      policy: input,
    }).issues.map((issue) => issue.code);
  }
});

function capability(): DropshipEbayFulfillmentCapability {
  return {
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
      serviceLevelId: 7,
      fulfillmentRoutingRevision: 4,
    },
  };
}

function policy(): DropshipEbayFulfillmentPolicy {
  return {
    id: "policy-1",
    name: "Standard domestic",
    marketplaceId: "EBAY_US",
    handlingTime: { value: 1, unit: "DAY" },
    shippingOptions: [{
      optionType: "DOMESTIC",
      shippingServiceCodes: ["USPSGround"],
    }],
    localPickup: false,
    freightShipping: false,
    pickupDropOff: false,
  };
}
